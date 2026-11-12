import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { LLAMA_HOST } from '../../shared/constants'
import type { LlamaErrorCode, ServerRole, ServerStatus } from '../../shared/ipc/contract'
import type { Logger } from '../log/log'
import { buildArgs } from './launch'
import type { LaunchResolution } from './launch'
import { deletePidFile, pidFilePath, writePidFile } from './pidfile'
import { pickPort } from './port'
import { decideRestart } from './restart-policy'
import { RotatingLog } from './rotating-log'
import { getProcessInfo, killTree } from './win-process'
import type { ProcessInfo } from './win-process'

const HEALTH_POLL_MS = 500
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
const STOP_EXIT_TIMEOUT_MS = 5_000

/** Everything with side effects, injectable so the lifecycle can be tested with fakes. */
export interface ServerDeps {
  spawnProcess(exePath: string, args: string[], cwd: string): ChildProcess
  getProcessInfo(pid: number): Promise<ProcessInfo | null>
  killTree(pid: number): Promise<void>
  /** HTTP status of GET /health, or null when the server is not reachable yet. */
  checkHealth(port: number): Promise<number | null>
  pickPort(preferred: number): Promise<number>
  now(): number
  sleep(ms: number): Promise<void>
}

export const defaultServerDeps: ServerDeps = {
  // No shell and no string-built command line. Hidden window on Windows.
  spawnProcess: (exePath, args, cwd) =>
    spawn(exePath, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
  getProcessInfo,
  killTree,
  async checkHealth(port) {
    try {
      const response = await fetch(`http://${LLAMA_HOST}:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      })
      return response.status
    } catch {
      return null
    }
  },
  pickPort,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface LlamaServerOptions {
  role: ServerRole
  /** Folder for `llama-<role>.pid.json`. */
  runDir: string
  /** Folder for `llama-<role>.log`. */
  logsDir: string
  /** Resolves the launch spec from the current config each time the server starts. */
  resolveLaunch: () => LaunchResolution
  onStatus: (status: ServerStatus) => void
  logger: Logger
  deps?: Partial<ServerDeps>
}

/**
 * One llama-server child process: spawn, log capture, pid file, readiness
 * polling, crash restart with backoff and a clean stop. States:
 * stopped -> starting -> ready, starting|ready -> error, any -> stopping -> stopped.
 */
export class LlamaServer {
  private readonly role: ServerRole
  private readonly deps: ServerDeps
  private readonly logger: Logger
  private status: ServerStatus
  private child: ChildProcess | null = null
  private exited: Promise<void> = Promise.resolve()
  private pidFileReady: Promise<void> = Promise.resolve()
  /** Children the app is stopping on purpose; their exit is not a crash. */
  private readonly intentional = new WeakSet<ChildProcess>()
  private crashes: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  /** Bumped by `stop()` so an in-flight `start()` notices it was cancelled. */
  private generation = 0

  constructor(private readonly options: LlamaServerOptions) {
    this.role = options.role
    this.logger = options.logger
    this.deps = { ...defaultServerDeps, ...options.deps }
    this.status = { role: this.role, state: 'stopped', port: null, pid: null, errorCode: null, message: null }
  }

  getStatus(): ServerStatus {
    return this.status
  }

  /**
   * Starts the server and resolves once it is ready or has failed. Never
   * rejects; failures are reported through the status. Does nothing while the
   * server is already starting, ready or stopping.
   */
  async start(options: { resetCrashes?: boolean } = {}): Promise<void> {
    const { state } = this.status
    if (state === 'starting' || state === 'ready' || state === 'stopping') return
    this.clearRestartTimer()
    if (options.resetCrashes) this.crashes = []

    const generation = ++this.generation
    this.setStatus({ state: 'starting', port: null, pid: null, errorCode: null, message: null })

    const resolution = this.options.resolveLaunch()
    if (!resolution.ok) {
      this.fail(resolution.code, resolution.message)
      return
    }
    const spec = resolution.spec

    let port: number
    try {
      port = await this.deps.pickPort(spec.cfg.port)
    } catch (error) {
      this.fail('SPAWN_FAILED', `No usable port: ${(error as Error).message}`)
      return
    }
    if (generation !== this.generation) return
    if (port !== spec.cfg.port) this.logger.warn(`${this.role}: port ${spec.cfg.port} is busy, using ${port}`)

    let args: string[]
    try {
      args = buildArgs(spec, port)
    } catch (error) {
      this.fail('INVALID_CONFIG', (error as Error).message)
      return
    }

    const log = new RotatingLog(join(this.options.logsDir, `llama-${this.role}.log`))
    log.write(`\n=== ${new Date(this.deps.now()).toISOString()} starting ${spec.exePath}\n=== args: ${args.join(' ')}\n`)

    const child = this.deps.spawnProcess(spec.exePath, args, spec.cwd)
    this.child = child
    this.exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stdout?.on('data', (chunk: Buffer) => log.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => log.write(chunk))
    child.once('error', (error) => {
      if (this.child !== child) return
      this.child = null
      log.write(`=== spawn error: ${error.message}\n`)
      this.fail('SPAWN_FAILED', `Cannot start ${spec.exePath}: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      log.write(`\n=== exited (code ${String(code)}, signal ${String(signal)})\n`)
      this.onExit(child, code, signal)
    })

    const pid = child.pid
    if (pid === undefined) return // the 'error' event reports the failure
    this.setStatus({ pid, port })
    this.pidFileReady = this.recordPidFile(child, pid, spec.exePath, port)

    await this.waitUntilReady(child, generation, port, spec.startupTimeoutMs)
  }

  /** Stops the server (taskkill /T /F on the recorded PID) and waits for it to exit. */
  async stop(): Promise<void> {
    this.generation++
    this.clearRestartTimer()
    const child = this.child
    if (child === null) {
      await this.pidFileReady
      await deletePidFile(pidFilePath(this.options.runDir, this.role))
      if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped', port: null, pid: null, errorCode: null, message: null })
      return
    }

    this.setStatus({ state: 'stopping', errorCode: null, message: null })
    await this.terminate(child)
    await this.pidFileReady
    await deletePidFile(pidFilePath(this.options.runDir, this.role))
    this.setStatus({ state: 'stopped', port: null, pid: null, errorCode: null, message: null })
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start({ resetCrashes: true })
  }

  // -------------------------------------------------------------------------

  private async waitUntilReady(child: ChildProcess, generation: number, port: number, timeoutMs: number): Promise<void> {
    const deadline = this.deps.now() + timeoutMs
    for (;;) {
      if (generation !== this.generation || this.child !== child) return
      const health = await this.deps.checkHealth(port)
      if (generation !== this.generation || this.child !== child) return
      if (health === 200) {
        this.setStatus({ state: 'ready', errorCode: null, message: null })
        return
      }
      if (this.deps.now() >= deadline) {
        this.logger.error(`${this.role}: not ready after ${timeoutMs} ms, stopping it`)
        await this.terminate(child)
        if (generation === this.generation) {
          this.fail('STARTUP_TIMEOUT', `Server did not become ready within ${timeoutMs} ms`)
        }
        return
      }
      await this.deps.sleep(HEALTH_POLL_MS)
    }
  }

  /** Kills the process tree of `child` and waits for its exit. Never throws. */
  private async terminate(child: ChildProcess): Promise<void> {
    this.intentional.add(child)
    const pid = child.pid
    if (pid !== undefined) {
      try {
        await this.deps.killTree(pid)
      } catch (error) {
        this.logger.error(`${this.role}: kill failed: ${(error as Error).message}`)
      }
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), STOP_EXIT_TIMEOUT_MS)
      })
      const outcome = await Promise.race([this.exited.then(() => 'exit' as const), timedOut])
      clearTimeout(timer)
      if (outcome === 'timeout') await this.ensureGone(pid)
    }
    if (this.child === child) this.child = null
  }

  /** Last resort when `exit` did not fire in time: look the PID up and kill it again if it is alive. */
  private async ensureGone(pid: number): Promise<void> {
    try {
      const info = await this.deps.getProcessInfo(pid)
      if (info === null) return
      this.logger.warn(`${this.role}: PID ${pid} still alive after kill, retrying`)
      await this.deps.killTree(pid)
    } catch (error) {
      this.logger.error(`${this.role}: could not confirm PID ${pid} is gone: ${(error as Error).message}`)
    }
  }

  private async recordPidFile(child: ChildProcess, pid: number, spawnedExe: string, port: number): Promise<void> {
    try {
      const info = await this.deps.getProcessInfo(pid)
      if (info === null || this.child !== child) return
      await writePidFile(this.options.runDir, this.role, {
        pid,
        startTime: info.startTime,
        exePath: info.exePath ?? spawnedExe,
        port,
      })
    } catch (error) {
      this.logger.warn(`${this.role}: could not write pid file: ${(error as Error).message}`)
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    void this.pidFileReady
      .then(() => deletePidFile(pidFilePath(this.options.runDir, this.role)))
      .catch(() => {})
    if (this.intentional.has(child)) return

    const detail = `exited unexpectedly (code ${String(code)}, signal ${String(signal)})`
    const decision = decideRestart(this.crashes, this.deps.now())
    this.crashes = decision.crashes
    if (!decision.restart) {
      this.logger.error(`${this.role}: ${detail}; restart limit reached`)
      this.setStatus({
        state: 'error',
        pid: null,
        errorCode: 'CRASH_LOOP',
        message: `Server ${detail}; giving up after repeated crashes`,
      })
      return
    }
    this.logger.warn(`${this.role}: ${detail}; restarting in ${decision.delayMs} ms`)
    this.setStatus({
      state: 'error',
      pid: null,
      errorCode: 'EXITED',
      message: `Server ${detail}; restarting in ${Math.round(decision.delayMs / 1000)} s`,
    })
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start()
    }, decision.delayMs)
  }

  private fail(code: LlamaErrorCode, message: string): void {
    this.logger.error(`${this.role}: ${code}: ${message}`)
    this.setStatus({ state: 'error', pid: null, errorCode: code, message })
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private setStatus(patch: Partial<ServerStatus>): void {
    this.status = { ...this.status, ...patch }
    try {
      this.options.onStatus(this.status)
    } catch (error) {
      // A failing status listener (for example a closed window) must never break the lifecycle.
      this.logger.warn(`${this.role}: status listener failed: ${(error as Error).message}`)
    }
  }
}
