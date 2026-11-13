import { describe, expect, it, vi } from 'vitest'
import type { CaptureRequest, CaptureResult } from '../capture/capture'
import { sha256Hex } from '../capture/hash'
import type { DetectJob, DetectOutcome, DetectService } from '../detect/service'
import { silentLogger } from '../log/log'
import type { TranslateRequest, TranslateResult } from '../translate/client'
import { Pipeline } from './scheduler'
import type { PipelineCache, PipelineDeps, PipelineSettings } from './scheduler'
import { ImageRegistry } from './state'
import type { ImageFailure, ImageResult, Subscriber } from './types'

const sleep = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const box = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, confidence: 0.9 })

function detectOk(unitCount = 2): DetectOutcome {
  return {
    ok: true,
    result: {
      width: 800,
      height: 1000,
      tiled: false,
      tileCount: 1,
      units: Array.from({ length: unitCount }, (_, i) => ({
        kind: 'bubble' as const,
        bubbleOnly: i === 1,
        drawBox: box(10, 100 * i, 200, 100 * i + 80),
        ocrBox: box(20, 100 * i + 10, 190, 100 * i + 70),
        ocrPng: Uint8Array.from([0x89, 0x50, i]),
      })),
      timings: { decodeMs: 1, inferMs: 1, cropMs: 1 },
    },
  }
}

interface Harness {
  pipeline: Pipeline
  results: Array<{ subscriber: Subscriber; result: ImageResult }>
  failures: Array<{ subscriber: Subscriber; failure: ImageFailure }>
  detect: ReturnType<typeof vi.fn>
  ocr: ReturnType<typeof vi.fn>
  translate: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
  settings: PipelineSettings
  progress: Array<{ total: number; done: number; failed: number; active: number }>
}

function setup(overrides: {
  bytesByUrl?: Record<string, Uint8Array>
  detect?: (job: DetectJob) => Promise<DetectOutcome>
  ocr?: (png: Uint8Array) => Promise<{ ok: true; text: string } | { ok: false; error: { code: string; message: string } }>
  translate?: (request: TranslateRequest) => Promise<TranslateResult>
  serversUnavailable?: () => { code: string; message: string } | null
  settings?: Partial<PipelineSettings>
  cache?: PipelineCache
} = {}): Harness {
  const bytesByUrl = overrides.bytesByUrl ?? {}
  const settings: PipelineSettings = {
    maxImageBytes: 1_000_000,
    ocrConcurrency: 2,
    translateConcurrency: 2,
    readingDirection: 'ltr',
    ocrPadding: 8,
    maxUnitsPerImage: 50,
    ...overrides.settings,
  }
  const capture = vi.fn((request: CaptureRequest): Promise<CaptureResult> => {
    const bytes = bytesByUrl[request.url] ?? new TextEncoder().encode(request.url)
    return Promise.resolve({ ok: true, image: { bytes, mime: 'image/png', hash: sha256Hex(bytes), source: 'cdp' } })
  })
  const detect = vi.fn(overrides.detect ?? (() => Promise.resolve(detectOk())))
  const ocr = vi.fn(overrides.ocr ?? ((png: Uint8Array) => Promise.resolve({ ok: true as const, text: `text-${png[2]}` })))
  const translate = vi.fn(
    overrides.translate ??
      ((request: TranslateRequest): Promise<TranslateResult> =>
        Promise.resolve({ ok: true, translation: `zh(${request.sources[request.index]})`, echo: false, retriedBare: false, prompt: 'p' })),
  )
  const detectService: DetectService = { detect, dispose: () => Promise.resolve() }
  const results: Harness['results'] = []
  const failures: Harness['failures'] = []
  const progress: Harness['progress'] = []
  const deps: PipelineDeps = {
    settings: () => settings,
    capture,
    detect: detectService,
    ocr: { recognize: (png) => ocr(png) },
    translator: { translate: (request) => translate(request) },
    serversUnavailable: overrides.serversUnavailable ?? (() => null),
    onResult: (subscriber, result) => results.push({ subscriber, result }),
    onFailure: (subscriber, failure) => failures.push({ subscriber, failure }),
    onProgress: (p) => progress.push(p),
    ...(overrides.cache ? { cache: overrides.cache } : {}),
    logger: silentLogger,
  }
  const pipeline = new Pipeline(deps)
  return { pipeline, results, failures, detect, ocr, translate, capture, settings, progress }
}

