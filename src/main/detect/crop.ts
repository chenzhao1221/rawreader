import sharp from 'sharp'
import type { DetectOk } from './protocol'
import { cropRaw, paddedRect } from './raw'
import type { Bbox } from './types'

/**
 * Builds OCR units for boxes the caller already chose (the extension's drawn or edited regions), without
 * running the detector. Same decoding rules as detection: EXIF orientation applied, alpha flattened onto white.
 * Every box becomes a bubble-only unit (read as a whole, drawn in the same box), so bubbles-only mode never skips it.
 */
export async function cropBoxesToUnits(
  bytes: Uint8Array,
  boxes: readonly Bbox[],
  padding: number,
): Promise<{ width: number; height: number; units: DetectOk['units'] }> {
  const { data, info } = await sharp(bytes, { failOn: 'none' })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const units = await Promise.all(
    boxes.map(async (box) => {
      const rect = paddedRect(box, padding, info.width, info.height)
      let ocrPng: Uint8Array | null = null
      if (rect) {
        const crop = cropRaw(pixels, info.width, info.channels, rect)
        const png = await sharp(crop, { raw: { width: rect.width, height: rect.height, channels: 3 } })
          .png()
          .toBuffer()
        ocrPng = new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
      }
      return { kind: 'bubble' as const, bubbleOnly: true, drawBox: box, ocrBox: box, ocrPng }
    }),
  )
  return { width: info.width, height: info.height, units }
}
