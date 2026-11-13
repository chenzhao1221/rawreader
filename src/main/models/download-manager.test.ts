import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log/log'
import { fixtureBytes, sha256Of, startTestServer } from './__fixtures__/http-server'
import type { RouteBehavior, TestServer } from './__fixtures__/http-server'
import { DownloadManager } from './download-manager'
import type { FileDownloadState } from './download-manager'
import type { ManifestEntry } from './manifest'

function entryFor(role: ManifestEntry['role'], fileName: string, body: Uint8Array, withFallback = true): ManifestEntry {
  return {
    role,
    fileName,
    size: body.byteLength,
    sha256: sha256Of(body),
    bundled: false,
    huggingface: { repo: 'org/repo', revision: 'rev1' },
    modelscope: withFallback ? { repo: 'org/repo-ms', revision: 'master' } : null,
    displayName: fileName,
    license: 'Apache-2.0',
  }
}

describe('DownloadManager (local HTTP server, fixture bytes only)', () => {
  let server: TestServer
  let dir: string
  let states: FileDownloadState[]
  let maxParallel: number
  let done: string[]

  beforeAll(async () => {
    server = await startTestServer()
  })
  afterAll(async () => {
    await server.close()
  })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-dm-'))
    states = []
    maxParallel = 0
    done = []
    server.requests.length = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const make = () =>
    new DownloadManager({
      fetch: (url, init) => fetch(url, init),
      getTargetDir: () => dir,
      getMirrors: () => ({ huggingface: server.baseUrl, modelscope: server.baseUrl }),
      onChange: (next) => {
        states = next
        maxParallel = Math.max(maxParallel, next.filter((s) => s.status === 'downloading' || s.status === 'verifying').length)
      },
      onFileDone: (entry) => done.push(entry.fileName),
      logger: silentLogger,
      retryDelayMs: () => 0,
    })

  const serve = (entry: ManifestEntry, body: Uint8Array, hf: RouteBehavior[] = [{ kind: 'ok' }], ms: RouteBehavior[] = [{ kind: 'ok' }]) => {
    server.route(`/${entry.huggingface.repo}/resolve/${entry.huggingface.revision}/${entry.fileName}`, body, hf)
    if (entry.modelscope) server.route(`/models/${entry.modelscope.repo}/resolve/${entry.modelscope.revision}/${entry.fileName}`, body, ms)
  }
  const stateOf = (role: string) => states.find((s) => s.role === role)

  it('downloads three files with at most two at a time', async () => {
    const files = [
      { role: 'ocr' as const, name: 'a.gguf', body: fixtureBytes(120_000, 1) },
      { role: 'ocrMmproj' as const, name: 'b.gguf', body: fixtureBytes(120_000, 2) },
      { role: 'translator' as const, name: 'c.gguf', body: fixtureBytes(120_000, 3) },
    ]
    const entries = files.map((f) => entryFor(f.role, f.name, f.body))
    files.forEach((f, i) => serve(entries[i] as ManifestEntry, f.body, [{ kind: 'slow', chunk: 30_000, delayMs: 10 }]))

    const manager = make()
    manager.start(entries)
    await manager.whenIdle()

    expect(maxParallel).toBe(2)
    expect(done.sort()).toEqual(['a.gguf', 'b.gguf', 'c.gguf'])
    for (const f of files) expect(new Uint8Array(readFileSync(join(dir, f.name)))).toEqual(f.body)
    expect(states.every((s) => s.status === 'done')).toBe(true)
    expect(stateOf('ocr')?.receivedBytes).toBe(120_000)
  })

  it('pause keeps the .part file and resume finishes the download', async () => {
    const body = fixtureBytes(400_000, 4)
    const entry = entryFor('ocr', 'p.gguf', body)
    serve(entry, body, [{ kind: 'slow', chunk: 20_000, delayMs: 20 }])
    const manager = make()
    manager.start([entry])

    const partPath = join(dir, 'p.gguf.part')
    const destPath = join(dir, 'p.gguf')
    const deadline = Date.now() + 8_000
    while (true) {
      if (existsSync(destPath)) throw new Error('download finished before pause')
      if (existsSync(partPath) && statSync(partPath).size >= 60_000) break
      if (Date.now() > deadline) throw new Error('timed out waiting for a partial .part file')
      await new Promise((r) => setTimeout(r, 10))
    }
    manager.pause('ocr')
    await manager.whenIdle()
    expect(stateOf('ocr')?.status).toBe('paused')
    expect(existsSync(partPath), 'pause must keep the .part file').toBe(true)
    const partial = statSync(partPath).size
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(body.byteLength)
    expect(existsSync(destPath)).toBe(false)

    serve(entry, body) // fast server for the rest
    manager.resume('ocr')
    await manager.whenIdle()
    expect(stateOf('ocr')?.status).toBe('done')
    expect(server.requests.at(-1)?.range).toBe(`bytes=${partial}-`)
    expect(new Uint8Array(readFileSync(join(dir, 'p.gguf')))).toEqual(body)
  })

  it('cancel keeps the .part file and marks the file cancelled', async () => {
    const body = fixtureBytes(400_000, 5)
    const entry = entryFor('ocr', 'c.gguf', body)
    serve(entry, body, [{ kind: 'slow', chunk: 20_000, delayMs: 10 }])
    const manager = make()
    manager.start([entry])
    while ((stateOf('ocr')?.receivedBytes ?? 0) < 40_000) await new Promise((r) => setTimeout(r, 10))
    manager.cancel()
    await manager.whenIdle()
    expect(stateOf('ocr')?.status).toBe('cancelled')
    expect(existsSync(join(dir, 'c.gguf.part'))).toBe(true)
    expect(done).toEqual([])
  })

  it('cancelling a queued file never starts it', async () => {
    const bodies = [fixtureBytes(200_000, 6), fixtureBytes(200_000, 7), fixtureBytes(200_000, 8)]
    const entries = [entryFor('ocr', 'q1.gguf', bodies[0]!), entryFor('ocrMmproj', 'q2.gguf', bodies[1]!), entryFor('translator', 'q3.gguf', bodies[2]!)]
    entries.forEach((e, i) => serve(e, bodies[i]!, [{ kind: 'slow', chunk: 20_000, delayMs: 10 }]))
    const manager = make()
    manager.start(entries)
    manager.cancel('translator')
    await manager.whenIdle()
    expect(stateOf('translator')?.status).toBe('cancelled')
    expect(server.requests.some((r) => r.path.endsWith('/q3.gguf'))).toBe(false)
    expect(done.sort()).toEqual(['q1.gguf', 'q2.gguf'])
  })

  it('falls back to ModelScope after three failures on the mirror and reports the source', async () => {
    const body = fixtureBytes(50_000, 9)
    const entry = entryFor('translator', 't.gguf', body)
    serve(entry, body, [{ kind: 'status', status: 502 }])
    const manager = make()
    manager.start([entry])
    await manager.whenIdle()
    expect(stateOf('translator')).toMatchObject({ status: 'done', source: 'modelscope' })
    expect(server.requests.filter((r) => r.path.startsWith('/org/repo/'))).toHaveLength(3)
  })

  it('has no fallback for a file without a ModelScope repo and ends in the error state', async () => {
    const body = fixtureBytes(50_000, 10)
    const entry = entryFor('detector', 'd.onnx', body, false)
    serve(entry, body, [{ kind: 'status', status: 503 }])
    const manager = make()
    manager.start([entry])
    await manager.whenIdle()
    expect(stateOf('detector')).toMatchObject({ status: 'error', errorCode: 'ALL_SOURCES_FAILED' })
    expect(server.requests).toHaveLength(3)
    // Resume retries failed files.
    serve(entry, body)
    manager.resume('detector')
    await manager.whenIdle()
    expect(stateOf('detector')?.status).toBe('done')
  })
})
