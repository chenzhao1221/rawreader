import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Detector, cropToPng, decodeToRaw } from './detector'

// Integration test with the bundled int8 detector and the synthetic SFW panel. No Electron, no servers.
const root = join(import.meta.dirname, '../../..')
const modelPath = join(root, 'resources/detector/detector-v4-s_int8.onnx')
const panel = new Uint8Array(readFileSync(join(root, 'fixtures/smoke/panel.png')))

describe('Detector (onnxruntime-node + sharp)', () => {
  let detector: Detector
  beforeAll(async () => {
    detector = await Detector.create(modelPath)
  }, 60_000)
  afterAll(async () => {
    await detector?.dispose()
  })

  it('decodes the panel to RGB', async () => {
    const raw = await decodeToRaw(panel)
    expect(raw.width).toBe(800)
    expect(raw.height).toBe(1100)
    expect(raw.data.length).toBe(800 * 1100 * 3)
  })

  it('detects at least one unit on the panel and returns boxes inside the image', async () => {
    const { image, result } = await detector.detect(panel)
    expect(result.tiled).toBe(false)
    expect(result.units.length).toBeGreaterThan(0)
    for (const unit of result.units) {
      for (const box of [unit.drawBox, unit.ocrBox]) {
        expect(box.x1).toBeGreaterThanOrEqual(0)
        expect(box.y1).toBeGreaterThanOrEqual(0)
        expect(box.x2).toBeLessThanOrEqual(image.width)
        expect(box.y2).toBeLessThanOrEqual(image.height)
        expect(box.x2).toBeGreaterThan(box.x1)
      }
    }
  }, 60_000)

  it('tiles a tall strip and finds boxes in page coordinates', async () => {
    // Stack the panel three times: 800 x 3300, which must take the tiled path.
    const strip = await sharp({
      create: { width: 800, height: 3300, channels: 3, background: '#ffffff' },
    })
      .composite([0, 1, 2].map((i) => ({ input: Buffer.from(panel), top: i * 1100, left: 0 })))
      .png()
      .toBuffer()
    const { result } = await detector.detect(new Uint8Array(strip))
    expect(result.tiled).toBe(true)
    expect(result.tileCount).toBeGreaterThan(2)
    expect(result.units.length).toBeGreaterThan(0)
    expect(Math.max(...result.units.map((u) => u.drawBox.y2))).toBeGreaterThan(1100)
  }, 120_000)

  it('crops a padded region as PNG', async () => {
    const raw = await decodeToRaw(panel)
    const png = await cropToPng(raw, { x1: 100, y1: 100, x2: 200, y2: 180, confidence: 1 }, 8)
    expect(png).not.toBeNull()
    const meta = await sharp(png!).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(116)
    expect(meta.height).toBe(96)
    expect(await cropToPng(raw, { x1: 2000, y1: 2000, x2: 2100, y2: 2100, confidence: 1 }, 8)).toBeNull()
  })
})
