import { describe, expect, it } from 'vitest'
import { PAGE_WITH_BUBBLE_ONLY, SEAM_TEXT_TILE_A, SEAM_TEXT_TILE_B, STRIP } from './__fixtures__/strip'
import { refineDetections } from './boxes'
import { decodeRtDetrOutputs, finalizeDetections, offsetBoxes, rgbToChw } from './rtdetr'
import { computeTileOrigins, mergeTiledBoxes, planDetectionTiles, shouldTile } from './tiling'
import { buildUnits } from './units'
import { containmentNMS, letterboxLayout, restoreBoundingBox } from './utils'

describe('tile planning', () => {
  it('does not tile a normal manga page', () => {
    expect(shouldTile(900, 1300)).toBe(false)
    expect(shouldTile(1000, 1700)).toBe(false) // aspect 1.7, below 1.8
  })

  it('tiles tall strips and very large pages', () => {
    expect(shouldTile(800, 3000)).toBe(true)
    expect(shouldTile(900, 1800)).toBe(true) // aspect exactly 2
    expect(shouldTile(2400, 2200)).toBe(true) // large side
    expect(shouldTile(0, 100)).toBe(false)
  })

  it('plans overlapping full-width tiles for a tall strip', () => {
    const tiles = planDetectionTiles(STRIP.width, STRIP.height)
    expect(tiles).toEqual(STRIP.expectedTiles)
    for (let i = 1; i < tiles.length; i++) {
      const previous = tiles[i - 1]!
      const overlap = previous.y + previous.h - tiles[i]!.y
      expect(overlap).toBeGreaterThanOrEqual(200)
    }
    const last = tiles[tiles.length - 1]!
    expect(last.y + last.h).toBe(STRIP.height)
  })

  it('returns one span when the axis fits in a tile', () => {
    expect(computeTileOrigins(800, 1000, 200)).toEqual([{ start: 0, size: 800 }])
    expect(computeTileOrigins(1000, 1000, 200)).toEqual([{ start: 0, size: 1000 }])
  })

  it('covers a 25000 px strip without gaps', () => {
    const tiles = planDetectionTiles(720, 25000)
    expect(tiles[0]!.y).toBe(0)
    expect(tiles[tiles.length - 1]!.y + 1000).toBe(25000)
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i]!.y).toBeLessThanOrEqual(tiles[i - 1]!.y + 800)
    }
  })

  it('plans a 2-D grid for pages wider than a tile', () => {
    const tiles = planDetectionTiles(2400, 1000)
    expect(tiles.length).toBe(3)
    expect(new Set(tiles.map((t) => t.y))).toEqual(new Set([0]))
  })
})

describe('letterbox and box restore', () => {
  it('centres a tall image in the square', () => {
    const layout = letterboxLayout(800, 1000, 640)
    expect(layout).toMatchObject({ newWidth: 512, newHeight: 640, left: 64, top: 0, right: 64, bottom: 0 })
    const strip = letterboxLayout(800, 3000, 640)
    expect(strip.newHeight).toBe(640)
    expect(strip.left + strip.newWidth + strip.right).toBe(640)
  })

  it('restores a letterboxed box to original coordinates', () => {
    // 800x1000 page in a 640 square: gain 0.64, padX 64, padY 0.
    const restored = restoreBoundingBox({ x1: 128, y1: 64, x2: 320, y2: 192, confidence: 0.9 }, 800, 1000, 640)
    expect(restored.x1).toBeCloseTo(100)
    expect(restored.y1).toBeCloseTo(100)
    expect(restored.x2).toBeCloseTo(400)
    expect(restored.y2).toBeCloseTo(300)
    expect(restored.confidence).toBe(0.9)
  })

  it('restores wide images with vertical padding', () => {
    // 1000x500 in 640: gain 0.64, padX 0, padY 160.
    const restored = restoreBoundingBox({ x1: 64, y1: 224, x2: 128, y2: 288, confidence: 1 }, 1000, 500, 640)
    expect(restored).toMatchObject({ x1: 100, y1: 100, x2: 200, y2: 200 })
  })
})