const DOC = 'doc-aaaaaaaa'
const image = (elId: string, url: string, distance = 0) => ({ elId, url, naturalW: 800, naturalH: 1000, distance })
const batch = (images: ReturnType<typeof image>[], docId = DOC) => ({ docId, pageUrl: 'https://site.example/ch1', images })

describe('Pipeline', () => {
  it('runs capture, detect, OCR and translate and delivers one result', async () => {
    const h = setup()
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC, 'https://site.example/ch1')
    expect(h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))).toBe(1)
    await h.pipeline.whenIdle()

    expect(h.results).toHaveLength(1)
    const { result, subscriber } = h.results[0]!
    expect(subscriber).toEqual({ docId: DOC, elId: 'rr1' })
    expect(result.units.map((u) => [u.ocrText, u.translation, u.status])).toEqual([
      ['text-0', 'zh(text-0)', 'ok'],
      ['text-1', 'zh(text-1)', 'ok'],
    ])
    expect(result.units[1]!.bubbleOnly).toBe(true)
    expect(h.pipeline.getProgress()).toEqual({ total: 1, done: 1, failed: 0, active: 0 })
    expect(h.translate).toHaveBeenCalledTimes(2) // one request per unit
  })

  it('passes all OCR sources and the unit index to translation (context stays source-only)', async () => {
    const h = setup()
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    const requests = h.translate.mock.calls.map((c) => c[0] as TranslateRequest)
    expect(requests.map((r) => r.index).sort()).toEqual([0, 1])
    expect(requests[0]!.sources).toEqual(['text-0', 'text-1'])
  })

  it('enqueues each element-URL pair once per page load', async () => {
    const h = setup()
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    expect(h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))).toBe(1)
    expect(h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))).toBe(0)
    expect(h.pipeline.submit(batch([image('rr1', 'https://cdn.example/other.png')]))).toBe(1)
    await h.pipeline.whenIdle()
    expect(h.capture).toHaveBeenCalledTimes(2)
  })

  it('runs identical bytes under two URLs once and delivers to both elements', async () => {
    const same = Uint8Array.from([1, 2, 3, 4])
    const h = setup({ bytesByUrl: { 'https://a.example/x.png': same, 'https://b.example/y.png?t=1': same } })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://a.example/x.png'), image('rr2', 'https://b.example/y.png?t=1')]))
    await h.pipeline.whenIdle()

    expect(h.detect).toHaveBeenCalledTimes(1)
    expect(h.results.map((r) => r.subscriber.elId).sort()).toEqual(['rr1', 'rr2'])
    expect(h.pipeline.getProgress()).toMatchObject({ total: 2, done: 2, active: 0 })
  })

  it('serves a repeated image from memory without detecting again', async () => {
    const same = new TextEncoder().encode('same bytes')
    const h = setup({ bytesByUrl: { 'https://cdn.example/1.png': same, 'https://cdn.example/1.png#again': same } })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    h.pipeline.submit(batch([image('rr9', 'https://cdn.example/1.png#again')]))
    await h.pipeline.whenIdle()
    expect(h.detect).toHaveBeenCalledTimes(1)
    expect(h.results).toHaveLength(2)
  })

  it('drops batches for a stale document id or while disabled', async () => {
    const h = setup()
    h.pipeline.beginDocument(DOC)
    expect(h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))).toBe(0) // disabled
    h.pipeline.setEnabled(true)
    expect(h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')], 'doc-stale-id'))).toBe(0)
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('starts the image nearest the viewport first', async () => {
    const gate = deferred()
    const order: number[] = []
    const h = setup({
      detect: async (job) => {
        order.push(job.bytes[0] as number)
        if (order.length === 1) await gate.promise
        return detectOk(0)
      },
      bytesByUrl: {
        'https://x/first': Uint8Array.from([0]),
        'https://x/far': Uint8Array.from([5]),
        'https://x/near': Uint8Array.from([1]),
        'https://x/mid': Uint8Array.from([3]),
      },
    })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('a', 'https://x/first', 0)]))
    await sleep()
    h.pipeline.submit(batch([image('b', 'https://x/far', 500), image('c', 'https://x/near', 10), image('d', 'https://x/mid', 200)]))
    await sleep()
    gate.resolve()
    await h.pipeline.whenIdle()
    expect(order).toEqual([0, 1, 3, 5])
  })

  it('cancels on navigation: late results of the old document never arrive', async () => {
    const gate = deferred()
    const h = setup({
      detect: async () => {
        await gate.promise
        return detectOk(1)
      },
    })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await sleep()

    h.pipeline.beginDocument('doc-bbbbbbbb') // navigation
    gate.resolve()
    await sleep(40)

    expect(h.results).toHaveLength(0)
    expect(h.failures).toHaveLength(0)
    expect(h.ocr).not.toHaveBeenCalled() // the run stopped before OCR
    expect(h.pipeline.getProgress()).toEqual({ total: 0, done: 0, failed: 0, active: 0 })
    // The new document starts clean and can process the same image.
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')], 'doc-bbbbbbbb'))
    await h.pipeline.whenIdle()
    expect(h.results).toHaveLength(1)
    expect(h.results[0]!.subscriber.docId).toBe('doc-bbbbbbbb')
  })

  it('turning auto-translate off cancels queued capture but lets running work finish without delivering', async () => {
    const gate = deferred()
    const h = setup({
      detect: async () => {
        await gate.promise
        return detectOk(1)
      },
    })
    // Capture concurrency is 4: hold every capture so images 4 and 5 stay queued, then disable.
    const captureGate = deferred()
    let captures = 0
    h.capture.mockImplementation(async (request: CaptureRequest) => {
      captures++
      await captureGate.promise
      const bytes = new TextEncoder().encode(request.url)
      return { ok: true as const, image: { bytes, mime: 'image/png' as const, hash: sha256Hex(bytes), source: 'cdp' as const } }
    })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch(Array.from({ length: 6 }, (_, i) => image(`rr${i}`, `https://x/${i}.png`, i))))
    await sleep()

    h.pipeline.setEnabled(false)
    captureGate.resolve()
    gate.resolve()
    await sleep(60)

    expect(h.results).toHaveLength(0) // nothing rendered while disabled
    // Images 0..3 had passed capture and ran to the end (kept in memory); 4 and 5 were cancelled.
    expect(h.detect).toHaveBeenCalledTimes(4)

    // Re-enable and report again: finished images come straight from memory.
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument('doc-cccccccc')
    h.pipeline.submit(batch([image('rr0', 'https://x/0.png')], 'doc-cccccccc'))
    await h.pipeline.whenIdle()
    expect(h.results).toHaveLength(1)
    expect(h.detect).toHaveBeenCalledTimes(4)
  })

  it('keeps going when one unit fails OCR', async () => {
    const h = setup({
      ocr: (png) =>
        Promise.resolve(png[2] === 0 ? { ok: false as const, error: { code: 'HTTP_ERROR', message: '503' } } : { ok: true as const, text: 'ok text' }),
    })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    const units = h.results[0]!.result.units
    expect(units[0]).toMatchObject({ status: 'ocr-failed', ocrText: '', translation: '' })
    expect(units[1]).toMatchObject({ status: 'ok', translation: 'zh(ok text)' })
    expect(h.translate).toHaveBeenCalledTimes(1) // empty OCR is not sent to the translator
  })

  it('marks empty OCR as no-text, translate failures and echoes per unit', async () => {
    const h = setup({
      detect: () => Promise.resolve(detectOk(3)),
      ocr: (png) => Promise.resolve({ ok: true as const, text: png[2] === 0 ? '   ' : `t${png[2]}` }),
      translate: (request) =>
        Promise.resolve(
          request.index === 1
            ? { ok: false as const, error: { code: 'NETWORK', message: 'down' } }
            : { ok: true as const, translation: '', echo: true, retriedBare: true, prompt: '' },
        ),
    })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.results[0]!.result.units.map((u) => u.status)).toEqual(['no-text', 'translate-failed', 'echo'])
  })

  it('reports an image failure when detection fails', async () => {
    const h = setup({ detect: () => Promise.resolve({ ok: false, error: { code: 'DETECT_FAILED', message: 'bad' } }) })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.failures).toEqual([{ subscriber: { docId: DOC, elId: 'rr1' }, failure: { code: 'DETECT_FAILED', message: 'bad' } }])
    expect(h.pipeline.getProgress()).toEqual({ total: 1, done: 0, failed: 1, active: 0 })
    // A failed hash is retried on the next report.
    expect(h.pipeline.registryForTests.getStatus(sha256Hex(new TextEncoder().encode('https://cdn.example/1.png')))).toBe('idle')
  })

  it('reports capture failures', async () => {
    const h = setup()
    h.capture.mockResolvedValue({ ok: false, code: 'FETCH_FAILED', detail: 'HTTP error status' })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.failures[0]!.failure.code).toBe('FETCH_FAILED')
    expect(h.detect).not.toHaveBeenCalled()
  })

  it('fails the image with the server reason when OCR/translate servers are not ready', async () => {
    const h = setup({ serversUnavailable: () => ({ code: 'SERVER_NOT_READY', message: 'ocr is starting' }) })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.failures[0]!.failure.code).toBe('SERVER_NOT_READY')
    expect(h.ocr).not.toHaveBeenCalled()
  })

  it('does not call the servers when no unit was found', async () => {
    const h = setup({ detect: () => Promise.resolve(detectOk(0)), serversUnavailable: () => ({ code: 'SERVER_NOT_READY', message: 'x' }) })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.results[0]!.result.units).toEqual([])
    expect(h.failures).toEqual([])
  })

  it('bounds translation and OCR concurrency', async () => {
    let active = 0
    let maxActive = 0
    const slow = async <T>(value: T): Promise<T> => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(10)
      active--
      return value
    }
    const h = setup({
      settings: { translateConcurrency: 2, ocrConcurrency: 3 },
      detect: () => Promise.resolve(detectOk(8)),
      translate: (request) =>
        slow({ ok: true as const, translation: 'x', echo: false, retriedBare: false, prompt: `${request.index}` }),
    })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBeGreaterThan(1)
    expect(h.translate).toHaveBeenCalledTimes(8)
  })

  it('caps units per image', async () => {
    const h = setup({ settings: { maxUnitsPerImage: 1 }, detect: () => Promise.resolve(detectOk(5)) })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.results[0]!.result.units).toHaveLength(1)
  })

  it('pushes progress updates', async () => {
    const h = setup()
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.progress.at(-1)).toEqual({ total: 1, done: 1, failed: 0, active: 0 })
    expect(h.progress.some((p) => p.active === 1)).toBe(true)
  })
})

