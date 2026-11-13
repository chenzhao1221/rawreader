import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BOX_IMAGE_COVERAGE, dropOversizedBoxes } from './coverage'
import type { Bbox } from './types'
import { buildUnits } from './units'

const box = (x1: number, y1: number, x2: number, y2: number): Bbox => ({ x1, y1, x2, y2, confidence: 0.9 })

describe('dropOversizedBoxes', () => {
  // The real logo case: a 1016 x 410 image whose only detection is a full-image bubble.
  const W = 1016
  const H = 410

  it('defaults to 0.85', () => {
    expect(DEFAULT_MAX_BOX_IMAGE_COVERAGE).toBe(0.85)
  })

  it('drops a bubble box that exactly fills the image, so no unit is built', () => {
    const out = dropOversizedBoxes({ textBoxes: [], bubbleBoxes: [box(0, 0, W, H)] }, W, H)
    expect(out.bubbleBoxes).toEqual([])
    expect(buildUnits(out)).toEqual([])
  })

  it('drops a full-image text box', () => {
    const out = dropOversizedBoxes({ textBoxes: [box(0, 0, W, H)], bubbleBoxes: [] }, W, H)
    expect(out.textBoxes).toEqual([])
  })

  it('drops a box at exactly 0.85 of the image area', () => {
    // 100 x 100 image, 85 x 100 box = 0.85
    const out = dropOversizedBoxes({ textBoxes: [box(0, 0, 85, 100)], bubbleBoxes: [box(0, 0, 100, 85)] }, 100, 100)
    expect(out.textBoxes).toEqual([])
    expect(out.bubbleBoxes).toEqual([])
  })

  it('keeps a box just under 0.85', () => {
    // 1000 x 1000 image, 849 x 1000 box = 0.849
    const out = dropOversizedBoxes({ textBoxes: [], bubbleBoxes: [box(0, 0, 849, 1000)] }, 1000, 1000)
    expect(out.bubbleBoxes).toHaveLength(1)
  })

  it('keeps typical speech bubbles and free text', () => {
    const groups = { textBoxes: [box(150, 150, 350, 250)], bubbleBoxes: [box(100, 100, 400, 300), box(500, 600, 700, 800)] }
    expect(dropOversizedBoxes(groups, 800, 1000)).toEqual(groups)
  })

  it('only removes the oversized box and keeps the rest in order', () => {
    const small = box(10, 10, 100, 100)
    const out = dropOversizedBoxes({ textBoxes: [], bubbleBoxes: [small, box(0, 0, 800, 1000)] }, 800, 1000)
    expect(out.bubbleBoxes).toEqual([small])
  })

  it('honours a custom threshold', () => {
    const groups = { textBoxes: [], bubbleBoxes: [box(0, 0, 500, 1000)] } // 0.5 of a 1000 x 1000 image
    expect(dropOversizedBoxes(groups, 1000, 1000, 0.5).bubbleBoxes).toEqual([])
    expect(dropOversizedBoxes(groups, 1000, 1000, 0.6).bubbleBoxes).toHaveLength(1)
  })

  it('drops nothing for zero or invalid image area', () => {
    const groups = { textBoxes: [box(0, 0, 10, 10)], bubbleBoxes: [box(0, 0, 10, 10)] }
    expect(dropOversizedBoxes(groups, 0, 100)).toBe(groups)
    expect(dropOversizedBoxes(groups, 100, 0)).toBe(groups)
    expect(dropOversizedBoxes(groups, Number.NaN, 100)).toBe(groups)
    expect(dropOversizedBoxes(groups, -5, -5)).toBe(groups)
  })

  it('a dropped full-image bubble leaves its text as a free unit', () => {
    const text = box(300, 100, 500, 200)
    const out = dropOversizedBoxes({ textBoxes: [text], bubbleBoxes: [box(0, 0, W, H)] }, W, H)
    const units = buildUnits(out)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'free', bubbleOnly: false })
  })
})
