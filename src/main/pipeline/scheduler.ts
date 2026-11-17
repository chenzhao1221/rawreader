import { performance } from 'node:perf_hooks'
import PQueue from 'p-queue'
import type { PageImagesBatch, PipelineProgress } from '../../shared/ipc/contract'
import type { CaptureRequest, CaptureResult } from '../capture/capture'
import { sha256Hex } from '../capture/hash'
import type { Bbox } from '../detect/types'
import type { DetectService } from '../detect/service'
import type { DetectOk } from '../detect/protocol'
import type { Logger } from '../log/log'
import { looksLikeWatermark } from './watermark'
import { hashPrefix } from '../log/redact'
import type { OcrResult } from '../ocr/client'
import type { TranslateRequest, TranslateResult } from '../translate/client'
import { ImageRegistry } from './state'
import type { Completion } from './state'
import type { ImageFailure, ImageResult, PageImage, StageTimings, Subscriber, TranslateContext, UnitResult } from './types'

/** Settings the scheduler reads each time it needs them. */
export interface PipelineSettings {
  maxImageBytes: number
  ocrConcurrency: number
  translateConcurrency: number
  readingDirection: 'ltr' | 'rtl'
  /** Detector boxes covering at least this share of the image are dropped. */
  maxBoxImageCoverage: number
  /** Pixels around each OCR crop (R7.1). */
  ocrPadding: number
  /** Upper bound on units per image; protects the servers from detector noise. */
  maxUnitsPerImage: number
  /** Skip free-text units: no OCR, no translation, nothing delivered for them. Read per image and per delivery. */
  bubblesOnly: boolean
  /** Who reads and translates. 'gemini' uses `deps.vision` and no local OCR. */
  engine: 'local' | 'openai' | 'gemini'
}

/** Persistent result store keyed by image content hash (the identity part of the key is the implementation's concern). */
export interface PipelineCache {
  /** `variant` joins the cache identity (a hash of the series context); absent for plain requests. */
  lookup(hash: string, variant?: string): Pick<ImageResult, 'width' | 'height' | 'units'> | null
  store(hash: string, result: ImageResult, variant?: string): void
}

export interface PipelineDeps {
  settings(): PipelineSettings
  capture(request: CaptureRequest): Promise<CaptureResult>
  detect: DetectService
  ocr: { recognize(png: Uint8Array, signal?: AbortSignal): Promise<OcrResult> }
  translator: {
    translate(request: TranslateRequest): Promise<TranslateResult>
    /** Optional: all bubbles of an image in one request; null entries are translated one by one. */
    translateBatch?(
      sources: readonly string[],
      signal?: AbortSignal,
      previous?: readonly { source: string; translation: string }[],
      background?: readonly string[],
    ): Promise<(string | null)[]>
  }
  /** Crops OCR images for caller-supplied boxes (bridge `boxes`), so detection is skipped. */
  cropBoxes?(bytes: Uint8Array, boxes: readonly Bbox[], padding: number): Promise<{ width: number; height: number; units: DetectOk['units'] }>
  /** Gemini one-stop mode: reads and translates crops itself (used when `settings().engine` is 'gemini'). */
  vision?: {
    readAndTranslate(crops: readonly (Uint8Array | null)[], signal?: AbortSignal): Promise<({ source: string; translation: string } | null)[]>
  }
  /** `null` when both servers can take requests, otherwise why not. */
  serversUnavailable(): { code: string; message: string } | null
  /** Delivers a finished image to one element. Called only while enabled and for the current document. */
  onResult(subscriber: Subscriber, result: ImageResult): void
  onFailure(subscriber: Subscriber, failure: ImageFailure): void
  onProgress(progress: PipelineProgress): void
  /** Optional persistent cache; a hit skips detection, OCR and translation. */
  cache?: PipelineCache
  logger: Logger
}

const CAPTURE_CONCURRENCY = 4

class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}

class StageFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'StageFailure'
  }
}

/** What a stage run needs from its owner: the signal that aborts queued and running work. */
interface Scope {
  controller: AbortController
}

/** Failure of `translateBytes`: `code` is `CANCELLED`, a stage code (`SERVER_NOT_READY`, `DETECT_FAILED` ...) or `INTERNAL`. */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}