describe('decodeRtDetrOutputs', () => {
  it('maps labels to groups, restores boxes and applies the score and size filters', () => {
    const outputs = {
      labels: BigInt64Array.from([0n, 1n, 2n, 1n, 0n]),
      scores: Float32Array.from([0.9, 0.8, 0.7, 0.2, 0.9]),
      boxes: Float32Array.from([
        128, 64, 320, 192, // bubble -> (100,100)-(400,300)
        150, 100, 250, 150, // text_bubble
        300, 300, 400, 340, // text_free
        200, 200, 300, 300, // below confidence
        400, 400, 402, 402, // too small once restored
      ]),
    }
    const groups = decodeRtDetrOutputs(outputs, 800, 1000, 0.35, 640)
    expect(groups.bubbleBoxes).toHaveLength(1)
    expect(groups.bubbleBoxes[0]).toMatchObject({ x1: 100, y1: 100, x2: 400, y2: 300 })
    expect(groups.textBoxes).toHaveLength(2)
  })

  it('keeps bubble boxes when text boxes exist (no LMT drop)', () => {
    const outputs = {
      labels: [0, 1],
      scores: [0.9, 0.9],
      boxes: [128, 64, 320, 192, 160, 90, 280, 150],
    }
    const groups = decodeRtDetrOutputs(outputs, 800, 1000, 0.35, 640)
    expect(groups.bubbleBoxes.length).toBe(1)
    expect(groups.textBoxes.length).toBe(1)
  })

  it('clamps boxes to the image', () => {
    const groups = decodeRtDetrOutputs({ labels: [0], scores: [0.9], boxes: [0, 0, 640, 640] }, 800, 1000, 0.35, 640)
    const b = groups.bubbleBoxes[0]!
    expect(b.x1).toBe(0)
    expect(b.x2).toBe(800)
    expect(b.y2).toBe(1000)
  })
})

describe('rgbToChw', () => {
  it('splits interleaved RGB into normalised planes', () => {
    const out = rgbToChw(Uint8Array.from([255, 0, 51, 0, 255, 102]), 1)
    expect(out.length).toBe(3)
    // size 1 means a single pixel; only the first pixel is read.
    expect(out[0]).toBeCloseTo(1)
    expect(out[1]).toBeCloseTo(0)
    expect(out[2]).toBeCloseTo(0.2)
  })

  it('lays out a 2x2 image as R plane, G plane, B plane', () => {
    const rgb = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120])
    const out = rgbToChw(rgb, 2)
    expect(Array.from(out).map((v) => Math.round(v * 255))).toEqual([10, 40, 70, 100, 20, 50, 80, 110, 30, 60, 90, 120])
  })
})

describe('merge across tiles', () => {
  it('turns tile-local boxes into page boxes', () => {
    const [moved] = offsetBoxes([{ x1: 10, y1: 20, x2: 110, y2: 120, confidence: 0.5 }], { x: 0, y: 667, w: 800, h: 1000 }, 800, 3000)
    expect(moved).toMatchObject({ x1: 10, y1: 687, x2: 110, y2: 787 })
  })

  it('merges a box cut by a tile seam with its full view', () => {
    const merged = mergeTiledBoxes([SEAM_TEXT_TILE_A, SEAM_TEXT_TILE_B])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ x1: 100, y1: 900, x2: 300, y2: 1050, confidence: 0.9 })
  })

  it('keeps distinct boxes apart', () => {
    const merged = mergeTiledBoxes([SEAM_TEXT_TILE_A, { x1: 100, y1: 1500, x2: 300, y2: 1600, confidence: 0.9 }])
    expect(merged).toHaveLength(2)
  })

  it('suppresses a box mostly covered by a stronger one', () => {
    const kept = containmentNMS([
      { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.9 },
      { x1: 5, y1: 5, x2: 95, y2: 95, confidence: 0.5 },
    ])
    expect(kept).toHaveLength(1)
  })

  it('refineDetections drops low-confidence speckle but keeps confident boxes', () => {
    const big = (i: number) => ({ x1: i * 300, y1: 0, x2: i * 300 + 200, y2: 200, confidence: 0.9 })
    const speckle = { x1: 50, y1: 700, x2: 54, y2: 704, confidence: 0.4 }
    const result = refineDetections([big(0), big(1), big(2), speckle], 1000, 1000)
    expect(result.dropped).toBe(1)
    expect(result.boxes).toHaveLength(3)
  })
})