describe('ImageRegistry', () => {
  const sub = (elId: string, docId = 'd1'): Subscriber => ({ docId, elId })
  const result = (hash: string): ImageResult => ({
    hash,
    width: 1,
    height: 1,
    units: [],
    timings: { captureMs: 0, detectMs: 0, ocrMs: 0, translateMs: 0 },
    captureSource: 'cdp',
  })

  it('starts once, joins pending claims and completes all subscribers', () => {
    const registry = new ImageRegistry()
    const first = registry.claim('h', sub('a'))
    expect(first.kind).toBe('start')
    expect(registry.claim('h', sub('b')).kind).toBe('joined')
    expect(registry.getStatus('h')).toBe('pending')
    if (first.kind !== 'start') throw new Error('unreachable')
    const done = registry.markDone('h', first.token, result('h'))
    expect(done?.subscribers.map((s) => s.elId).sort()).toEqual(['a', 'b'])
    expect(registry.claim('h', sub('c'))).toMatchObject({ kind: 'done' })
  })

  it('goes back to idle on failure so a retry can start', () => {
    const registry = new ImageRegistry()
    const claim = registry.claim('h', sub('a'))
    if (claim.kind !== 'start') throw new Error('unreachable')
    registry.markIdle('h', claim.token, { code: 'X', message: 'x' })
    expect(registry.getStatus('h')).toBe('idle')
    expect(registry.claim('h', sub('a')).kind).toBe('start')
  })

  it('ignores completions with a stale token after the document was dropped', () => {
    const registry = new ImageRegistry()
    const old = registry.claim('h', sub('a', 'old'))
    registry.dropDocument('old')
    const fresh = registry.claim('h', sub('a', 'new'))
    if (old.kind !== 'start' || fresh.kind !== 'start') throw new Error('unreachable')
    expect(registry.markDone('h', old.token, result('h'))).toBeNull()
    expect(registry.getStatus('h')).toBe('pending')
    expect(registry.markDone('h', fresh.token, result('h'))).not.toBeNull()
  })

  it('keeps finished results across documents and evicts the oldest beyond the cap', () => {
    const registry = new ImageRegistry(2)
    for (const hash of ['a', 'b', 'c']) {
      const claim = registry.claim(hash, sub('x'))
      if (claim.kind !== 'start') throw new Error('unreachable')
      registry.markDone(hash, claim.token, result(hash))
    }
    registry.dropDocument('d1')
    expect(registry.getStatus('a')).toBe('idle') // evicted
    expect(registry.getStatus('b')).toBe('done')
    expect(registry.getStatus('c')).toBe('done')
  })
})

