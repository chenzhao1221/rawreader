import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixtureBytes, sha256Of, startTestServer } from './__fixtures__/http-server'
import type { TestServer } from './__fixtures__/http-server'
import { DownloadError, downloadFile, hashFile, parseContentRangeStart } from './download'
import type { DownloadFileOptions, FetchLike, UrlSource } from './download'

const body = fixtureBytes(300_000, 7)
const spec = { fileName: 'tiny.gguf', size: body.byteLength, sha256: sha256Of(body) }

describe('downloadFile (local HTTP server, fixture bytes only)', () => {
  let server: TestServer
  let dir: string
  let dest: string
  const controller = () => new AbortController()
  const realFetch: FetchLike = (url, init) => fetch(url, init)

  beforeAll(async () => {
    server = await startTestServer()
  })
  afterAll(async () => {
    await server.close()
  })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-dl-'))
    dest = join(dir, 'models', 'tiny.gguf')
    server.requests.length = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const urls = (primary: string, secondary?: string): readonly UrlSource[] => [
    { source: 'huggingface', url: `${server.baseUrl}${primary}` },
    ...(secondary ? [{ source: 'modelscope' as const, url: `${server.baseUrl}${secondary}` }] : []),
  ]
  const run = (sources: readonly UrlSource[], extra: Partial<DownloadFileOptions> = {}) =>
    downloadFile({ spec, sources, destPath: dest, fetch: realFetch, signal: controller().signal, retryDelayMs: () => 0, ...extra })

  it('downloads a fresh file, verifies it and renames it atomically', async () => {
    server.route('/a', body)
    const phases: string[] = []
    const result = await run(urls('/a'), { onPhase: (p) => phases.push(p) })
    expect(result).toEqual({ source: 'huggingface', resumedFrom: 0 })
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(server.requests).toEqual([{ path: '/a', range: null }])
    expect(phases).toContain('verifying')
  })

  it('resumes from a .part file with a Range request and a 206 response', async () => {
    server.route('/a', body)
    writeFileSync(`${dest}.part`.replace('models', ''), '') // ensure the temp dir exists on its own
    const resumeAt = 120_000
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(`${dest}.part`, body.subarray(0, resumeAt))
    const progress: number[] = []
    const result = await run(urls('/a'), { onProgress: (n) => progress.push(n) })
    expect(result.resumedFrom).toBe(resumeAt)
    expect(server.requests).toEqual([{ path: '/a', range: `bytes=${resumeAt}-` }])
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
    expect(progress[0]).toBe(resumeAt)
    expect(progress.at(-1)).toBe(body.byteLength)
  })

  it('restarts from zero when the server answers 200 to a Range request', async () => {
    server.route('/a', body, [{ kind: 'ignore-range' }])
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(`${dest}.part`, body.subarray(0, 50_000))
    await run(urls('/a'))
    expect(server.requests[0]?.range).toBe('bytes=50000-')
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
    expect(statSync(dest).size).toBe(body.byteLength)
  })

  it('discards the partial file on 416 and succeeds on the next attempt', async () => {
    server.route('/a', body, [{ kind: 'status', status: 416 }, { kind: 'ok' }])
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(`${dest}.part`, body.subarray(0, 10_000))
    await run(urls('/a'))
    expect(server.requests.map((r) => r.range)).toEqual(['bytes=10000-', null])
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
  })

  it('verifies and renames a complete .part without any request', async () => {
    server.route('/a', body)
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(`${dest}.part`, body)
    const result = await run(urls('/a'))
    expect(result.resumedFrom).toBe(body.byteLength)
    expect(server.requests).toEqual([])
    expect(existsSync(dest)).toBe(true)
  })

  it('rejects a 206 whose Content-Range starts elsewhere, then restarts cleanly', async () => {
    server.route('/a', body, [{ kind: 'wrong-content-range' }, { kind: 'ok' }])
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(`${dest}.part`, body.subarray(0, 20_000))
    const errors: string[] = []
    await run(urls('/a'), { onRetry: (_s, _n, e) => errors.push(e.code) })
    expect(errors).toEqual(['RANGE_MISMATCH'])
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
  })

  it('resumes after the connection drops in the middle of the body', async () => {
    server.route('/a', body, [{ kind: 'truncate', bytes: 100_000 }, { kind: 'ok' }])
    const result = await run(urls('/a'))
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]?.range).toMatch(/^bytes=\d+-$/)
    expect(result.resumedFrom).toBeGreaterThan(0)
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
  })

  it('fails on a sha256 mismatch, removes the bad part and falls back to the second source', async () => {
    server.route('/bad', body, [{ kind: 'corrupt' }])
    server.route('/good', body)
    const errors: string[] = []
    const result = await run(urls('/bad', '/good'), { onRetry: (_s, _n, e) => errors.push(e.code) })
    expect(result.source).toBe('modelscope')
    expect(errors).toEqual(['HASH_MISMATCH', 'HASH_MISMATCH', 'HASH_MISMATCH'])
    expect(server.requests.filter((r) => r.path === '/bad')).toHaveLength(3)
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
  })

  it('uses ModelScope after exactly three failed attempts on the primary', async () => {
    server.route('/down', body, [{ kind: 'status', status: 503 }])
    server.route('/ms', body)
    const attempts: Array<[string, number]> = []
    const result = await run(urls('/down', '/ms'), { onAttempt: (s, n) => attempts.push([s, n]) })
    expect(result.source).toBe('modelscope')
    expect(attempts).toEqual([['huggingface', 1], ['huggingface', 2], ['huggingface', 3], ['modelscope', 1]])
    expect(server.requests.filter((r) => r.path === '/down')).toHaveLength(3)
  })

  it('does not retry a 404 on the same source', async () => {
    server.route('/ms', body)
    const result = await run(urls('/missing', '/ms'))
    expect(result.source).toBe('modelscope')
    expect(server.requests.filter((r) => r.path === '/missing')).toHaveLength(1)
  })

  it('drops a source that stays too slow and resumes on the next one with a Range request', async () => {
    server.route('/slow', body, [{ kind: 'slow', chunk: 20_000, delayMs: 50 }])
    server.route('/fast', body)
    const errors: string[] = []
    const result = await run(urls('/slow', '/fast'), { slowWindowMs: 200, onRetry: (_s, _n, e) => errors.push(e.code) })
    expect(errors).toEqual(['SLOW'])
    expect(result.source).toBe('modelscope')
    expect(result.resumedFrom).toBeGreaterThan(0)
    expect(server.requests.filter((r) => r.path === '/slow')).toHaveLength(1)
    expect(server.requests.filter((r) => r.path === '/slow')[0]?.range).toBeNull()
    expect(server.requests.find((r) => r.path === '/fast')?.range).toBe(`bytes=${result.resumedFrom}-`)
    expect(sha256Of(new Uint8Array(readFileSync(dest)))).toBe(spec.sha256)
  })

  it('keeps a slow download when it is the last source', async () => {
    server.route('/only', body, [{ kind: 'slow', chunk: 20_000, delayMs: 50 }])
    const errors: string[] = []
    const result = await run(urls('/only'), { slowWindowMs: 200, onRetry: (_s, _n, e) => errors.push(e.code) })
    expect(errors).toEqual([])
    expect(result.source).toBe('huggingface')
    expect(server.requests.filter((r) => r.path === '/only')).toHaveLength(1)
    expect(sha256Of(new Uint8Array(readFileSync(dest)))).toBe(spec.sha256)
  })

  it('reports ABORTED, not SLOW, when the user stops a slow attempt', async () => {
    server.route('/slow', body, [{ kind: 'slow', chunk: 20_000, delayMs: 50 }])
    server.route('/fast', body)
    const abort = controller()
    const attempt = run(urls('/slow', '/fast'), {
      signal: abort.signal,
      slowWindowMs: 200,
      onProgress: (n) => n >= 20_000 && abort.abort(),
    })
    await expect(attempt).rejects.toMatchObject({ code: 'ABORTED' })
    expect(server.requests.filter((r) => r.path === '/fast')).toHaveLength(0)
    expect(existsSync(dest)).toBe(false)
  })

  it('reports ALL_SOURCES_FAILED when no source works and keeps no destination file', async () => {
    server.route('/x', body, [{ kind: 'status', status: 500 }])
    await expect(run(urls('/x'))).rejects.toMatchObject({ code: 'ALL_SOURCES_FAILED' })
    expect(existsSync(dest)).toBe(false)
  })

  it('keeps the .part file on abort (pause or cancel) and a later call resumes it', async () => {
    server.route('/slow', body, [{ kind: 'slow', chunk: 20_000, delayMs: 15 }])
    const abort = controller()
    const first = run(urls('/slow'), { signal: abort.signal, onProgress: (n) => n > 60_000 && abort.abort() })
    await expect(first).rejects.toBeInstanceOf(DownloadError)
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' })
    const partial = statSync(`${dest}.part`).size
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(body.byteLength)
    expect(existsSync(dest)).toBe(false)

    server.route('/slow', body)
    const result = await run(urls('/slow'))
    expect(result.resumedFrom).toBe(partial)
    expect(new Uint8Array(readFileSync(dest))).toEqual(body)
  })

  it('does not start when the signal is already aborted', async () => {
    server.route('/a', body)
    const abort = controller()
    abort.abort()
    await expect(run(urls('/a'), { signal: abort.signal })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(server.requests).toEqual([])
  })
})

describe('helpers', () => {
  it('parses Content-Range starts', () => {
    expect(parseContentRangeStart('bytes 100-999/1000')).toBe(100)
    expect(parseContentRangeStart('bytes 0-9/*')).toBe(0)
    expect(parseContentRangeStart('bytes */1000')).toBeNull()
    expect(parseContentRangeStart(null)).toBeNull()
  })

  it('hashes a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-hash-'))
    try {
      const path = join(dir, 'f.bin')
      const bytes = fixtureBytes(100_000, 3)
      writeFileSync(path, bytes)
      expect(await hashFile(path)).toBe(sha256Of(bytes))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
