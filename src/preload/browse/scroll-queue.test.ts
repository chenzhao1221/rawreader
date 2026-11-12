import { describe, expect, it, vi } from 'vitest'
import { Batcher, EnqueueGuard } from './enqueue-guard'
import {
  chooseImageUrl,
  distanceToViewport,
  isReportableUrl,
  parseSrcset,
  pickLargestCandidate,
  qualifiesBySize,
} from './image-select'

describe('parseSrcset / pickLargestCandidate', () => {
  it('parses width and density descriptors', () => {
    expect(parseSrcset('a.jpg 480w, b.jpg 960w')).toEqual([
      { url: 'a.jpg', width: 480, density: null },
      { url: 'b.jpg', width: 960, density: null },
    ])
    expect(parseSrcset('a.jpg 1x, b.jpg 2x')[1]).toEqual({ url: 'b.jpg', width: null, density: 2 })
  })

  it('keeps commas inside data URLs', () => {
    const out = parseSrcset('data:image/png;base64,AAAA 1x, big.png 2x')
    expect(out).toHaveLength(2)
    expect(out[0]?.url).toBe('data:image/png;base64,AAAA')
  })

  it('picks the widest candidate', () => {
    expect(pickLargestCandidate(parseSrcset('a.jpg 960w, b.jpg 480w'))?.url).toBe('a.jpg')
    expect(pickLargestCandidate(parseSrcset('a.jpg 1x, b.jpg 3x, c.jpg 2x'))?.url).toBe('b.jpg')
  })

  it('returns null for an empty list and ignores junk', () => {
    expect(pickLargestCandidate(parseSrcset(''))).toBeNull()
    expect(parseSrcset(' , ')).toEqual([])
  })
})

describe('chooseImageUrl', () => {
  const resolve = (url: string): string => new URL(url, 'https://site.example/read/').href
  it('prefers what the browser already loaded', () => {
    expect(
      chooseImageUrl({ currentSrc: 'https://cdn.example/x-480.jpg', src: 'https://cdn.example/x.jpg', srcset: 'x-480.jpg 480w, x-960.jpg 960w', complete: true }, resolve),
    ).toBe('https://cdn.example/x-480.jpg')
  })

  it('uses the largest srcset candidate before the first load', () => {
    expect(chooseImageUrl({ currentSrc: '', src: '', srcset: 'a.jpg 480w, b.jpg 960w', complete: false }, resolve)).toBe(
      'https://site.example/read/b.jpg',
    )
  })

  it('falls back to src', () => {
    expect(chooseImageUrl({ currentSrc: '', src: 'https://cdn.example/s.png', srcset: '', complete: false }, resolve)).toBe(
      'https://cdn.example/s.png',
    )
  })
})

describe('size filter, distance and URL filter', () => {
  it('requires both dimensions to reach the minimum', () => {
    expect(qualifiesBySize(200, 200, 200)).toBe(true)
    expect(qualifiesBySize(199, 900, 200)).toBe(false)
    expect(qualifiesBySize(900, 120, 200)).toBe(false)
  })

  it('measures the gap to the viewport', () => {
    expect(distanceToViewport(100, 500, 800)).toBe(0)
    expect(distanceToViewport(900, 1500, 800)).toBe(100)
    expect(distanceToViewport(-700, -300, 800)).toBe(300)
  })

  it('reports only http, data image and blob URLs', () => {
    expect(isReportableUrl('https://a/b.jpg')).toBe(true)
    expect(isReportableUrl('data:image/png;base64,AA')).toBe(true)
    expect(isReportableUrl('blob:https://a/1')).toBe(true)
    expect(isReportableUrl('javascript:alert(1)')).toBe(false)
    expect(isReportableUrl('file:///x.png')).toBe(false)
    expect(isReportableUrl('data:text/html,hi')).toBe(false)
  })
})

describe('EnqueueGuard', () => {
  it('lets an element-URL pair through once', () => {
    const guard = new EnqueueGuard()
    expect(guard.tryEnqueue('rr1', 'https://a/1.jpg')).toBe(true)
    expect(guard.tryEnqueue('rr1', 'https://a/1.jpg')).toBe(false)
    expect(guard.tryEnqueue('rr1', 'https://a/2.jpg')).toBe(true) // URL swapped on the same element
    expect(guard.tryEnqueue('rr2', 'https://a/1.jpg')).toBe(true)
  })

  it('supports retry and clear', () => {
    const guard = new EnqueueGuard()
    guard.tryEnqueue('rr1', 'u')
    guard.forget('rr1', 'u')
    expect(guard.tryEnqueue('rr1', 'u')).toBe(true)
    guard.clear()
    expect(guard.size).toBe(0)
  })
})

describe('Batcher', () => {
  it('flushes after the delay as one batch', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const batcher = new Batcher<number>({ flush, delayMs: 50, maxItems: 10 })
    batcher.add(1)
    batcher.add(2)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(flush).toHaveBeenCalledWith([1, 2])
    vi.useRealTimers()
  })

  it('flushes at the item cap and drops items on clear', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const batcher = new Batcher<number>({ flush, delayMs: 50, maxItems: 2 })
    batcher.add(1)
    batcher.add(2)
    expect(flush).toHaveBeenCalledWith([1, 2])
    batcher.add(3)
    batcher.clear()
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
