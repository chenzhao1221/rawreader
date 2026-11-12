import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deletePidFile, listPidFiles, pidFilePath, readPidFile, shouldKillOrphan, writePidFile } from './pidfile'
import type { PidFile } from './pidfile'

const file: PidFile = {
  pid: 4321,
  startTime: '2026-11-13T10:00:00.1234567Z',
  exePath: 'C:\\Llama\\bin\\llama-server.exe',
  port: 18791,
}

describe('shouldKillOrphan', () => {
  it('kills when PID, start time and exe path all match', () => {
    expect(shouldKillOrphan(file, { exePath: file.exePath, startTime: file.startTime })).toBe(true)
  })

  it('matches the exe path case-insensitively and with forward slashes', () => {
    expect(shouldKillOrphan(file, { exePath: 'c:/llama/BIN/llama-server.exe', startTime: file.startTime })).toBe(true)
  })

  it('does not kill when the PID was reused (different start time)', () => {
    expect(shouldKillOrphan(file, { exePath: file.exePath, startTime: '2026-11-14T08:00:00.0000000Z' })).toBe(false)
  })

  it('does not kill a different executable, such as another llama-server', () => {
    const other = 'C:\\Users\\someone\\AppData\\Local\\Programs\\Ollama\\lib\\ollama\\llama-server.exe'
    expect(shouldKillOrphan(file, { exePath: other, startTime: file.startTime })).toBe(false)
  })

  it('does not kill when no process exists or its path is hidden', () => {
    expect(shouldKillOrphan(file, null)).toBe(false)
    expect(shouldKillOrphan(file, { exePath: null, startTime: file.startTime })).toBe(false)
  })
})

describe('pid file storage', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-pid-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips and deletes', async () => {
    const runDir = join(dir, 'run')
    await writePidFile(runDir, 'ocr', file)
    const path = pidFilePath(runDir, 'ocr')
    expect(await readPidFile(path)).toEqual(file)
    expect(await listPidFiles(runDir)).toEqual([path])
    await deletePidFile(path)
    expect(await readPidFile(path)).toBeNull()
    expect(await listPidFiles(runDir)).toEqual([])
  })

  it('treats invalid content as missing', async () => {
    const path = join(dir, 'llama-ocr.pid.json')
    writeFileSync(path, '{"pid":-5,"startTime":"x","exePath":"y","port":1}')
    expect(await readPidFile(path)).toBeNull()
    writeFileSync(path, 'not json')
    expect(await readPidFile(path)).toBeNull()
  })

  it('lists nothing when the folder does not exist and ignores unrelated files', async () => {
    expect(await listPidFiles(join(dir, 'nope'))).toEqual([])
    writeFileSync(join(dir, 'other.json'), '{}')
    writeFileSync(join(dir, 'llama-translate.pid.json'), '{}')
    expect(await listPidFiles(dir)).toEqual([join(dir, 'llama-translate.pid.json')])
  })
})
