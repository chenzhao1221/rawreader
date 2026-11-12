import type { Bbox } from './types'

/** Integer pixel rectangle. */
export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Grows `box` by `padding` pixels on every side, clips it to the image and
 * rounds outwards to whole pixels. Returns `null` when nothing is left.
 */
export function paddedRect(box: Pick<Bbox, 'x1' | 'y1' | 'x2' | 'y2'>, padding: number, imageW: number, imageH: number): PixelRect | null {
  const left = Math.max(0, Math.floor(Math.min(box.x1, box.x2) - padding))
  const top = Math.max(0, Math.floor(Math.min(box.y1, box.y2) - padding))
  const right = Math.min(imageW, Math.ceil(Math.max(box.x1, box.x2) + padding))
  const bottom = Math.min(imageH, Math.ceil(Math.max(box.y1, box.y2) + padding))
  const width = right - left
  const height = bottom - top
  if (width < 1 || height < 1) return null
  return { left, top, width, height }
}

/** Copies a rectangle out of an interleaved raw pixel buffer. */
export function cropRaw(data: Uint8Array, imageW: number, channels: number, rect: PixelRect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height * channels)
  const rowBytes = rect.width * channels
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.top + y) * imageW + rect.left) * channels
    out.set(data.subarray(start, start + rowBytes), y * rowBytes)
  }
  return out
}
