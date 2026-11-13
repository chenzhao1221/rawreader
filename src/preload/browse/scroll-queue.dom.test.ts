import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageConfig, PageImage } from '../../shared/ipc/contract'
import { ELEMENT_ID_ATTR, ScrollQueue } from './scroll-queue'

// Minimal DOM fakes: the vitest environment is `node`, so only what ScrollQueue touches is modelled.
// IntersectionObserver is a no-op that never fires, like in a hidden or throttled document.

const VIEWPORT_H = 800

class FakeImage {
  readonly attrs = new Map<string, string>()
  private readonly listeners = new Map<string, Array<() => void>>()
  complete = true
  currentSrc: string
  srcset = ''
  /** Rendered height. 0 models a lazy-load placeholder that has no layout box yet. */
  height = 900
  constructor(
    public src: string,
    public naturalWidth: number,
    public naturalHeight: number,
    public top: number,
  ) {
    this.currentSrc = src
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  getBoundingClientRect(): { top: number; bottom: number } {
    return { top: this.top, bottom: this.top + this.height }
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
}

class FakeTarget {
  private readonly listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }
}

class FakeWindow extends FakeTarget {
  innerHeight = VIEWPORT_H
}

class FakeDocument extends FakeTarget {
  readyState: 'loading' | 'interactive' | 'complete' = 'loading'
  body: object | null = null
  baseURI = 'https://example.com/'
  readonly images: FakeImage[] = []
  readonly defaultView = new FakeWindow()
  querySelectorAll(selector: string): FakeImage[] {
    return selector === 'img' ? [...this.images] : []
  }
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const CONFIG: PageConfig = { enabled: true, overlayVisible: true, minImageSize: 200, rootMarginPx: 1200 }

function setup(): { doc: FakeDocument; queue: ScrollQueue; reports: PageImage[][] } {
  const doc = new FakeDocument()
  const reports: PageImage[][] = []
  const queue = new ScrollQueue({ report: (images) => reports.push(images), doc: doc as unknown as Document })
  return { doc, queue, reports }
}

function reported(reports: PageImage[][]): string[] {
  return reports.flat().map((image) => image.url)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', NoopObserver)
  vi.stubGlobal('MutationObserver', NoopObserver)
  vi.stubGlobal('HTMLImageElement', FakeImage)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ScrollQueue start before <body> exists', () => {
  it('waits for DOMContentLoaded, then tags and reports in-range images', () => {
    const { doc, queue, reports } = setup()
    const img = new FakeImage('https://example.com/a.png', 800, 1200, 100)
    doc.images.push(img)

    queue.setConfig(CONFIG)
    vi.advanceTimersByTime(500)
    expect(reports).toEqual([])
    expect(img.getAttribute(ELEMENT_ID_ATTR)).toBeNull()
    expect(doc.listenerCount('DOMContentLoaded')).toBe(1)

    doc.body = {}
    doc.readyState = 'interactive'
    doc.emit('DOMContentLoaded')
    vi.advanceTimersByTime(500)

    expect(img.getAttribute(ELEMENT_ID_ATTR)).toBe('rr1')
    expect(reported(reports)).toEqual(['https://example.com/a.png'])
    expect(doc.listenerCount('DOMContentLoaded')).toBe(0)
  })

  it('does not stack listeners when setConfig repeats with the same settings', () => {
    const { doc, queue } = setup()
    queue.setConfig(CONFIG)
    queue.setConfig({ ...CONFIG, minImageSize: 300 })
    queue.setConfig({ ...CONFIG })
    expect(doc.listenerCount('DOMContentLoaded')).toBe(1)
  })

  it('stop() cancels a pending start', () => {
    const { doc, queue, reports } = setup()
    doc.images.push(new FakeImage('https://example.com/a.png', 800, 1200, 100))
    queue.setConfig(CONFIG)
    queue.setConfig({ ...CONFIG, enabled: false })
    expect(doc.listenerCount('DOMContentLoaded')).toBe(0)

    doc.body = {}
    doc.readyState = 'interactive'
    doc.emit('DOMContentLoaded')
    vi.advanceTimersByTime(500)
    expect(reports).toEqual([])
    expect(doc.defaultView.listenerCount('scroll')).toBe(0)
  })

  it('starts immediately when the body already exists', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    doc.images.push(new FakeImage('https://example.com/a.png', 800, 1200, 0))
    queue.setConfig(CONFIG)
    vi.advanceTimersByTime(500)
    expect(reported(reports)).toEqual(['https://example.com/a.png'])
  })
})

describe('ScrollQueue without IntersectionObserver callbacks', () => {
  it('enqueues an in-viewport image but not one far below, until it scrolls into range', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    const near = new FakeImage('https://example.com/near.png', 800, 1200, 50)
    const far = new FakeImage('https://example.com/far.png', 800, 1200, 9000)
    doc.images.push(near, far)

    queue.setConfig(CONFIG)
    vi.advanceTimersByTime(500)
    expect(reported(reports)).toEqual(['https://example.com/near.png'])
    expect(far.getAttribute(ELEMENT_ID_ATTR)).toBeNull()

    far.top = 1500 // scrolled: now within viewport + rootMarginPx (800 + 1200)
    doc.defaultView.emit('scroll')
    vi.advanceTimersByTime(500)
    expect(reported(reports)).toEqual(['https://example.com/near.png', 'https://example.com/far.png'])
    expect(far.getAttribute(ELEMENT_ID_ATTR)).toBe('rr2')
  })

  it('reports each image once even if scroll and resize fire repeatedly', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    doc.images.push(new FakeImage('https://example.com/a.png', 800, 1200, 0))
    queue.setConfig(CONFIG)
    for (let i = 0; i < 5; i++) {
      doc.defaultView.emit('scroll')
      doc.defaultView.emit('resize')
      vi.advanceTimersByTime(200)
    }
    expect(reported(reports)).toEqual(['https://example.com/a.png'])
  })

  it('still applies the size filter on the geometry path', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    const small = new FakeImage('https://example.com/icon.png', 64, 64, 0)
    doc.images.push(small)
    queue.setConfig(CONFIG)
    vi.advanceTimersByTime(500)
    expect(reports).toEqual([])
    expect(small.getAttribute(ELEMENT_ID_ATTR)).toBeNull()
  })

  it('removes scroll and resize listeners on stop()', () => {
    const { doc, queue } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    queue.setConfig(CONFIG)
    expect(doc.defaultView.listenerCount('scroll')).toBe(1)
    expect(doc.defaultView.listenerCount('resize')).toBe(1)
    queue.stop()
    expect(doc.defaultView.listenerCount('scroll')).toBe(0)
    expect(doc.defaultView.listenerCount('resize')).toBe(0)
  })
})

