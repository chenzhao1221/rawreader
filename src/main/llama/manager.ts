import { join } from 'node:path'
import type { Config } from '../../shared/config/schema'
import type { ServerRole, ServerStatus } from '../../shared/ipc/contract'
import type { ModelPathEnv } from '../config/model-path'
import type { Logger } from '../log/log'
import { launchFingerprint, resolveLaunch } from './launch'
import { deletePidFile, listPidFiles, readPidFile, shouldKillOrphan } from './pidfile'
import { LlamaServer } from './server'
import type { ServerDeps } from './server'
import { getProcessInfo, killTree } from './win-process'
import type { ProcessInfo } from './win-process'

export const SERVER_ROLES: readonly ServerRole[] = ['ocr', 'translate']

/**
 * Whether a server should run on its own: autostart on, and needed by the translation engine
 * (an OpenAI-compatible API needs only OCR; Gemini needs neither).
 */
export function wantsServer(role: ServerRole, config: Config): boolean {
  if (!config.llama[role].autostart) return false
  const engine = config.translate.engine
  if (engine === 'gemini') return false
  return role === 'ocr' || engine === 'local'
}

export interface LlamaManagerOptions {
  getConfig: () => Config
  /** User data folder, resources folder and the file-exists check used to resolve binaries and models. */
  env: ModelPathEnv
  /** `userData/run`: pid files. */
  runDir: string
  /** `userData/logs`: llama-<role>.log. */
  logsDir: string
  onStatus: (status: ServerStatus) => void
  logger: Logger
  deps?: {
    server?: Partial<ServerDeps>
    getProcessInfo?: (pid: number) => Promise<ProcessInfo | null>
    killTree?: (pid: number) => Promise<void>
  }
}

export type ControlAction = 'start' | 'stop' | 'restart'

/** Owns both llama-server instances (OCR and translation). */
export class LlamaManager {
  private readonly servers: Record<ServerRole, LlamaServer>
  /** Roles the user stopped by hand; config changes do not start them again. */
  private readonly userStopped = new Set<ServerRole>()
  private readonly lookup: (pid: number) => Promise<ProcessInfo | null>
  private readonly kill: (pid: number) => Promise<void>

  constructor(private readonly options: LlamaManagerOptions) {
    this.lookup = options.deps?.getProcessInfo ?? getProcessInfo
    this.kill = options.deps?.killTree ?? killTree
    const make = (role: ServerRole): LlamaServer =>
      new LlamaServer({
        role,
        runDir: options.runDir,
        logsDir: options.logsDir,
        resolveLaunch: () => resolveLaunch(role, options.getConfig(), options.env),
        onStatus: options.onStatus,
        logger: options.logger,
        deps: options.deps?.server,
      })
    this.servers = { ocr: make('ocr'), translate: make('translate') }
  }

  getStatuses(): ServerStatus[] {
    return SERVER_ROLES.map((role) => this.servers[role].getStatus())
  }

  getStatus(role: ServerRole): ServerStatus {
    return this.servers[role].getStatus()
  }

  /**
   * Startup orphan check. For each recorded pid file, kill the process tree
   * only when a live process matches the PID, start time and executable path.
   * Otherwise just delete the stale file. Runs before any spawn.
   */
  async cleanOrphans(): Promise<void> {
    const { runDir, logger } = this.options
    for (const path of await listPidFiles(runDir)) {
      const file = await readPidFile(path)
      if (file === null) {
        logger.warn('Removing unreadable pid file')
        await deletePidFile(path)
        continue
      }
      let info: ProcessInfo | null
      try {
        info = await this.lookup(file.pid)
      } catch (error) {
        logger.warn(`Cannot inspect recorded PID ${file.pid}: ${(error as Error).message}; keeping pid file`)
        continue
      }
      if (shouldKillOrphan(file, info)) {
        logger.warn(`Killing orphaned llama-server tree (PID ${file.pid})`)
        try {
          await this.kill(file.pid)
        } catch (error) {
          logger.error(`Failed to kill orphan PID ${file.pid}: ${(error as Error).message}`)
          continue
        }
      } else if (info !== null) {
        logger.info(`PID ${file.pid} is alive but is not our server (start time or path differs); leaving it alone`)
      }
      await deletePidFile(path)
    }
  }

  /** Starts every server whose `autostart` is on. Missing files show up as `MODEL_MISSING` / `BINARY_MISSING`. */
  async startAll(): Promise<void> {
    const config = this.options.getConfig()
    await Promise.all(
      SERVER_ROLES.filter((role) => wantsServer(role, config)).map((role) => this.servers[role].start()),
    )
  }

  /**
   * Starts servers that are stopped or failed, except ones the user stopped by hand. Used when model files
   * arrive (download finished, file chosen) after the servers already reported MODEL_MISSING.
   */
  async startMissing(): Promise<void> {
    const config = this.options.getConfig()
    const wanted = SERVER_ROLES.filter((role) => {
      const state = this.servers[role].getStatus().state
      return wantsServer(role, config) && !this.userStopped.has(role) && (state === 'stopped' || state === 'error')
    })
    await Promise.all(wanted.map((role) => this.servers[role].start({ resetCrashes: true })))
  }

  /** Stops both servers in parallel. Awaited by the quit sequence. */
  async stopAll(): Promise<void> {
    await Promise.all(SERVER_ROLES.map((role) => this.servers[role].stop()))
  }

  /** Handler for `llama:control`. `start` and `restart` return as soon as the server is `starting`. */
  async control(role: ServerRole, action: ControlAction): Promise<ServerStatus> {
    const server = this.servers[role]
    switch (action) {
      case 'start':
        this.userStopped.delete(role)
        void server.start({ resetCrashes: true })
        break
      case 'stop':
        this.userStopped.add(role)
        await server.stop()
        break
      case 'restart':
        this.userStopped.delete(role)
        await server.stop()
        void server.start({ resetCrashes: true })
        break
    }
    return server.getStatus()
  }

  /** Restarts the servers whose launch-relevant config changed (backend, binaries, models, flags). */
  handleConfigChange(next: Config, previous: Config): void {
    for (const role of SERVER_ROLES) {
      if (this.userStopped.has(role)) continue
      const server = this.servers[role]
      const state = server.getStatus().state
      // The translation engine no longer needs this server (switched to an API): free its memory.
      if (!wantsServer(role, next) && wantsServer(role, previous)) {
        if (state !== 'stopped') {
          this.options.logger.info(`${role}: not needed by the "${next.translate.engine}" engine, stopping`)
          void server.stop()
        }
        continue
      }
      const needed = wantsServer(role, next) && !wantsServer(role, previous)
      if (!needed && launchFingerprint(role, next) === launchFingerprint(role, previous)) continue
      if (state !== 'stopped') {
        this.options.logger.info(`${role}: launch config changed, restarting`)
        void server.restart()
      } else if (wantsServer(role, next)) {
        void server.start({ resetCrashes: true })
      }
    }
  }
}

/** Standard folders under userData used by the manager. */
export function llamaPaths(userDataDir: string): { runDir: string; logsDir: string } {
  return { runDir: join(userDataDir, 'run'), logsDir: join(userDataDir, 'logs') }
}
