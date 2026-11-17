import type { PageImage } from '../../shared/ipc/contract'
import type { Bbox } from '../detect/types'

export type { PageImage }

/**
 * skipped marks a unit the pipeline deliberately left alone (free text while bubbles-only is on). The unit is
 * still detected and stored, so turning the setting off later can fill it in.
 */
export type UnitStatus = 'ok' | 'no-text' | 'ocr-failed' | 'translate-failed' | 'echo' | 'skipped' | 'watermark'

/** One translated region of an image. */
export interface UnitResult {
  kind: 'bubble' | 'free'
  bubbleOnly: boolean
  drawBox: Bbox
  ocrBox: Bbox
  ocrText: string
  translation: string
  status: UnitStatus
}

export interface StageTimings {
  captureMs: number
  detectMs: number
  ocrMs: number
  translateMs: number
}

/** Everything the overlay will need for one image. Contains no image bytes. */
export interface ImageResult {
  hash: string
  width: number
  height: number
  units: UnitResult[]
  timings: StageTimings
  captureSource: 'cdp' | 'fetch' | 'data-url' | 'bridge'
}

/** Series background a bridge request adds to the translation prompt. `hash` joins the cache identity. */
export interface TranslateContext {
  /** Prompt lines (series name, summary, glossary), already capped in bytes. */
  background: readonly string[]
  hash: string
}

/** Where a page image is in the pipeline (requirements R5.7: pending, then done or error). */
export type ImageState = 'idle' | 'pending' | 'done' | 'error' | 'cancelled'

export interface ImageFailure {
  code: string
  message: string
}

/** Identifies one `<img>` element of one document. */
export interface Subscriber {
  docId: string
  elId: string
}
