import { describe, expect, it, vi } from 'vitest'
import type { DetectJob, DetectOutcome } from '../detect/service'
import { silentLogger } from '../log/log'
import type { TranslateRequest, TranslateResult } from '../translate/client'
import { Pipeline, PipelineError } from './scheduler'
import type { PipelineCache, PipelineDeps, PipelineSettings } from './scheduler'
import type { ImageResult } from './types'

const sleep = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
        bubbleOnly: false,
        drawBox: box(10, 100 * i, 200, 100 * i + 80),
        ocrBox: box(20, 100 * i + 10, 190, 100 * i + 70),
        ocrPng: Uint8Array.from([0x89, 0x50, i]),
      })),
      timings: { decodeMs: 1, inferMs: 1, cropMs: 1 },
    },
  }
}

/** In-memory cache that records the variants it was asked for. */
function memoryCache() {
  const rows = new Map<string, Pick<ImageResult, 'width' | 'height' | 'units'>>()
  const key = (hash: string, variant?: string): string => `${hash}|${variant ?? ''}`
  const lookup = vi.fn((hash: string, variant?: string) => rows.get(key(hash, variant)) ?? null)
  const store = vi.fn((hash: string, result: ImageResult, variant?: string) => {
    rows.set(key(hash, variant), { width: result.width, height: result.height, units: result.units })
  })
  const cache: PipelineCache = { lookup, store }
  return { cache, lookup, store, rows }
}

