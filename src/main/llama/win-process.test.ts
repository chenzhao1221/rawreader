import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertPid, killTree, parseProcessInfo } from './win-process'

describe('assertPid', () => {
  it.each([1, 4, 1234, 2 ** 31])('accepts %s', (pid) => {
    expect(() => assertPid(pid)).not.toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '12', null, undefined, {}, [1]])(
    'rejects %s',
    (pid) => {
      expect(() => assertPid(pid)).toThrow(/Invalid PID/)
    },
  )
})

describe('killTree guards', () => {
  it('rejects invalid PIDs before running anything', async () => {
    await expect(killTree(0)).rejects.toThrow(/Invalid PID/)
    await expect(killTree(Number.NaN)).rejects.toThrow(/Invalid PID/)
  })

  it('refuses protected PIDs and its own process', async () => {
    await expect(killTree(4)).rejects.toThrow(/protected/)
    await expect(killTree(process.pid)).rejects.toThrow(/protected/)
  })
})

describe('parseProcessInfo', () => {
  it('parses the CIM JSON', () => {
    const json = JSON.stringify({ ProcessId: 10, ExecutablePath: 'C:\\x\\llama-server.exe', Start: '2026-11-13T10:00:00.1234567Z' })
    expect(parseProcessInfo(json)).toEqual({ exePath: 'C:\\x\\llama-server.exe', startTime: '2026-11-13T10:00:00.1234567Z' })
  })

  it('returns null for empty or malformed output', () => {
    expect(parseProcessInfo('')).toBeNull()
    expect(parseProcessInfo('   \r\n')).toBeNull()
    expect(parseProcessInfo('not json')).toBeNull()
    expect(parseProcessInfo('{"ProcessId":1}')).toBeNull()
  })

  it('keeps a null exe path when Windows hides it', () => {
    expect(parseProcessInfo('{"ProcessId":1,"ExecutablePath":null,"Start":"2026-01-01T00:00:00Z"}')).toEqual({
      exePath: null,
      startTime: '2026-01-01T00:00:00Z',
    })
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|svelte|js|mjs)$/.test(name) ? [full] : []
  })
}

describe('source policy', () => {
  it('never kills by image name (no taskkill image-name switch anywhere in src/)', () => {
    const srcDir = join(import.meta.dirname, '..', '..')
    // Built from parts so this test file does not match itself.
    const imageSwitch = new RegExp(['taskkill[^\\n]*\\s', '\\/', 'im\\b'].join(''), 'i')
    const quotedSwitch = new RegExp(['[\'"`]', '\\/', 'im[\'"`\\s]'].join(''), 'i')
    const offenders = sourceFiles(srcDir)
      .filter((file) => !file.endsWith('win-process.test.ts'))
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
        return imageSwitch.test(text) || quotedSwitch.test(text)
      })
      .map((file) => relative(srcDir, file))
    expect(offenders).toEqual([])
  })

  it('always spawns taskkill with /PID and /T /F', () => {
    const text = readFileSync(join(import.meta.dirname, 'win-process.ts'), 'utf8')
    expect(text).toContain("['/PID', String(pid), '/T', '/F']")
  })
})