describe('bubble-only boxes are kept (R6.4, R6.5)', () => {
  const page = PAGE_WITH_BUBBLE_ONLY

  it('finalizeDetections keeps bubbles even when text boxes exist', () => {
    const out = finalizeDetections(
      { textBoxes: [page.textInBubble, page.freeText], bubbleBoxes: [page.bubbleWithText, page.bubbleOnly] },
      page.width,
      page.height,
      false,
    )
    expect(out.bubbleBoxes).toHaveLength(2)
    expect(out.textBoxes).toHaveLength(2)
  })

  it('builds bubble, bubble-only and free units', () => {
    const units = buildUnits({
      textBoxes: [page.textInBubble, page.freeText],
      bubbleBoxes: [page.bubbleWithText, page.bubbleOnly],
    })
    expect(units).toHaveLength(3)
    const withText = units.find((u) => u.drawBox === page.bubbleWithText)!
    expect(withText).toMatchObject({ kind: 'bubble', bubbleOnly: false })
    expect(withText.ocrBox).toMatchObject({ x1: 150, y1: 150, x2: 350, y2: 250 })
    const only = units.find((u) => u.drawBox === page.bubbleOnly)!
    expect(only).toMatchObject({ kind: 'bubble', bubbleOnly: true })
    expect(only.ocrBox).toBe(page.bubbleOnly)
    const free = units.find((u) => u.kind === 'free')!
    expect(free.drawBox).toBe(page.freeText)
  })

  it('assigns a text box to the smallest bubble containing its centre', () => {
    const outer = { x1: 0, y1: 0, x2: 500, y2: 500, confidence: 0.9 }
    const inner = { x1: 100, y1: 100, x2: 300, y2: 300, confidence: 0.9 }
    const text = { x1: 150, y1: 150, x2: 250, y2: 250, confidence: 0.9 }
    const units = buildUnits({ textBoxes: [text], bubbleBoxes: [outer, inner] })
    expect(units.find((u) => u.drawBox === inner)!.bubbleOnly).toBe(false)
    expect(units.find((u) => u.drawBox === outer)!.bubbleOnly).toBe(true)
  })

  it('unions several text boxes inside one bubble', () => {
    const bubble = { x1: 0, y1: 0, x2: 400, y2: 400, confidence: 0.9 }
    const a = { x1: 50, y1: 50, x2: 150, y2: 100, confidence: 0.8 }
    const b = { x1: 60, y1: 200, x2: 200, y2: 260, confidence: 0.7 }
    const [unit] = buildUnits({ textBoxes: [a, b], bubbleBoxes: [bubble] })
    expect(unit!.ocrBox).toMatchObject({ x1: 50, y1: 50, x2: 200, y2: 260 })
  })
})

describe('reading order', () => {
  const unitBox = (x: number, y: number) => ({ x1: x, y1: y, x2: x + 100, y2: y + 100, confidence: 0.9 })
  const groups = { textBoxes: [], bubbleBoxes: [unitBox(500, 10), unitBox(50, 20), unitBox(300, 400), unitBox(40, 380)] }

  it('reads rows top to bottom and left to right', () => {
    const order = buildUnits(groups, 'ltr').map((u) => `${u.drawBox.x1},${u.drawBox.y1}`)
    expect(order).toEqual(['50,20', '500,10', '40,380', '300,400'])
  })

  it('reads right to left when configured', () => {
    const order = buildUnits(groups, 'rtl').map((u) => `${u.drawBox.x1},${u.drawBox.y1}`)
    expect(order).toEqual(['500,10', '50,20', '300,400', '40,380'])
  })

  it('handles zero and one unit', () => {
    expect(buildUnits({ textBoxes: [], bubbleBoxes: [] })).toEqual([])
    expect(buildUnits({ textBoxes: [unitBox(0, 0)], bubbleBoxes: [] })).toHaveLength(1)
  })
})
