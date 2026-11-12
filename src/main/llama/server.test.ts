import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { ServerStatus } from '../../shared/ipc/contract'
import { silentLogger } from '../log/log'
import { resolveLaunch } from './launch'
import { pidFilePath } from './pidfile'
import { LlamaServer } from './server'
import type { ServerDeps } from './server'

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  constructor(public pid: number | undefined) {
    super()
  }
}

const exe = 'D:\\bin\\llama-server.exe'
const config = ConfigSchema.parse({
  llama: { binDirs: { vulkan: 'D:\\bin' } },
  models: { paths: { ocr: 'D:\\m\\ocr.gguf', ocrMmproj: 'D:\\m\\mm.gguf', translator: 'D:\\m\\tr.gguf' } },
})
const present = new Set([exe, 'D:\\m\\ocr.gguf', 'D:\\m\\mm.gguf', 'D:\\m\\tr.gguf'])
const env = { userDataDir: 'C:\\data', resourcesDir: 'C:\\res', exists: (p: string) => present.has(p) }

describe('LlamaServer lifecycle (fake process)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-server-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function setup(overrides: Partial<ServerDeps> = {}, role: 'ocr' | 'translate' = 'translate') {
    const statuses: ServerStatus[] = []
    const children: FakeChild[] = []
    const spawned: { exe: string; args: string[] }[] = []
    let nextPid = 5000
    const deps: Partial<ServerDeps> = {
      spawnProcess: (exePath, args) => {
        const child = new FakeChild(nextPid++)
        children.push(child)
        spawned.push({ exe: exePath, args })
        return child as unknown as ChildProcess
      },
      getProcessInfo: async (pid) => ({ exePath: exe, startTime: `2026-01-01T00:00:0${pid % 10}Z` }),
      killTree: async (pid) => {
        const child = children.find((c) => c.pid === pid)
        queueMicrotask(() => child?.emit('exit', 1, null))
      },
      checkHealth: async () => 200,
      pickPort: async (port) => port,
      sleep: async () => {},
      ...overrides,
    }
    const server = new LlamaServer({
      role,
      runDir: join(dir, 'run'),
      logsDir: join(dir, 'logs'),
      resolveLaunch: () => resolveLaunch(role, config, env),
      onStatus: (s) => statuses.push(s),
      logger: silentLogger,
      deps,
    })
    return { server, statuses, children, spawned }
  }

  it('goes stopped -> starting -> ready and records a pid file', async () => {
    const { server, statuses, spawned } = setup()
    await server.start()
    expect(statuses.map((s) => s.state)).toContain('starting')
    expect(server.getStatus()).toMatchObject({ state: 'ready', port: 18792, pid: 5000, errorCode: null })
    expect(spawned[0]?.exe).toBe(exe)
    expect(spawned[0]?.args).toContain('--reasoning')
    const path = pidFilePath(join(dir, 'run'), 'translate')
    await eventually(() => existsSync(path))
    expect(existsSync(path)).toBe(true)
  })

  it('keeps polling on 503 until /health returns 200', async () => {
    const answers: (number | null)[] = [null, 503, 503, 200]
    let call = 0
    const health = vi.fn(async () => answers[call++] ?? null)
    const { server } = setup({ checkHealth: health })
    await server.start()
    expect(health).toHaveBeenCalledTimes(4)
    expect(server.getStatus().state).toBe('ready')
  })

  it('reports MODEL_MISSING without spawning', async () => {
    present.delete('D:\\m\\tr.gguf')
    try {
      const { server, spawned } = setup()
      await server.start()
      expect(server.getStatus()).toMatchObject({ state: 'error', errorCode: 'MODEL_MISSING' })
      expect(spawned).toHaveLength(0)
    } finally {
      present.add('D:\\m\\tr.gguf')
    }
  })

  it('uses a fallback port when the configured one is busy', async () => {
    const { server, spawned } = setup({ pickPort: async () => 23456 })
    await server.start()
    expect(server.getStatus().port).toBe(23456)
    const args = spawned[0]?.args ?? []
    expect(args[args.indexOf('--port') + 1]).toBe('23456')
  })

  it('times out, kills the tree and reports STARTUP_TIMEOUT', async () => {
    let clock = 0
    const kill = vi.fn(async (pid: number) => {
      queueMicrotask(() => children.find((c) => c.pid === pid)?.emit('exit', 1, null))
    })
    const { server, children } = setup({
      checkHealth: async () => 503,
      now: () => (clock += 60_000),
      killTree: kill,
    })
    await server.start()
    expect(kill).toHaveBeenCalledWith(5000)
    expect(server.getStatus()).toMatchObject({ state: 'error', errorCode: 'STARTUP_TIMEOUT' })
  })

  it('stop() kills the recorded PID, waits for exit, removes the pid file and ends stopped', async () => {
    const kill = vi.fn(async (_pid: number) => {})
    const { server, children } = setup({
      killTree: async (pid) => {
        await kill(pid)
        queueMicrotask(() => children.find((c) => c.pid === pid)?.emit('exit', 1, null))
      },
    })
    await server.start()
    await server.stop()
    expect(kill).toHaveBeenCalledWith(5000)
    expect(server.getStatus()).toMatchObject({ state: 'stopped', pid: null, port: null })
    expect(existsSync(pidFilePath(join(dir, 'run'), 'translate'))).toBe(false)
  })

  it('treats an unexpected exit as a crash and schedules a restart', async () => {
    vi.useFakeTimers()
    try {
      const { server, children, spawned } = setup()
      await server.start()
      children[0]?.emit('exit', 3, null)
      expect(server.getStatus()).toMatchObject({ state: 'error', errorCode: 'EXITED' })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(spawned).toHaveLength(2)
      expect(server.getStatus().state).toBe('ready')
      await server.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart after an intentional stop', async () => {
    const { server, spawned } = setup()
    await server.start()
    await server.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(spawned).toHaveLength(1)
  })

  it('does not break the lifecycle when the status listener throws', async () => {
    const kill = vi.fn(async (pid: number) => {
      queueMicrotask(() => children.find((c) => c.pid === pid)?.emit('exit', 1, null))
    })
    const { server, children } = setup({ killTree: kill })
    ;(server as unknown as { options: { onStatus: () => void } }).options.onStatus = () => {
      throw new Error('Object has been destroyed')
    }
    await server.start()
    await server.stop()
    expect(kill).toHaveBeenCalledWith(5000)
    expect(server.getStatus().state).toBe('stopped')
    expect(existsSync(pidFilePath(join(dir, 'run'), 'translate'))).toBe(false)
  })

  it('reports SPAWN_FAILED when the process cannot be created', async () => {
    const { server, children } = setup({
      spawnProcess: () => {
        const child = new FakeChild(undefined)
        children.push(child)
        queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
        return child as unknown as ChildProcess
      },
    })
    await server.start()
    await eventually(() => server.getStatus().state === 'error')
    expect(server.getStatus()).toMatchObject({ state: 'error', errorCode: 'SPAWN_FAILED' })
  })
})
