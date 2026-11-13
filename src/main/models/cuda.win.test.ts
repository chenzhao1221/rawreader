import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeZip } from './__fixtures__/zip'
import { extractZip } from './cuda'

/** Spawns the real Windows tar.exe (bsdtar) on a tiny zip. No server and no network involved. */
describe('extractZip with the real tar.exe', () => {
  it('extracts a zip into the target folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-tar-'))
    try {
      const zip = join(dir, 'a.zip')
      writeFileSync(zip, makeZip([
        { name: 'llama-server.exe', data: new TextEncoder().encode('exe') },
        { name: 'sub/lib.dll', data: new TextEncoder().encode('dll') },
      ]))
      const out = join(dir, 'out')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(out)
      await extractZip(zip, out)
      expect(readFileSync(join(out, 'llama-server.exe'), 'utf8')).toBe('exe')
      expect(existsSync(join(out, 'sub', 'lib.dll'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('rejects with EXTRACT_FAILED for a file that is not a zip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-tar-'))
    try {
      const bad = join(dir, 'bad.zip')
      writeFileSync(bad, 'this is not a zip')
      await expect(extractZip(bad, dir)).rejects.toMatchObject({ code: 'EXTRACT_FAILED' })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
