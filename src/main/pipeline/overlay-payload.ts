import type { OverlayResult } from '../../shared/ipc/contract'
import type { ImageResult, Subscriber } from './types'
import { looksLikeWatermark } from './watermark'
import { MAX_TEXT_BOX_IMAGE_COVERAGE, coversAtLeast } from '../detect/coverage'
import { looksLikeFormula } from '../ocr/garbled'

/**
 * Builds the message the browse preload draws from. Only units with a usable
 * translation are sent: failed, empty and echoed units stay out. The message
 * carries no image bytes and no source text, so nothing sensitive crosses to the page-adjacent side.
 */
export function toOverlayPayload(subscriber: Subscriber, result: ImageResult): OverlayResult {
  return {
    docId: subscriber.docId,
    elId: subscriber.elId,
    width: Math.max(1, Math.round(result.width)),
    height: Math.max(1, Math.round(result.height)),
    units: result.units
      .filter((unit) => unit.status === 'ok' && unit.translation.trim().length > 0)
      // Results cached before the watermark filter existed still carry translated stamps.
      .filter((unit) => !looksLikeWatermark(unit.ocrText))
      // Same for header logos read as one huge free-text box (cached before the text-box limit).
      .filter((unit) => unit.kind !== 'free' || !coversAtLeast(unit.drawBox, result.width, result.height, MAX_TEXT_BOX_IMAGE_COVERAGE))
      // And for OCR answers that were a formula instead of lettering (cached before the formula check).
      .filter((unit) => !looksLikeFormula(unit.ocrText))
      .map((unit) => ({
        kind: unit.kind,
        box: { x1: unit.drawBox.x1, y1: unit.drawBox.y1, x2: unit.drawBox.x2, y2: unit.drawBox.y2 },
        text: unit.translation.trim().slice(0, 2000),
      })),
  }
}