describe('ScrollQueue nearest-first reporting', () => {
  const FAR_CONFIG: PageConfig = { ...CONFIG, rootMarginPx: 1200 }

  function pageOf(count: number, pageHeight = 900): FakeImage[] {
    // A long strip: image i starts at i * pageHeight in page coordinates; the viewport starts at the top.
    return Array.from({ length: count }, (_, i) => {
      const img = new FakeImage(`https://example.com/p/${i}.png`, 800, pageHeight, i * pageHeight)
      img.height = pageHeight
      return img
    })
  }

  function scrollTo(images: FakeImage[], pageHeight: number, y: number): void {
    images.forEach((img, i) => {
      img.top = i * pageHeight - y
    })
  }

  it('reports real, distinct distances nearest first while the viewport is at the top', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    const images = pageOf(40)
    // Farthest first in the DOM on purpose: order must come from distance, not from document order.
    doc.images.push(images[2]!, images[1]!, images[0]!, ...images.slice(3))

    queue.setConfig(FAR_CONFIG)
    vi.advanceTimersByTime(500)

    const first = reports.flat()
    // Only images within viewport (800) + rootMargin (1200) are reported; the other 37 are not.
    expect(first.map((image) => image.url)).toEqual([
      'https://example.com/p/0.png',
      'https://example.com/p/1.png',
      'https://example.com/p/2.png',
    ])
    expect(first.map((image) => image.distance)).toEqual([0, 100, 1000])
    expect(images[10]!.getAttribute(ELEMENT_ID_ATTR)).toBeNull()
  })

  it('sends the nearest images in the first batch even when more than one batch is in range', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    const images = pageOf(80)
    doc.images.push(...[...images].reverse())

    queue.setConfig({ ...FAR_CONFIG, rootMarginPx: 1_000_000 })
    vi.advanceTimersByTime(500)

    expect(reports.length).toBeGreaterThan(1)
    const flat = reports.flat()
    expect(flat).toHaveLength(80)
    const distances = flat.map((image) => image.distance)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
    expect(reports[0]?.[0]?.url).toBe('https://example.com/p/0.png')
    expect(new Set(distances).size).toBeGreaterThan(70)
  })

  it('does not report unlaid-out (zero-height) images as distance 0, and reports them once they have a box', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    const images = pageOf(6)
    for (const img of images) img.height = 0
    // Placeholders stacked at the top of the page, all with an empty box.
    images.forEach((img) => (img.top = 0))
    doc.images.push(...images)

    queue.setConfig(FAR_CONFIG)
    vi.advanceTimersByTime(3000)
    expect(reports).toEqual([])
    expect(images[0]!.getAttribute(ELEMENT_ID_ATTR)).toBeNull()

    // Layout arrives (no scroll event): the retry timer picks it up with real distances.
    images.forEach((img, i) => {
      img.height = 900
      img.top = i * 900
    })
    vi.advanceTimersByTime(1000)
    const flat = reports.flat()
    expect(flat.map((image) => image.distance)).toEqual([0, 100, 1000])
  })

  it('surfaces a nearer, not yet reported image after a mid-page jump', () => {
    const { doc, queue, reports } = setup()
    doc.body = {}
    doc.readyState = 'complete'
    const images = pageOf(60)
    doc.images.push(...images)

    queue.setConfig(FAR_CONFIG)
    vi.advanceTimersByTime(500)
    expect(reports.flat().map((image) => image.url)).toEqual([
      'https://example.com/p/0.png',
      'https://example.com/p/1.png',
      'https://example.com/p/2.png',
    ])
    const batchesBefore = reports.length

    // Jump to the middle of the chapter: image 30 now fills the top of the viewport (100 px scrolled into it).
    scrollTo(images, 900, 30 * 900 + 100)
    doc.defaultView.emit('scroll')
    vi.advanceTimersByTime(500)

    expect(reports.length).toBeGreaterThan(batchesBefore)
    const fresh = reports.slice(batchesBefore).flat()
    expect(fresh[0]?.url).toBe('https://example.com/p/30.png')
    expect(fresh[0]?.distance).toBe(0)
    expect(fresh.find((image) => image.url.endsWith('/p/29.png'))?.distance).toBe(100)
    const distances = fresh.map((image) => image.distance)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
    // Images 0 to 2 are not reported again, and image 30 was never reported with a dummy distance.
    expect(fresh.map((image) => image.url)).not.toContain('https://example.com/p/0.png')
    expect(fresh.every((image) => image.distance <= FAR_CONFIG.rootMarginPx)).toBe(true)
  })
})