/** Options of `Pipeline.translateBytes`. */
export interface TranslateBytesOptions {
  /** Larger runs first. Default 0. */
  priority?: number
  /** Aborts this caller's wait; the work stops when no caller is left. */
  signal?: AbortSignal
  /** Series background for the prompt. Results with a context are cached under their own identity. */
  context?: TranslateContext
  /** Caller-supplied regions: detection is skipped and the result is not cached. */
  boxes?: readonly Bbox[]
}

export type TranslateBytesResult = ImageResult & { cached: boolean }

interface BytesRun {
  promise: Promise<TranslateBytesResult>
  controller: AbortController
  waiters: number
}

interface DocState {
  id: string
  pageUrl: string
  /** Aborted on navigation: queued and running work of this document stops. */
  controller: AbortController
  /** `elId + url` pairs already accepted (enqueue once per page load, R5.3). */
  seen: Set<string>
  total: number
  done: number
  failed: number
  active: number
  /**
   * Last lines (source and translation) of images finished on this page, by document order. The
   * next image's batch prompt gets the previous image's lines, so a conversation running across
   * two images stays consistent.
   */
  tails: Map<number, { source: string; translation: string }[]>
}

/** How many lines of the previous image go into the next image's prompt. */
const TAIL_LINES = 3

type Stage = 'capture' | 'detect' | 'ocr' | 'translate'

/**
 * Orchestrates capture -> hash -> detect -> OCR -> translate (design section 8).
 *
 * - One p-queue per stage; priority is `-distance`, so the image nearest the viewport runs first.
 * - Work is keyed by content hash: the same bytes under two URLs run once and serve both elements.
 * - `beginDocument` (navigation) aborts everything of the old document and ignores its late results.
 * - `setEnabled(false)` cancels queued work only; running tasks finish but their results are not delivered.
 */
export class Pipeline {
  private readonly queues: Record<Stage, PQueue>
  private readonly registry = new ImageRegistry()
  private doc: DocState | null = null
  private enabled = false
  /** Aborted by `setEnabled(false)`: stops queued tasks, never running ones. */
  private queueController = new AbortController()
  private disposed = false
  /** In-flight `translateBytes` runs by `hash|contextHash`, so equal requests share one run. */
  private readonly bytesRuns = new Map<string, BytesRun>()
  private idleWaiters: Array<() => void> = []

  constructor(private readonly deps: PipelineDeps) {
    const settings = deps.settings()
    this.queues = {
      capture: new PQueue({ concurrency: CAPTURE_CONCURRENCY }),
      detect: new PQueue({ concurrency: 1 }),
      ocr: new PQueue({ concurrency: settings.ocrConcurrency }),
      translate: new PQueue({ concurrency: settings.translateConcurrency }),
    }
  }

  get registryForTests(): ImageRegistry {
    return this.registry
  }

  /** Re-reads concurrency from settings (config changed). */
  applySettings(): void {
    const settings = this.deps.settings()
    this.queues.ocr.concurrency = settings.ocrConcurrency
    this.queues.translate.concurrency = settings.translateConcurrency
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) {
      this.queueController = new AbortController()
    } else {
      // Queued tasks reject with Cancelled and their images go back to idle; running ones finish.
      this.queueController.abort(new Cancelled())
      this.emitProgress()
    }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Starts a new document and cancels the previous one. `null` just cancels. */
  beginDocument(docId: string | null, pageUrl = ''): void {
    const previous = this.doc
    if (previous) {
      previous.controller.abort(new Cancelled())
      this.registry.dropDocument(previous.id)
    }
    this.doc =
      docId === null
        ? null
        : { id: docId, pageUrl, controller: new AbortController(), seen: new Set(), total: 0, done: 0, failed: 0, active: 0, tails: new Map() }
    this.emitProgress()
  }

  /** Forgets in-memory results (the persistent cache was cleared). */
  clearResults(): void {
    this.registry.clear()
  }

  get currentDocId(): string | null {
    return this.doc?.id ?? null
  }

