import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureBytes, sha256Of } from './__fixtures__/http-server'
import { hashFile } from './download'
import { FileVerifier, createJsonMemoStore } from './verify'
import type { VerifiedEntry } from './verify'

describe('FileVerifier', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-vf-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const body = fixtureBytes(50_000, 21)
  const spec = { size: body.byteLength, sha256: sha256Of(body) }
  const memoStore = (initial: VerifiedEntry[] = []) => {
    let saved = initial
    return { load: () => Promise.resolve(saved), save: (e: VerifiedEntry[]) => ((saved = e), Promise.resolve()), get saved() { return saved } }
  }

  it('checks the size without hashing', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, body)
    const hash = vi.fn(hashFile)
    const v = new FileVerifier({ memo: memoStore(), hash })
    expect(await v.checkSize(spec, path)).toEqual({ status: 'ok' })
    expect(await v.checkSize({ size: 1 }, path)).toEqual({ status: 'size-mismatch', actual: body.byteLength, expected: 1 })
    expect((await v.checkSize(spec, join(dir, 'nope'))).status).toBe('unreadable')
    expect(hash).not.toHaveBeenCalled()
  })

  it('hashes once and remembers { path, size, mtimeMs, ok }', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, body)
    const memo = memoStore()
    const hash = vi.fn(hashFile)
    const v = new FileVerifier({ memo, hash })
    expect(await v.check(spec, path)).toEqual({ status: 'ok' })
    expect(hash).toHaveBeenCalledTimes(1)
    expect(memo.saved).toHaveLength(1)
    expect(memo.saved[0]).toMatchObject({ path, size: body.byteLength, ok: true })

    // A new verifier with the saved memo (app restart) does not hash again.
    const again = new FileVerifier({ memo, hash })
    expect(await again.check(spec, path)).toEqual({ status: 'ok' })
    expect(hash).toHaveBeenCalledTimes(1)
  })

  it('hashes again when the file changed (mtime) or the manifest hash changed', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, body)
    const memo = memoStore()
    const hash = vi.fn(hashFile)
    await new FileVerifier({ memo, hash }).check(spec, path)
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    await new FileVerifier({ memo, hash }).check(spec, path)
    expect(hash).toHaveBeenCalledTimes(2)
    await new FileVerifier({ memo, hash }).check({ ...spec, sha256: 'f'.repeat(64) }, path)
    expect(hash).toHaveBeenCalledTimes(3)
  })

  it('reports a hash mismatch and remembers it', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, fixtureBytes(body.byteLength, 22))
    const memo = memoStore()
    const hash = vi.fn(hashFile)
    expect(await new FileVerifier({ memo, hash }).check(spec, path)).toEqual({ status: 'hash-mismatch' })
    expect(await new FileVerifier({ memo, hash }).check(spec, path)).toEqual({ status: 'hash-mismatch' })
    expect(hash).toHaveBeenCalledTimes(1)
  })

  it('shares one hash run between concurrent checks of the same file', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, body)
    const hash = vi.fn(hashFile)
    const v = new FileVerifier({ memo: memoStore(), hash })
    await Promise.all([v.check(spec, path), v.check(spec, path)])
    expect(hash).toHaveBeenCalledTimes(1)
  })

  it('markVerified skips hashing for a downloaded file', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, body)
    const hash = vi.fn(hashFile)
    const v = new FileVerifier({ memo: memoStore(), hash })
    await v.markVerified(spec, path)
    expect(await v.check(spec, path)).toEqual({ status: 'ok' })
    expect(hash).not.toHaveBeenCalled()
  })

  it('persists the memo as JSON and ignores a corrupt file', async () => {
    const file = join(dir, 'models-verified.json')
    const store = createJsonMemoStore(file)
    expect(await store.load()).toEqual([])
    const entry: VerifiedEntry = { path: 'x', size: 1, mtimeMs: 2, expectedSha256: 'a', ok: true }
    await store.save([entry])
    expect(await store.load()).toEqual([entry])
    writeFileSync(file, '{not json')
    expect(await store.load()).toEqual([])
  })
})