describe('Pipeline with the persistent cache', () => {
  /** In-memory stand-in for the SQLite-backed cache, shared by two pipelines like a restart would. */
  function memoryCache(): PipelineCache & { rows: Map<string, unknown> } {
    const rows = new Map<string, Pick<ImageResult, 'width' | 'height' | 'units'>>()
    return {
      rows,
      lookup: (hash) => rows.get(hash) ?? null,
      store: (hash, result) => void rows.set(hash, { width: result.width, height: result.height, units: result.units }),
    }
  }

  it('a second lookup of the same hash skips detect, OCR and translate', async () => {
    const cache = memoryCache()
    const same = new Uint8Array([1, 2, 3])
    const bytes = { 'https://cdn.example/1.png': same, 'https://other.example/same-bytes.png': same }

    const first = setup({ cache, bytesByUrl: bytes })
    first.pipeline.setEnabled(true)
    first.pipeline.beginDocument(DOC)
    first.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await first.pipeline.whenIdle()
    expect(first.results).toHaveLength(1)
    expect(first.detect).toHaveBeenCalledTimes(1)
    expect(cache.rows.size).toBe(1)

    // A fresh pipeline (as after a restart) with the same cache.
    const second = setup({ cache, bytesByUrl: bytes })
    second.pipeline.setEnabled(true)
    second.pipeline.beginDocument(DOC)
    second.pipeline.submit(batch([image('rr9', 'https://other.example/same-bytes.png')]))
    await second.pipeline.whenIdle()
    expect(second.capture).toHaveBeenCalledTimes(1)
    expect(second.detect).not.toHaveBeenCalled()
    expect(second.ocr).not.toHaveBeenCalled()
    expect(second.translate).not.toHaveBeenCalled()
    expect(second.results[0]?.result.units.map((u) => u.translation)).toEqual(first.results[0]?.result.units.map((u) => u.translation))
    expect(second.results[0]?.subscriber.elId).toBe('rr9')
  })

  it('a hit does not need the servers to be ready', async () => {
    const cache = memoryCache()
    const bytes = { 'https://cdn.example/1.png': new Uint8Array([7, 7]) }
    const first = setup({ cache, bytesByUrl: bytes })
    first.pipeline.setEnabled(true)
    first.pipeline.beginDocument(DOC)
    first.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await first.pipeline.whenIdle()

    const second = setup({ cache, bytesByUrl: bytes, serversUnavailable: () => ({ code: 'SERVER_NOT_READY', message: 'down' }) })
    second.pipeline.setEnabled(true)
    second.pipeline.beginDocument(DOC)
    second.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await second.pipeline.whenIdle()
    expect(second.failures).toEqual([])
    expect(second.results).toHaveLength(1)
  })

  it('a cache that throws never fails the image', async () => {
    const cache: PipelineCache = {
      lookup: () => {
        throw new Error('db locked')
      },
      store: () => {
        throw new Error('db locked')
      },
    }
    const h = setup({ cache })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.failures).toEqual([])
    expect(h.results).toHaveLength(1)
  })

  it('clearResults drops in-memory results so the cache is consulted again', async () => {
    const cache = memoryCache()
    const h = setup({ cache })
    h.pipeline.setEnabled(true)
    h.pipeline.beginDocument(DOC)
    h.pipeline.submit(batch([image('rr1', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    cache.rows.clear()
    h.pipeline.clearResults()
    h.pipeline.submit(batch([image('rr2', 'https://cdn.example/1.png')]))
    await h.pipeline.whenIdle()
    expect(h.detect).toHaveBeenCalledTimes(2)
  })
})
