import { describe, expect, it } from 'vitest'
import { calculateFittedTextLayout, lineHeightFor, wrapText } from './text-fit'
import type { MeasureFn } from './text-fit'

/** Hanzi and fullwidth marks are one em wide, ASCII half an em, a space 0.3 em. */
const measure: MeasureFn = (text, size) => {
  let w = 0
  for (const ch of text) {
    if (ch === ' ') w += size * 0.3
    else if (ch.charCodeAt(0) < 0x2000) w += size * 0.5
    else w += size
  }
  return w
}

const widthAt = (size: number) => (s: string) => measure(s, size)

describe('wrapText', () => {
  it('breaks between hanzi at the box width', () => {
    expect(wrapText('一二三四五六七', 30, widthAt(10))).toEqual(['一二三', '四五六', '七'])
  })

  it('keeps explicit paragraph breaks', () => {
    expect(wrapText('一二\n三四', 100, widthAt(10))).toEqual(['一二', '三四'])
  })

  it('does not start a line with closing punctuation', () => {
    const lines = wrapText('一二三，四五', 30, widthAt(10))
    expect(lines[0]).toBe('一二三，')
    expect(lines.every((l) => !'，。！？'.includes(l[0] ?? ''))).toBe(true)
  })

  it('does not end a line with an opening bracket', () => {
    const lines = wrapText('一二（三四）', 30, widthAt(10))
    expect(lines.every((l) => !l.endsWith('（'))).toBe(true)
    expect(lines.join('')).toBe('一二（三四）')
  })

  it('keeps latin words whole and breaks very long words with a hyphen', () => {
    expect(wrapText('ab cd', 100, widthAt(10))).toEqual(['ab cd'])
    const lines = wrapText('abcdefghij', 20, widthAt(10))
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]?.endsWith('-')).toBe(true)
    expect(lines.join('').replace(/-/g, '')).toBe('abcdefghij')
  })

  it('returns one empty line for empty text', () => {
    expect(wrapText('', 50, widthAt(10))).toEqual([''])
  })
})

describe('calculateFittedTextLayout', () => {
  it('uses the largest size that fits and keeps the block inside the box', () => {
    const layout = calculateFittedTextLayout('你好，世界！这是一个测试。', 200, 120, measure, { pad: 8 })
    expect(layout.fontSize).toBeGreaterThanOrEqual(4)
    expect(layout.fontSize).toBeLessThanOrEqual(40)
    expect(layout.blockH).toBeLessThanOrEqual(layout.maxH + 0.001)
    for (const line of layout.lines) expect(measure(line.replace(/[，。！？]+$/u, ''), layout.fontSize)).toBeLessThanOrEqual(layout.maxW + 0.5)
    // One size larger must not fit (otherwise the loop stopped too early).
    const bigger = layout.fontSize + 1
    if (bigger <= 40) {
      const lines = wrapText('你好，世界！这是一个测试。', layout.maxW, widthAt(bigger))
      const fits = lines.length * lineHeightFor(bigger) <= layout.maxH && lines.every((l) => measure(l, bigger) <= layout.maxW + 0.5)
      expect(fits).toBe(false)
    }
  })

  it('shrinks for longer text', () => {
    const short = calculateFittedTextLayout('你好', 200, 120, measure)
    const long = calculateFittedTextLayout('你好'.repeat(40), 200, 120, measure)
    expect(long.fontSize).toBeLessThan(short.fontSize)
  })

  it('caps the size at maxFontSize and at the box height', () => {
    expect(calculateFittedTextLayout('字', 1000, 1000, measure, { maxFontSize: 30 }).fontSize).toBe(30)
    expect(calculateFittedTextLayout('字', 1000, 30, measure, { pad: 8 }).fontSize).toBeLessThanOrEqual(14)
  })

  it('stops at the minimum size for text that cannot fit', () => {
    const layout = calculateFittedTextLayout('字'.repeat(500), 60, 60, measure, { minFontSize: 4 })
    expect(layout.fontSize).toBe(4)
    expect(layout.lines.length).toBeGreaterThan(1)
  })

  it('handles degenerate boxes and empty text', () => {
    expect(calculateFittedTextLayout('', 100, 100, measure).lines).toEqual([])
    const tiny = calculateFittedTextLayout('字', 10, 10, measure)
    expect(tiny.lines).toEqual(['字'])
  })
})
