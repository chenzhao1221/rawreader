// Portions ported from libre-manga-translator src/lib/detections/utils.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: `scalingImage` (OffscreenCanvas letterboxing) is replaced by the pure
// `letterboxLayout` geometry plus sharp in detector.ts; `restoreBoundingBox` and `containmentNMS`
// are ported with typed inputs.

import type { Bbox } from './types'

export interface LetterboxLayout {
  scale: number
  /** Scaled content size in pixels (rounded, at least 1). */
  newWidth: number
  newHeight: number
  /** Padding added on each side so the content is centred in the square. */
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Aspect-preserving letterbox of a `width` x `height` image into a square of
 * `modelSize`. Replaces the canvas math of LMT `scalingImage`.
 */
export function letterboxLayout(width: number, height: number, modelSize: number): LetterboxLayout {
  const scale = Math.min(modelSize / width, modelSize / height)
  const newWidth = Math.max(1, Math.min(modelSize, Math.round(width * scale)))
  const newHeight = Math.max(1, Math.min(modelSize, Math.round(height * scale)))
  const left = Math.floor((modelSize - newWidth) / 2)
  const top = Math.floor((modelSize - newHeight) / 2)
  return { scale, newWidth, newHeight, left, top, right: modelSize - newWidth - left, bottom: modelSize - newHeight - top }
}

/** Removes the letterbox padding and scale: letterboxed square coordinates back to the original image. */
export function restoreBoundingBox(bbox: Bbox, origWidth: number, origHeight: number, modelSize = 1280): Bbox {
  const gain = Math.min(modelSize / origWidth, modelSize / origHeight)
  const padX = (modelSize - origWidth * gain) / 2
  const padY = (modelSize - origHeight * gain) / 2

  return {
    ...bbox,
    x1: (bbox.x1 - padX) / gain,
    y1: (bbox.y1 - padY) / gain,
    x2: (bbox.x2 - padX) / gain,
    y2: (bbox.y2 - padY) / gain,
  }
}

/** Drops a box when more than `threshold` of its area is covered by a stronger kept box. */
export function containmentNMS(detections: Bbox[], threshold = 0.85): Bbox[] {
  // Sort by confidence descending so we keep the stronger box.
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
  const keep: Bbox[] = []

  for (const box of sorted) {
    const boxArea = (box.x2 - box.x1) * (box.y2 - box.y1)

    const suppressed = keep.some((kept) => {
      const ix1 = Math.max(box.x1, kept.x1)
      const iy1 = Math.max(box.y1, kept.y1)
      const ix2 = Math.min(box.x2, kept.x2)
      const iy2 = Math.min(box.y2, kept.y2)

      if (ix2 <= ix1 || iy2 <= iy1) return false

      const interArea = (ix2 - ix1) * (iy2 - iy1)
      // What fraction of THIS box is covered by the kept box.
      return interArea / boxArea > threshold
    })

    if (!suppressed) keep.push(box)
  }

  return keep
}
