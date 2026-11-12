// Portions ported from libre-manga-translator src/lib/detections/rtdetr.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: only the pure parts are here (tensor layout, output decoding, tile offsetting and
// post-processing). Canvas/ImageBitmap/onnxruntime-web code is replaced by sharp + onnxruntime-node in
// detector.ts. The selection `textBoxes.length > 0 ? textBoxes : bubbleBoxes` is NOT ported: both groups
// are returned so that bubble-only boxes are kept and OCR'd as a whole bubble (R6.4).

import { refineDetections } from './boxes'
import type { DetectionTile } from './tiling'
import { mergeTiledBoxes } from './tiling'
import type { Bbox, DetectedGroups } from './types'
import { containmentNMS, restoreBoundingBox } from './utils'

/**
 * RT-DETR-v2 wrapper constants for `ogkalu/comic-text-and-bubble-detector`
 * (`detector-v4-s_int8.onnx`, Apache-2.0). Classes: 0 bubble, 1 text_bubble, 2 text_free.
 *
 * Aspect-preserving policy: centre-letterbox every page into 640x640 instead of
 * squeezing x and y independently. The model returns boxes in that square frame
 * and `restoreBoundingBox` removes the padding exactly once.
 */
export const INPUT_SIZE = 640
export const DEFAULT_MIN_CONFIDENCE = 0.35
export const LABEL_BUBBLE = 0
export const LABEL_TEXT_BUBBLE = 1
export const LABEL_TEXT_FREE = 2
/** Letterbox padding colour (grey), as in LMT. */
export const LETTERBOX_FILL = 114

/** Interleaved RGB bytes (size x size x 3) to the planar float32 CHW tensor data in [0, 1]. */
export function rgbToChw(rgb: Uint8Array, size: number): Float32Array {
  const plane = size * size
  const out = new Float32Array(3 * plane)
  const inv255 = 1.0 / 255.0
  for (let i = 0; i < plane; i++) {
    const idx = i * 3
    out[i] = (rgb[idx] as number) * inv255
    out[plane + i] = (rgb[idx + 1] as number) * inv255
    out[plane * 2 + i] = (rgb[idx + 2] as number) * inv255
  }
  return out
}

export interface RawDetectorOutputs {
  labels: ArrayLike<number | bigint>
  /** Flat x1,y1,x2,y2 per detection, in letterboxed square coordinates. */
  boxes: ArrayLike<number>
  scores: ArrayLike<number>
}

/** Converts raw model outputs into text and bubble boxes in the coordinates of the (tile) image. */
export function decodeRtDetrOutputs(
  outputs: RawDetectorOutputs,
  origWidth: number,
  origHeight: number,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  inputSize = INPUT_SIZE,
): DetectedGroups {
  const textBoxes: Bbox[] = []
  const bubbleBoxes: Bbox[] = []
  const count = Math.min(outputs.labels.length, outputs.scores.length, Math.floor(outputs.boxes.length / 4))

  for (let i = 0; i < count; i++) {
    const score = outputs.scores[i] as number
    if (score < minConfidence) continue
    const label = Number(outputs.labels[i])

    const letterboxed = restoreBoundingBox(
      {
        x1: outputs.boxes[i * 4] as number,
        y1: outputs.boxes[i * 4 + 1] as number,
        x2: outputs.boxes[i * 4 + 2] as number,
        y2: outputs.boxes[i * 4 + 3] as number,
        confidence: score,
      },
      origWidth,
      origHeight,
      inputSize,
    )

    const x1 = Math.max(0, Math.min(origWidth, letterboxed.x1))
    const y1 = Math.max(0, Math.min(origHeight, letterboxed.y1))
    const x2 = Math.max(0, Math.min(origWidth, letterboxed.x2))
    const y2 = Math.max(0, Math.min(origHeight, letterboxed.y2))
    if (x2 - x1 < 4 || y2 - y1 < 4) continue

    const box: Bbox = { x1, y1, x2, y2, confidence: score }
    if (label === LABEL_TEXT_BUBBLE || label === LABEL_TEXT_FREE) textBoxes.push(box)
    else if (label === LABEL_BUBBLE) bubbleBoxes.push(box)
  }

  return { textBoxes, bubbleBoxes }
}

/** Moves tile-local boxes into page coordinates and clamps them to the page. */
export function offsetBoxes(boxes: Bbox[], tile: DetectionTile, pageW: number, pageH: number): Bbox[] {
  return boxes.map((b) => ({
    x1: Math.max(0, Math.min(pageW, b.x1 + tile.x)),
    y1: Math.max(0, Math.min(pageH, b.y1 + tile.y)),
    x2: Math.max(0, Math.min(pageW, b.x2 + tile.x)),
    y2: Math.max(0, Math.min(pageH, b.y2 + tile.y)),
    confidence: b.confidence,
  }))
}

/**
 * Post-processing of the collected per-tile (or single-pass) boxes.
 * Text boxes: seam merge when tiled, containment NMS, then the LMT region build.
 * Bubble boxes: seam merge when tiled and containment NMS only. They are never
 * discarded because text boxes exist.
 */
export function finalizeDetections(raw: DetectedGroups, pageW: number, pageH: number, tiled: boolean): DetectedGroups {
  const text = tiled ? mergeTiledBoxes(raw.textBoxes) : raw.textBoxes
  const bubbles = tiled ? mergeTiledBoxes(raw.bubbleBoxes) : raw.bubbleBoxes
  return {
    textBoxes: refineDetections(containmentNMS(text), pageW, pageH).boxes,
    bubbleBoxes: containmentNMS(bubbles),
  }
}
