import { describe, expect, it } from 'vitest'
import { computeHostGeometry, isNearViewport, rectChanged, scaleBox, textAreaFor } from './overlay-geometry'

describe('computeHostGeometry', () => {
  it('returns the rectangle and display/natural scale', () => {
    const g = computeHostGeometry({ left: 10, top: 20, width: 400, height: 550 }, { width: 800, height: 1100 })
    expect(g).toEqual({ rect: { left: 10, top: 20, width: 400, height: 550 }, scaleX: 0.5, scaleY: 0.5 })
  })

  it('has no geometry before layout or without a natural size', () => {
    expect(computeHostGeometry({ left: 0, top: 0, width: 0, height: 10 }, { width: 800, height: 1100 })).toBeNull()
    expect(computeHostGeometry({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 1100 })).toBeNull()
  })
})

describe('rectChanged', () => {
  const base = { left: 10, top: 10, width: 100, height: 100 }
  it('treats sub-half-pixel differences as unchanged', () => {
    expect(rectChanged(base, { ...base, left: 10.4, height: 100.3 })).toBe(false)
  })
  it('detects position and size changes', () => {
    expect(rectChanged(base, { ...base, top: 11 })).toBe(true)
    expect(rectChanged(base, { ...base, width: 101 })).toBe(true)
    expect(rectChanged(null, base)).toBe(true)
  })
})

describe('isNearViewport', () => {
  const viewport = { width: 1000, height: 800 }
  it('keeps hosts inside the viewport plus margin', () => {
    expect(isNearViewport({ left: 0, top: 100, width: 500, height: 500 }, viewport, 400)).toBe(true)
    expect(isNearViewport({ left: 0, top: 1100, width: 500, height: 500 }, viewport, 400)).toBe(true)
  })
  it('hides hosts far above or below', () => {
    expect(isNearViewport({ left: 0, top: 1300, width: 500, height: 500 }, viewport, 400)).toBe(false)
    expect(isNearViewport({ left: 0, top: -2000, width: 500, height: 500 }, viewport, 400)).toBe(false)
  })
})

describe('scaleBox', () => {
  it('maps image pixels to host-relative CSS pixels', () => {
    expect(scaleBox({ x1: 100, y1: 200, x2: 300, y2: 400 }, 0.5, 0.25)).toEqual({ left: 50, top: 50, width: 100, height: 50 })
  })
})

describe('textAreaFor', () => {
  const image = { width: 800, height: 1100 }
  it('shrinks a bubble towards its centre', () => {
    const area = textAreaFor('bubble', { x1: 100, y1: 100, x2: 300, y2: 200 }, image)
    expect(area.x1).toBeGreaterThan(100)
    expect(area.x2).toBeLessThan(300)
    expect((area.x1 + area.x2) / 2).toBeCloseTo(200)
  })
  it('grows a free text box but stays inside the image', () => {
    const area = textAreaFor('free', { x1: 0, y1: 0, x2: 100, y2: 50 }, image)
    expect(area.x1).toBe(0)
    expect(area.x2).toBeGreaterThan(100)
    const edge = textAreaFor('free', { x1: 700, y1: 1050, x2: 800, y2: 1100 }, image)
    expect(edge.x2).toBe(800)
    expect(edge.y2).toBe(1100)
  })
})
