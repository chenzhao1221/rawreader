import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { ServerStatus } from '../../shared/ipc/contract'
import { silentLogger } from '../log/log'
import { LlamaManager } from './manager'
import { writePidFile } from './pidfile'
import type { PidFile } from './pidfile'
import type { ProcessInfo } from './win-process'

const recorded: PidFile = {
  pid: 777,
  startTime: '2026-11-13T10:00:00.0000000Z',
  exePath: 'D:\\bin\\llama-server.exe',
  port: 18791,
}

describe('LlamaManager', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-mgr-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function create(options: { info: ProcessInfo | null | Error; config?: ReturnType<typeof ConfigSchema.parse> }) {
    const kill = vi.fn(async () => {})
    const statuses: ServerStatus[] = []
    const config = options.config ?? ConfigSchema.parse({})
    const manager = new LlamaManager({
      getConfig: () => config,
      env: { userDataDir: dir, resourcesDir: join(dir, 'res'), exists: () => false },
      runDir: join(dir, 'run'),
      logsDir: join(dir, 'logs'),
      onStatus: (s) => statuses.push(s),
      logger: silentLogger,
      deps: {
        getProcessInfo: async () => {
          if (options.info instanceof Error) throw options.info
          return options.info
        },
        killTree: kill,
      },
    })
    return { manager, kill, statuses }
  }

  const pidPath = () => join(dir, 'run', 'llama-ocr.pid.json')

  it('kills the recorded tree only when PID, start time and exe path all match', async () => {
    await writePidFile(join(dir, 'run'), 'ocr', recorded)
    const { manager, kill } = create({ info: { exePath: recorded.exePath, startTime: recorded.startTime } })
    await manager.cleanOrphans()
    expect(kill).toHaveBeenCalledExactlyOnceWith(777)
    expect(existsSync(pidPath())).toBe(false)
  })

  it('leaves a reused PID alone and deletes the stale file', async () => {
    await writePidFile(join(dir, 'run'), 'ocr', recorded)
    const { manager, kill } = create({ info: { exePath: recorded.exePath, startTime: '2027-01-01T00:00:00.0000000Z' } })
    await manager.cleanOrphans()
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(pidPath())).toBe(false)
  })

  it('leaves another llama-server (different exe path) alone', async () => {
    await writePidFile(join(dir, 'run'), 'ocr', recorded)
    const { manager, kill } = create({
      info: { exePath: 'C:\\Ollama\\lib\\ollama\\llama-server.exe', startTime: recorded.startTime },
    })
    await manager.cleanOrphans()
    expect(kill).not.toHaveBeenCalled()
  })

  it('just deletes the file when the process is gone', async () => {
    await writePidFile(join(dir, 'run'), 'ocr', recorded)
    const { manager, kill } = create({ info: null })
    await manager.cleanOrphans()
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(pidPath())).toBe(false)
  })

  it('deletes an unreadable pid file without killing anything', async () => {
    await writePidFile(join(dir, 'run'), 'ocr', recorded)
    writeFileSync(pidPath(), 'garbage')
    const { manager, kill } = create({ info: { exePath: recorded.exePath, startTime: recorded.startTime } })
    await manager.cleanOrphans()
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(pidPath())).toBe(false)
  })

  it('keeps the file when the process cannot be inspected', async () => {
    await writePidFile(join(dir, 'run'), 'ocr', recorded)
    const { manager, kill } = create({ info: new Error('powershell unavailable') })
    await manager.cleanOrphans()
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(pidPath())).toBe(true)
  })

  it('does nothing when there is no run folder', async () => {
    const { manager, kill } = create({ info: null })
    await expect(manager.cleanOrphans()).resolves.toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
  })

  it('starts with no models configured and shows BINARY_MISSING / MODEL_MISSING instead of crashing', async () => {
    const { manager } = create({ info: null })
    await manager.startAll()
    const statuses = manager.getStatuses()
    expect(statuses.map((s) => s.state)).toEqual(['error', 'error'])
    expect(statuses.map((s) => s.errorCode)).toEqual(['BINARY_MISSING', 'BINARY_MISSING'])
  })

  it('skips servers whose autostart is off', async () => {
    const config = ConfigSchema.parse({ llama: { ocr: { autostart: false } } })
    const { manager } = create({ info: null, config })
    await manager.startAll()
    expect(manager.getStatus('ocr').state).toBe('stopped')
    expect(manager.getStatus('translate').state).toBe('error')
  })
  it('startMissing retries failed servers but leaves stopped-by-user and autostart-off ones alone', async () => {
    const config = ConfigSchema.parse({ llama: { ocr: { autostart: false } } })
    const { manager } = create({ info: null, config })
    await manager.startAll()
    expect(manager.getStatus('translate').state).toBe('error')
    const before = manager.getStatuses().length
    await manager.control('translate', 'stop')
    expect(manager.getStatus('translate').state).toBe('stopped')
    await manager.startMissing()
    // Stopped by the user: not started again. OCR has autostart off: untouched.
    expect(manager.getStatus('translate').state).toBe('stopped')
    expect(manager.getStatus('ocr').state).toBe('stopped')
    expect(before).toBe(2)
  })

  it('startMissing starts a server that failed earlier (for example after models arrived)', async () => {
    const { manager } = create({ info: null })
    await manager.startAll()
    expect(manager.getStatus('ocr').errorCode).toBe('BINARY_MISSING')
    await manager.startMissing()
    expect(manager.getStatus('ocr').state).toBe('error')
    expect(manager.getStatus('ocr').errorCode).toBe('BINARY_MISSING')
  })})