  /** Accepts images reported by the page. Returns how many were new. Stale document ids are dropped (R5.5). */
  submit(batch: PageImagesBatch): number {
    const doc = this.doc
    if (!this.enabled || this.disposed || !doc || doc.id !== batch.docId) return 0
    doc.pageUrl = batch.pageUrl

    let accepted = 0
    for (const image of batch.images) {
      const key = `${image.elId}\u0000${image.url}`
      if (doc.seen.has(key)) continue
      doc.seen.add(key)
      doc.total++
      doc.active++
      accepted++
      void this.runImage(doc, image)
    }
    if (accepted > 0) this.emitProgress()
    return accepted
  }

  /**
   * Bytes in, result out: the entry for callers that already hold the image (the Chrome extension bridge).
   * Runs hash -> cache -> detect -> OCR -> translate -> cache on the same stage queues and settings as the
   * browse view. It touches no document, no `submit` state and no delivery, and the auto-translate switch does
   * not gate it. Callers with the same bytes and context share one run.
   */
  translateBytes(bytes: Uint8Array, options: TranslateBytesOptions = {}): Promise<TranslateBytesResult> {
    if (this.disposed) return Promise.reject(new PipelineError('CANCELLED', 'pipeline is shut down'))
    const signal = options.signal
    if (signal?.aborted) return Promise.reject(new PipelineError('CANCELLED', 'cancelled'))
    const hash = sha256Hex(bytes)
    // Caller boxes make a one-off result: not shared, not cached.
    const key = options.boxes ? null : `${hash}|${options.context?.hash ?? ''}`
    let run = key ? this.bytesRuns.get(key) : undefined
    if (!run) {
      const controller = new AbortController()
      const created = { controller, waiters: 0 } as BytesRun
      created.promise = this.runBytes(controller, bytes, hash, options).finally(() => {
        if (key && this.bytesRuns.get(key) === created) this.bytesRuns.delete(key)
      })
      // The run's own failures are delivered to the waiters below; this keeps an abandoned run from being unhandled.
      created.promise.catch(() => {})
      if (key) this.bytesRuns.set(key, created)
      run = created
    }
    const shared = run
    shared.waiters++
    return new Promise<TranslateBytesResult>((resolve, reject) => {
      let settled = false
      const leave = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        shared.waiters--
      }
      const onAbort = (): void => {
        leave()
        if (shared.waiters === 0) shared.controller.abort(new Cancelled())
        reject(new PipelineError('CANCELLED', 'cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(
        (value) => {
          if (settled) return
          leave()
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          leave()
          const failure = toFailure(error)
          reject(new PipelineError(failure.code, failure.message))
        },
      )
    })
  }

  private async runBytes(
    controller: AbortController,
    bytes: Uint8Array,
    hash: string,
    options: TranslateBytesOptions,
  ): Promise<TranslateBytesResult> {
    const started = performance.now()
    const timings: StageTimings = { captureMs: 0, detectMs: 0, ocrMs: 0, translateMs: 0 }
    const scope: Scope = { controller }
    const variant = options.context?.hash
    const useCache = !options.boxes
    const settings = this.deps.settings()

    let stored = useCache ? this.lookupCache(hash, variant) : null
    if (stored && hasSkippedUnits(stored) && !settings.bubblesOnly) stored = null
    if (stored) {
      this.deps.logger.info(`bridge image ${hashPrefix(hash)} done (cache hit): units=${stored.units.length}`)
      return { hash, width: stored.width, height: stored.height, units: stored.units, timings, captureSource: 'bridge', cached: true }
    }

    const image = { bytes, hash, mime: '', source: 'bridge' as const }
    const result = await this.process(scope, image, -(options.priority ?? 0), timings, [], {
      ...(options.boxes ? { boxes: options.boxes } : {}),
      ...(options.context ? { background: options.context.background } : {}),
    })
    if (useCache) this.storeCache(hash, result, variant)
    this.deps.logger.info(
      `bridge image ${hashPrefix(hash)} done: units=${result.units.length} detect=${Math.round(timings.detectMs)}ms ` +
        `ocr=${Math.round(timings.ocrMs)}ms translate=${Math.round(timings.translateMs)}ms total=${Math.round(performance.now() - started)}ms`,
    )
    return { ...result, cached: false }
  }

  getProgress(): PipelineProgress {
    const doc = this.doc
    return doc
      ? { total: doc.total, done: doc.done, failed: doc.failed, active: doc.active }
      : { total: 0, done: 0, failed: 0, active: 0 }
  }

  /** Resolves when no image of the current document is active. */
  whenIdle(): Promise<void> {
    if (!this.doc || this.doc.active === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.beginDocument(null)
    for (const run of this.bytesRuns.values()) run.controller.abort(new Cancelled())
    for (const queue of Object.values(this.queues)) queue.clear()
    await this.deps.detect.dispose()
  }

  // -------------------------------------------------------------------------

  private async runImage(doc: DocState, image: PageImage): Promise<void> {
    const subscriber: Subscriber = { docId: doc.id, elId: image.elId }
    const started = performance.now()
    const timings: StageTimings = { captureMs: 0, detectMs: 0, ocrMs: 0, translateMs: 0 }
    try {
      const captureStart = performance.now()
      const captured = await this.stage(doc, 'capture', image.distance, () =>
        this.deps.capture({ url: image.url, pageUrl: doc.pageUrl, maxBytes: this.deps.settings().maxImageBytes }),
      )
      timings.captureMs = performance.now() - captureStart
      if (!captured.ok) throw new StageFailure(captured.code, captured.detail ?? 'capture failed')

      const { hash } = captured.image
      let claim = this.registry.claim(hash, subscriber)
      if (claim.kind === 'done' && hasSkippedUnits(claim.result) && !this.deps.settings().bubblesOnly) {
        // The kept result left free text out (bubbles-only was on); the setting is off now, so run it fully.
        this.registry.discardResult(hash)
        claim = this.registry.claim(hash, subscriber)
      }
      if (claim.kind === 'done') {
        // A result kept in memory from an earlier document (reload, back/forward, same bytes elsewhere) is a cache hit too.
        this.deps.logger.info(
          `image ${hashPrefix(hash)} done (cache hit): units=${claim.result.units.length} ` +
            `capture=${Math.round(timings.captureMs)}ms detect=0ms ocr=0ms translate=0ms ` +
            `total=${Math.round(performance.now() - started)}ms source=${captured.image.source} cache=memory`,
        )
        this.recordTail(doc, image.order, claim.result)
        this.settle(doc, [subscriber], claim.result, null)
        return
      }
      if (claim.kind === 'joined') {
        // The run that owns this hash delivers to us (and counts us) when it finishes.
        return
      }

      let result: ImageResult
      let cacheHit = false
      try {
        let stored = this.lookupCache(hash)
        // A row that skipped free text is incomplete once bubbles-only is off: treat it as a miss and overwrite it.
        if (stored && hasSkippedUnits(stored) && !this.deps.settings().bubblesOnly) stored = null
        if (stored) {
          cacheHit = true
          result = {
            hash,
            width: stored.width,
            height: stored.height,
            units: stored.units,
            timings,
            captureSource: captured.image.source,
          }
        } else {
          result = await this.process(doc, captured.image, image.distance, timings, this.previousTail(doc, image.order))
          this.storeCache(hash, result)
        }
      } catch (error) {
        const failure = toFailure(error)
        const completion = this.registry.markIdle(hash, claim.token, failure)
        this.settleCompletion(doc, completion, subscriber, failure)
        return
      }
      this.recordTail(doc, image.order, result)
      const completion = this.registry.markDone(hash, claim.token, result)
      this.settleCompletion(doc, completion, subscriber, null, result)
      this.deps.logger.info(
        `image ${hashPrefix(hash)} done${cacheHit ? ' (cache hit)' : ''}: units=${result.units.length} ` +
          `capture=${Math.round(timings.captureMs)}ms detect=${Math.round(timings.detectMs)}ms ` +
          `ocr=${Math.round(timings.ocrMs)}ms translate=${Math.round(timings.translateMs)}ms ` +
          `total=${Math.round(performance.now() - started)}ms source=${captured.image.source}` +
          (cacheHit ? ' cache=sqlite' : ''),
      )
    } catch (error) {
      this.settle(doc, [subscriber], null, toFailure(error))
    }
  }

  private lookupCache(hash: string, variant?: string): ReturnType<PipelineCache['lookup']> {
    try {
      return this.deps.cache?.lookup(hash, ...(variant ? [variant] : [])) ?? null
    } catch (error) {
      this.deps.logger.warn(`Cache lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private storeCache(hash: string, result: ImageResult, variant?: string): void {
    try {
      this.deps.cache?.store(hash, result, ...(variant ? [variant] : []))
    } catch (error) {
      this.deps.logger.warn(`Cache store failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Completion of a claimed run: notify every subscriber that is still on a live document. */
  private settleCompletion(
    doc: DocState,
    completion: Completion | null,
    owner: Subscriber,
    failure: ImageFailure | null,
    result: ImageResult | null = null,
  ): void {
    if (completion === null) {
      // Stale token: the document was dropped meanwhile. Only the owner's own counters remain.
      this.settle(doc, [owner], null, failure ?? { code: 'CANCELLED', message: 'cancelled' })
      return
    }
    this.settle(doc, completion.subscribers, result, failure)
  }

  private settle(doc: DocState, subscribers: Subscriber[], result: ImageResult | null, failure: ImageFailure | null): void {
    // Bubbles-only is applied when presenting, so stored and in-memory results keep their free units.
    const delivered = result && this.deps.settings().bubblesOnly ? withoutFreeUnits(result) : result
    for (const subscriber of subscribers) {
      const live = this.doc !== null && this.doc.id === subscriber.docId
      const target = live ? this.doc : null
      if (target) {
        target.active = Math.max(0, target.active - 1)
        if (result) target.done++
        else target.failed++
      }
      // Late results never reach a document that is gone, nor a disabled pipeline (R3.2, R5.5).
      if (!live || !this.enabled || this.disposed) continue
      if (delivered) this.deps.onResult(subscriber, delivered)
      else if (failure && failure.code !== 'CANCELLED') this.deps.onFailure(subscriber, failure)
    }
    if (doc === this.doc || this.doc === null) this.emitProgress()
    if (this.doc && this.doc.active === 0) {
      const waiters = this.idleWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  /** detect -> OCR -> translate for one set of bytes. `extras` is only set by `translateBytes`. */
  private async process(
    doc: Scope,
    image: { bytes: Uint8Array; hash: string; mime: string; source: ImageResult['captureSource'] },
    distance: number,
    timings: StageTimings,
    previous: readonly { source: string; translation: string }[] = [],
    extras: { boxes?: readonly Bbox[]; background?: readonly string[] } = {},
  ): Promise<ImageResult> {
    const settings = this.deps.settings()

    let found: DetectOk
    const detectStart = performance.now()
    if (extras.boxes) {
      // Caller-supplied regions: no detection, just crop them for OCR.
      const crop = this.deps.cropBoxes
      if (!crop) throw new StageFailure('CROP_UNAVAILABLE', 'Cropping caller boxes is not available')
      const cropped = await this.stage(doc, 'detect', distance, () => crop(image.bytes, extras.boxes as readonly Bbox[], settings.ocrPadding))
      found = { ...cropped, tiled: false, tileCount: 1, timings: { decodeMs: 0, inferMs: 0, cropMs: 0 } }
    } else {
      const detected = await this.stage(doc, 'detect', distance, () =>
        this.deps.detect.detect({
          bytes: image.bytes,
          ocrPadding: settings.ocrPadding,
          readingDirection: settings.readingDirection,
          maxBoxImageCoverage: settings.maxBoxImageCoverage,
        }),
      )
      if (!detected.ok) throw new StageFailure(detected.error.code, detected.error.message)
      found = detected.result
    }
    timings.detectMs = performance.now() - detectStart
    const units = found.units.slice(0, settings.maxUnitsPerImage)

    const base = {
      hash: image.hash,
      width: found.width,
      height: found.height,
      timings,
      captureSource: image.source,
    }
    if (units.length === 0) return { ...base, units: [] }

    // Bubbles-only: free units stay in the result as `skipped` and never reach OCR or translation.
    const skipFree = settings.bubblesOnly
    const work = skipFree ? units.filter((unit) => unit.kind !== 'free') : units
    if (work.length === 0) return { ...base, units: units.map(skippedUnit) }

    const unavailable = this.deps.serversUnavailable()
    if (unavailable) throw new StageFailure(unavailable.code, unavailable.message)

    let texts: { text: string; failed: boolean }[]
    let watermark: boolean[]
    let outcomes: { translation: string; failed: boolean; echo: boolean }[]
    const vision = this.deps.vision
    if (settings.engine === 'gemini' && vision) {
      // Gemini one-stop: it reads and translates all crops of the image in one go; no local OCR.
      const start = performance.now()
      const answers = await this.stage(doc, 'translate', distance, () =>
        vision.readAndTranslate(
          work.map((unit) => unit.ocrPng),
          doc.controller.signal,
        ),
      )
      timings.translateMs = performance.now() - start
      texts = answers.map((a) => (a ? { text: a.source, failed: false } : { text: '', failed: true }))
      watermark = texts.map((t) => !t.failed && looksLikeWatermark(t.text))
      outcomes = answers.map((a) => ({ translation: a?.translation ?? '', failed: a !== null && a.source !== '' && a.translation === '', echo: false }))
    } else {
      ;({ texts, watermark, outcomes } = await this.readAndTranslateLocally(doc, work, distance, timings, previous, extras.background))
    }

    const workResults: UnitResult[] = work.map((unit, index) => {
      const ocr = texts[index] as { text: string; failed: boolean }
      const tr = outcomes[index] as { translation: string; failed: boolean; echo: boolean }
      let status: UnitResult['status'] = 'ok'
      if (ocr.failed) status = 'ocr-failed'
      else if (watermark[index]) status = 'watermark'
      else if (ocr.text.trim().length === 0) status = 'no-text'
      else if (tr.failed) status = 'translate-failed'
      else if (tr.echo) status = 'echo'
      return {
        kind: unit.kind,
        bubbleOnly: unit.bubbleOnly,
        drawBox: unit.drawBox,
        ocrBox: unit.ocrBox,
        ocrText: ocr.text,
        translation: tr.translation,
        status,
      }
    })
    // Put skipped free units back at their detected positions.
    let next = 0
    const results = units.map((unit) => (skipFree && unit.kind === 'free' ? skippedUnit(unit) : (workResults[next++] as UnitResult)))
    return { ...base, units: results }
  }

  /** Local path: OCR each crop on the OCR server, then translate (whole image first, then bubble by bubble). */
  private async readAndTranslateLocally(
    doc: Scope,
    work: readonly DetectOk['units'][number][],
    distance: number,
    timings: StageTimings,
    previous: readonly { source: string; translation: string }[] = [],
    background: readonly string[] = [],
  ): Promise<{
    texts: { text: string; failed: boolean }[]
    watermark: boolean[]
    outcomes: { translation: string; failed: boolean; echo: boolean }[]
  }> {
    // OCR: one request per unit, bounded by the OCR queue.
    const ocrStart = performance.now()
    const texts = await Promise.all(
      work.map(async (unit): Promise<{ text: string; failed: boolean }> => {
        if (unit.ocrPng === null) return { text: '', failed: false }
        const ocrPng = unit.ocrPng
        const result = await this.stage(doc, 'ocr', distance, () => this.deps.ocr.recognize(ocrPng, doc.controller.signal))
        return result.ok ? { text: result.text, failed: false } : { text: '', failed: true }
      }),
    )
    timings.ocrMs = performance.now() - ocrStart

    // Scan-site stamps (a web address in the text) are dropped whole and kept out of the context too.
    const watermark = texts.map((t) => !t.failed && looksLikeWatermark(t.text))

    // Translate: one request per unit, in parallel up to the translation queue limit.
    const sources = texts.map((t, index) => (watermark[index] ? '' : t.text))
    const translateStart = performance.now()
    // Whole image first, in one numbered request; a bubble the batch answer missed goes on its own below.
    const filled = sources.filter((s) => s.trim().length > 0).length
    const batch = this.deps.translator.translateBatch
    const batched: readonly (string | null)[] =
      batch && filled >= 2
        ? await this.stage(doc, 'translate', distance, () =>
            background.length > 0 ? batch(sources, doc.controller.signal, previous, background) : batch(sources, doc.controller.signal, previous),
          )
        : []
    const outcomes = await Promise.all(
      work.map(async (_unit, index): Promise<{ translation: string; failed: boolean; echo: boolean }> => {
        if ((sources[index] ?? '').trim().length === 0) return { translation: '', failed: false, echo: false }
        const fromBatch = batched[index]
        if (typeof fromBatch === 'string' && fromBatch.length > 0) return { translation: fromBatch, failed: false, echo: false }
        const result = await this.stage(doc, 'translate', distance, () =>
          this.deps.translator.translate({ sources, index, signal: doc.controller.signal, ...(background.length > 0 ? { background } : {}) }),
        )
        return result.ok
          ? { translation: result.translation, failed: false, echo: result.echo }
          : { translation: '', failed: true, echo: false }
      }),
    )
    timings.translateMs = performance.now() - translateStart
    return { texts, watermark, outcomes }
  }

  /** Remembers the last translated lines of an image at document position `order`. */
  private recordTail(doc: DocState, order: number | undefined, result: ImageResult): void {
    if (order === undefined || this.doc !== doc) return
    const lines = result.units
      .filter((unit) => unit.status === 'ok' && unit.translation.trim().length > 0)
      .slice(-TAIL_LINES)
      .map((unit) => ({ source: unit.ocrText.trim(), translation: unit.translation.trim() }))
    if (lines.length > 0) doc.tails.set(order, lines)
  }

  /** The closest finished image above `order` (none when it is not done yet: no waiting). */
  private previousTail(doc: DocState, order: number | undefined): { source: string; translation: string }[] {
    if (order === undefined) return []
    let best = -1
    for (const key of doc.tails.keys()) if (key < order && key > best) best = key
    return best >= 0 ? (doc.tails.get(best) ?? []) : []
  }

  /**
   * Runs `fn` on a stage queue with priority `-distance`. Rejects with
   * `Cancelled` when the document is aborted (queued or running) or when the
   * pipeline is disabled while the task is still queued.
   */
  private async stage<T>(doc: Scope, stage: Stage, distance: number, fn: () => Promise<T>): Promise<T> {
    if (doc.controller.signal.aborted) throw new Cancelled()
    // Disabling auto-translate cancels work that has not started: capture is the admission stage.
    // An image that already passed capture runs to the end (R3.2); its result is kept but not delivered.
    const cancellableByDisable = stage === 'capture'
    if (cancellableByDisable && this.queueController.signal.aborted) throw new Cancelled()

    const taskController = new AbortController()
    let running = false
    const cancel = (): void => taskController.abort(new Cancelled())
    const onDoc = (): void => cancel()
    const onQueue = (): void => {
      if (!running) cancel()
    }
    doc.controller.signal.addEventListener('abort', onDoc, { once: true })
    const queueSignal = this.queueController.signal
    if (cancellableByDisable) queueSignal.addEventListener('abort', onQueue, { once: true })
    try {
      const value = await this.queues[stage].add(
        async () => {
          if (doc.controller.signal.aborted) throw new Cancelled()
          running = true
          return fn()
        },
        { priority: -distance, signal: taskController.signal },
      )
      return value as T
    } catch (error) {
      if (error instanceof Cancelled || taskController.signal.aborted) throw new Cancelled()
      throw error
    } finally {
      doc.controller.signal.removeEventListener('abort', onDoc)
      queueSignal.removeEventListener('abort', onQueue)
    }
  }

  private emitProgress(): void {
    this.deps.onProgress(this.getProgress())
  }
}

type DetectedUnit = DetectOk['units'][number]

/** A free unit that bubbles-only left out: geometry only, no text, never drawn. */
function skippedUnit(unit: DetectedUnit): UnitResult {
  return {
    kind: unit.kind,
    bubbleOnly: unit.bubbleOnly,
    drawBox: unit.drawBox,
    ocrBox: unit.ocrBox,
    ocrText: '',
    translation: '',
    status: 'skipped',
  }
}

/** True when a stored or kept result is incomplete because bubbles-only skipped some units. */
function hasSkippedUnits(result: { units: ReadonlyArray<{ status: string }> }): boolean {
  return result.units.some((unit) => unit.status === 'skipped')
}

/** The presented view of a result under bubbles-only: free units are neither OCR'd nor drawn. */
function withoutFreeUnits(result: ImageResult): ImageResult {
  return { ...result, units: result.units.filter((unit) => unit.kind !== 'free') }
}

function toFailure(error: unknown): ImageFailure {
  if (error instanceof Cancelled) return { code: 'CANCELLED', message: 'cancelled' }
  if (error instanceof StageFailure) return { code: error.code, message: error.message }
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}