function setup(overrides: { detect?: (job: DetectJob) => Promise<DetectOutcome>; cache?: PipelineCache; settings?: Partial<PipelineSettings>; unavailable?: boolean } = {}) {
  const settings: PipelineSettings = {
    maxImageBytes: 1_000_000,
    ocrConcurrency: 2,
    translateConcurrency: 2,
    readingDirection: 'ltr',
    maxBoxImageCoverage: 0.85,
    ocrPadding: 8,
    maxUnitsPerImage: 50,
    bubblesOnly: false,
    engine: 'local',
    ...overrides.settings,
  }
  const detect = vi.fn(overrides.detect ?? (() => Promise.resolve(detectOk())))
  const ocr = vi.fn((png: Uint8Array) => Promise.resolve({ ok: true as const, text: `text-${png[2]}` }))
  const translate = vi.fn(
    (request: TranslateRequest): Promise<TranslateResult> =>
      Promise.resolve({ ok: true, translation: `zh(${request.sources[request.index]})`, echo: false, retriedBare: false, prompt: 'p' }),
  )
  const translateBatch = vi.fn((sources: readonly string[], _signal?: AbortSignal, _previous?: readonly unknown[], _background?: readonly string[]) =>
    Promise.resolve(sources.map(() => null)),
  )
  const cropBoxes = vi.fn((_bytes: Uint8Array, boxes: readonly ReturnType<typeof box>[]) =>
    Promise.resolve({
      width: 640,
      height: 480,
      units: boxes.map((b, i) => ({ kind: 'bubble' as const, bubbleOnly: true, drawBox: b, ocrBox: b, ocrPng: Uint8Array.from([0x89, 0x50, i + 5]) })),
    }),
  )
  const onResult = vi.fn()
  const deps: PipelineDeps = {
    settings: () => settings,
    capture: () => Promise.reject(new Error('capture must not run for bridge work')),
    detect: { detect, dispose: () => Promise.resolve() },
    ocr: { recognize: (png) => ocr(png) },
    translator: { translate: (request) => translate(request), translateBatch },
    cropBoxes,
    serversUnavailable: () => (overrides.unavailable ? { code: 'SERVER_NOT_READY', message: 'ocr server is not ready' } : null),
    onResult,
    onFailure: vi.fn(),
    onProgress: vi.fn(),
    ...(overrides.cache ? { cache: overrides.cache } : {}),
    logger: silentLogger,
  }
  const pipeline = new Pipeline(deps)
  return { pipeline, detect, ocr, translate, translateBatch, cropBoxes, onResult }
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

describe('Pipeline.translateBytes', () => {
  it('runs detect, OCR and translate on the bytes without capture, a document or the auto-translate switch', async () => {
    const h = setup()
    expect(h.pipeline.isEnabled).toBe(false)
    const result = await h.pipeline.translateBytes(bytes(1, 2, 3))
    expect(result.cached).toBe(false)
    expect(result.captureSource).toBe('bridge')
    expect(result.units.map((u) => [u.ocrText, u.translation, u.status])).toEqual([
      ['text-0', 'zh(text-0)', 'ok'],
      ['text-1', 'zh(text-1)', 'ok'],
    ])
    expect(h.onResult).not.toHaveBeenCalled()
    expect(h.pipeline.getProgress()).toEqual({ total: 0, done: 0, failed: 0, active: 0 })
  })

  it('stores the result and answers the next identical request from the cache without any stage', async () => {
    const { cache, store, lookup } = memoryCache()
    const h = setup({ cache })
    const first = await h.pipeline.translateBytes(bytes(1, 2, 3))
    expect(store).toHaveBeenCalledTimes(1)
    expect(store.mock.calls[0]?.[0]).toBe(first.hash)

    const second = await h.pipeline.translateBytes(bytes(1, 2, 3))
    expect(second.cached).toBe(true)
    expect(second.units).toEqual(first.units)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(h.detect).toHaveBeenCalledTimes(1)
    expect(h.ocr).toHaveBeenCalledTimes(2)
  })

  it('shares the plain (no context) cache entry with the desktop: no variant is passed', async () => {
    const { cache, store, lookup } = memoryCache()
    const h = setup({ cache })
    await h.pipeline.translateBytes(bytes(9, 9, 9))
    expect(lookup.mock.calls[0]).toEqual([expect.any(String)])
    expect(store.mock.calls[0]).toHaveLength(2)
  })

  it('keeps results with different series context apart and hands the background to the translator', async () => {
    const { cache, store } = memoryCache()
    const h = setup({ cache, settings: { ocrConcurrency: 1 } })
    const a = { hash: 'ctxA', background: ['作品：A'] }
    const b = { hash: 'ctxB', background: ['作品：B'] }
    await h.pipeline.translateBytes(bytes(5, 5, 5), { context: a })
    await h.pipeline.translateBytes(bytes(5, 5, 5), { context: b })
    await h.pipeline.translateBytes(bytes(5, 5, 5))
    expect(store.mock.calls.map((c) => c[2])).toEqual(['ctxA', 'ctxB', undefined])
    expect(h.detect).toHaveBeenCalledTimes(3)
    // batch is offered first (the fake gives no answers), so the background is passed to both paths.
    expect(h.translateBatch.mock.calls[0]?.[3]).toEqual(['作品：A'])
    expect(h.translate.mock.calls.some((c) => (c[0] as TranslateRequest).background?.[0] === '作品：A')).toBe(true)
    expect(h.translate.mock.calls.filter((c) => (c[0] as TranslateRequest).background === undefined)).not.toHaveLength(0)

    // Same context again is a hit.
    const again = await h.pipeline.translateBytes(bytes(5, 5, 5), { context: a })
    expect(again.cached).toBe(true)
  })

  it('skips detection for caller boxes, crops them instead, and does not touch the cache', async () => {
    const { cache, store, lookup } = memoryCache()
    const h = setup({ cache })
    const boxes = [box(5, 5, 50, 40), box(60, 60, 120, 100)]
    const result = await h.pipeline.translateBytes(bytes(7, 7, 7), { boxes })
    expect(h.detect).not.toHaveBeenCalled()
    expect(h.cropBoxes).toHaveBeenCalledWith(expect.any(Uint8Array), boxes, 8)
    expect([result.width, result.height]).toEqual([640, 480])
    expect(result.units.map((u) => u.drawBox)).toEqual(boxes)
    expect(result.units.map((u) => u.translation)).toEqual(['zh(text-5)', 'zh(text-6)'])
    expect(lookup).not.toHaveBeenCalled()
    expect(store).not.toHaveBeenCalled()
  })

  it('runs equal requests in flight once', async () => {
    const gate = deferred()
    const h = setup({ detect: async () => (await gate.promise, detectOk(1)) })
    const a = h.pipeline.translateBytes(bytes(4, 4, 4))
    const b = h.pipeline.translateBytes(bytes(4, 4, 4))
    await sleep()
    gate.resolve()
    const [ra, rb] = await Promise.all([a, b])
    expect(h.detect).toHaveBeenCalledTimes(1)
    expect(ra.units).toEqual(rb.units)
  })

  it('rejects with CANCELLED when the caller aborts, and stops the work once nobody waits for it', async () => {
    const gate = deferred()
    let ocrCalled = false
    const h = setup({ detect: async () => (await gate.promise, detectOk(1)) })
    h.ocr.mockImplementation(() => {
      ocrCalled = true
      return Promise.resolve({ ok: true as const, text: 'x' })
    })
    const first = new AbortController()
    const second = new AbortController()
    const a = h.pipeline.translateBytes(bytes(3, 3, 3), { signal: first.signal })
    const b = h.pipeline.translateBytes(bytes(3, 3, 3), { signal: second.signal })
    await sleep()
    first.abort()
    await expect(a).rejects.toMatchObject({ code: 'CANCELLED' })
    // One waiter is left: the run continues for it.
    second.abort()
    await expect(b).rejects.toMatchObject({ code: 'CANCELLED' })
    gate.resolve()
    await sleep(30)
    expect(ocrCalled).toBe(false)
  })

  it('rejects at once when the signal is already aborted, without any stage', async () => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(h.pipeline.translateBytes(bytes(1, 1, 1), { signal: controller.signal })).rejects.toBeInstanceOf(PipelineError)
    expect(h.detect).not.toHaveBeenCalled()
  })

  it('serves higher priority first on the shared queue', async () => {
    const gate = deferred()
    const order: number[] = []
    let calls = 0
    const h = setup({
      detect: async (job) => {
        calls++
        if (calls === 1) await gate.promise
        order.push(job.bytes[0] as number)
        return detectOk(1)
      },
    })
    const blocker = h.pipeline.translateBytes(bytes(100, 0, 0))
    await sleep()
    const low = h.pipeline.translateBytes(bytes(1, 0, 0), { priority: -5 })
    const high = h.pipeline.translateBytes(bytes(2, 0, 0), { priority: 5 })
    const normal = h.pipeline.translateBytes(bytes(3, 0, 0))
    await sleep()
    gate.resolve()
    await Promise.all([blocker, low, high, normal])
    expect(order).toEqual([100, 2, 3, 1])
  })

  it('fails with the engine code when a server is not ready, and leaves failed units out of the cache', async () => {
    const { cache, store } = memoryCache()
    const h = setup({ cache, unavailable: true })
    await expect(h.pipeline.translateBytes(bytes(8, 8, 8))).rejects.toMatchObject({ code: 'SERVER_NOT_READY' })
    expect(store).not.toHaveBeenCalled()
  })

  it('rejects after dispose', async () => {
    const h = setup()
    await h.pipeline.dispose()
    await expect(h.pipeline.translateBytes(bytes(1, 2, 3))).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
