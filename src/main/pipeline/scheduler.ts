import { performance } from 'node:perf_hooks'
import PQueue from 'p-queue'
import type { PageImagesBatch, PipelineProgress } from '../../shared/ipc/contract'
import type { CaptureRequest, CaptureResult } from '../capture/capture'
import type { DetectService } from '../detect/service'
import type { DetectOk } from '../detect/protocol'
import type { Logger } from '../log/log'
import { hashPrefix } from '../log/redact'
import type { OcrResult } from '../ocr/client'
import type { TranslateRequest, TranslateResult } from '../translate/client'
import { ImageRegistry } from './state'
import type { Completion } from './state'
import type { ImageFailure, ImageResult, PageImage, StageTimings, Subscriber, UnitResult } from './types'

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
}

/** Persistent result store keyed by image content hash (the identity part of the key is the implementation's concern). */
export interface PipelineCache {
  lookup(hash: string): Pick<ImageResult, 'width' | 'height' | 'units'> | null
  store(hash: string, result: ImageResult): void
}

export interface PipelineDeps {
  settings(): PipelineSettings
  capture(request: CaptureRequest): Promise<CaptureResult>
  detect: DetectService
  ocr: { recognize(png: Uint8Array, signal?: AbortSignal): Promise<OcrResult> }
  translator: { translate(request: TranslateRequest): Promise<TranslateResult> }
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
}

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
        : { id: docId, pageUrl, controller: new AbortController(), seen: new Set(), total: 0, done: 0, failed: 0, active: 0 }
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
          result = await this.process(doc, captured.image, image.distance, timings)
          this.storeCache(hash, result)
        }
      } catch (error) {
        const failure = toFailure(error)
        const completion = this.registry.markIdle(hash, claim.token, failure)
        this.settleCompletion(doc, completion, subscriber, failure)
        return
      }
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

  private lookupCache(hash: string): ReturnType<PipelineCache['lookup']> {
    try {
      return this.deps.cache?.lookup(hash) ?? null
    } catch (error) {
      this.deps.logger.warn(`Cache lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private storeCache(hash: string, result: ImageResult): void {
    try {
      this.deps.cache?.store(hash, result)
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

  /** detect -> OCR -> translate for one set of bytes. */
  private async process(
    doc: DocState,
    image: { bytes: Uint8Array; hash: string; mime: string; source: 'cdp' | 'fetch' | 'data-url' },
    distance: number,
    timings: StageTimings,
  ): Promise<ImageResult> {
    const settings = this.deps.settings()

    const detectStart = performance.now()
    const detected = await this.stage(doc, 'detect', distance, () =>
      this.deps.detect.detect({
        bytes: image.bytes,
        ocrPadding: settings.ocrPadding,
        readingDirection: settings.readingDirection,
        maxBoxImageCoverage: settings.maxBoxImageCoverage,
      }),
    )
    timings.detectMs = performance.now() - detectStart
    if (!detected.ok) throw new StageFailure(detected.error.code, detected.error.message)
    const found: DetectOk = detected.result
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

    // Translate: one request per unit, in parallel up to the translation queue limit.
    const sources = texts.map((t) => t.text)
    const translateStart = performance.now()
    const outcomes = await Promise.all(
      work.map(async (_unit, index): Promise<{ translation: string; failed: boolean; echo: boolean }> => {
        if ((sources[index] ?? '').trim().length === 0) return { translation: '', failed: false, echo: false }
        const result = await this.stage(doc, 'translate', distance, () =>
          this.deps.translator.translate({ sources, index, signal: doc.controller.signal }),
        )
        return result.ok
          ? { translation: result.translation, failed: false, echo: result.echo }
          : { translation: '', failed: true, echo: false }
      }),
    )
    timings.translateMs = performance.now() - translateStart

    const workResults: UnitResult[] = work.map((unit, index) => {
      const ocr = texts[index] as { text: string; failed: boolean }
      const tr = outcomes[index] as { translation: string; failed: boolean; echo: boolean }
      let status: UnitResult['status'] = 'ok'
      if (ocr.failed) status = 'ocr-failed'
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

  /**
   * Runs `fn` on a stage queue with priority `-distance`. Rejects with
   * `Cancelled` when the document is aborted (queued or running) or when the
   * pipeline is disabled while the task is still queued.
   */
  private async stage<T>(doc: DocState, stage: Stage, distance: number, fn: () => Promise<T>): Promise<T> {
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
