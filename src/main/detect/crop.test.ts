import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { cropBoxesToUnits } from './crop'

const box = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, confidence: 1 })

async function png(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .png()
    .toBuffer()
  return new Uint8Array(buffer)
}

describe('cropBoxesToUnits', () => {
  it('returns the page size and one bubble-only unit per box with a padded PNG crop', async () => {
    const out = await cropBoxesToUnits(await png(100, 80), [box(10, 10, 30, 20), box(0, 0, 100, 80)], 4)
    expect([out.width, out.height]).toEqual([100, 80])
    expect(out.units.map((u) => [u.kind, u.bubbleOnly])).toEqual([
      ['bubble', true],
      ['bubble', true],
    ])
    const crop = out.units[0]?.ocrPng
    expect(crop).toBeInstanceOf(Uint8Array)
    const meta = await sharp(Buffer.from(crop as Uint8Array)).metadata()
    expect([meta.width, meta.height]).toEqual([28, 18])
    expect(out.units[0]?.drawBox).toEqual(box(10, 10, 30, 20))
  })

  it('gives a null crop for a box outside the image', async () => {
    const out = await cropBoxesToUnits(await png(50, 50), [box(200, 200, 220, 220)], 0)
    expect(out.units[0]?.ocrPng).toBeNull()
  })
})
