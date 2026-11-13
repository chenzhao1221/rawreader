// Portions ported from libre-manga-translator src/entrypoints/content/auto-translate.ts
// (`AutoTranslateOrchestrator`: IntersectionObserver + MutationObserver scan) @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: WXT storage replaced by a config object pushed over IPC, site rules and canvas
// readers removed (phase 1), images are reported to main in batches instead of calling a translate
// function, `rootMargin` and the size filter come from config, attribute changes of lazy images are watched.

import type { PageConfig, PageImage } from '../../shared/ipc/contract'
import { Batcher, EnqueueGuard } from './enqueue-guard'
import { chooseImageUrl, distanceToViewport, isReportableUrl, qualifiesBySize } from './image-select'

/** Attribute that tags each reported element so main can address it later (overlay slice). */
export const ELEMENT_ID_ATTR = 'data-rr-id'

export interface ScrollQueueOptions {
  /** Sends one batch of images to main. */
  report: (images: PageImage[]) => void
  /** Called for small, slow images that finish loading after the scan. Defaults to the global `document`. */
  doc?: Document
}

const BATCH_DELAY_MS = 80
const BATCH_MAX_ITEMS = 50
/** Minimum gap between two scroll/resize driven range checks. */
const SWEEP_DELAY_MS = 100
/** Re-measure interval while images have no rendered box yet, and how many times in a row we try. */
const LAYOUT_RETRY_MS = 500
const LAYOUT_RETRY_MAX = 40

/** An image that is within range of the viewport right now, with its real distance in CSS pixels. */
interface InRange {
  img: HTMLImageElement
  distance: number
}

/**
 * Finds `<img>` elements, waits until they come near the viewport and reports
 * each (element, URL) pair once. It never fetches or decodes anything itself.
 */
export class ScrollQueue {
  private config: PageConfig | null = null
  private observer: IntersectionObserver | null = null
  private mutationObserver: MutationObserver | null = null
  private readonly guard = new EnqueueGuard()
  private readonly batcher: Batcher<PageImage>
  private nextId = 1
  private readonly doc: Document
  /** Elements whose load event we are waiting for. */
  private waiting = new WeakSet<HTMLImageElement>()
  /** Elements already given to the IntersectionObserver for their current URL. */
  private observed = new WeakMap<HTMLImageElement, string>()
  /** Elements already handed to enqueue for their current URL (either path). */
  private reported = new WeakMap<HTMLImageElement, string>()
  /** Listener waiting for DOMContentLoaded because start() ran before <body> existed. */
  private pendingReady: (() => void) | null = null
  private scrollListener: (() => void) | null = null
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  /** Set during a scan when an image had no measurable box; triggers the layout retry timer. */
  private layoutPending = false
  private layoutTimer: ReturnType<typeof setTimeout> | null = null
  private layoutRetries = 0
  constructor(private readonly options: ScrollQueueOptions) {
    this.doc = options.doc ?? document
    this.batcher = new Batcher<PageImage>({
      delayMs: BATCH_DELAY_MS,
      maxItems: BATCH_MAX_ITEMS,
      flush: (items) => {
        // Nearest the viewport first inside a batch.
        items.sort((a, b) => a.distance - b.distance)
        options.report(items)
      },
    })
  }

  /** Applies a config pushed from main. Starts or stops scanning when `enabled` changes. */
  setConfig(next: PageConfig): void {
    const previous = this.config
    this.config = next
    if (!next.enabled) {
      this.stop()
      return
    }
    if (!previous?.enabled || previous.rootMarginPx !== next.rootMarginPx) {
      this.stop()
      this.start()
    }
  }

  private start(): void {
    const config = this.config
    if (!config?.enabled) return
    if (!this.doc.body) {
      this.deferStart()
      return
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        // Nearest first, and only elements that have a rendered box (see measure()).
        const hits: InRange[] = []
        this.layoutPending = false
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target instanceof HTMLImageElement) {
            const distance = this.measure(entry.target)
            if (distance === null) this.layoutPending = true
            else hits.push({ img: entry.target, distance })
          }
        }
        this.enqueueNearestFirst(hits)
        if (this.layoutPending) this.scheduleLayoutRetry()
      },
      { root: null, rootMargin: `${config.rootMarginPx}px 0px`, threshold: 0 },
    )

    this.scan()

    this.mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' || mutation.addedNodes.length > 0) {
          this.scan()
          return
        }
      }
    })
    this.mutationObserver.observe(this.doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    })

    // IntersectionObserver may never fire in hidden, occluded or throttled documents, so scrolling
    // and resizing also trigger a geometry check of the images that are waiting.
    const view = this.doc.defaultView
    if (view) {
      this.scrollListener = () => this.scheduleSweep()
      view.addEventListener('scroll', this.scrollListener, { capture: true, passive: true })
      view.addEventListener('resize', this.scrollListener, { passive: true })
    }
  }

  /**
   * The preload runs at document start, usually before <body> exists. Wait for DOMContentLoaded
   * once instead of staying dead until the next config push.
   */
  private deferStart(): void {
    if (this.pendingReady || this.doc.readyState !== 'loading') return
    const onReady = (): void => {
      this.doc.removeEventListener('DOMContentLoaded', onReady)
      this.pendingReady = null
      this.start()
    }
    this.pendingReady = onReady
    this.doc.addEventListener('DOMContentLoaded', onReady)
  }

  private scheduleSweep(): void {
    // The user moved the viewport: measure again and allow fresh layout retries.
    this.layoutRetries = 0
    if (this.sweepTimer !== null) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.scan()
    }, SWEEP_DELAY_MS)
  }

  /**
   * Stops observing and drops queued, unsent work. Already reported images are not recalled here.
   */
  stop(): void {
    if (this.pendingReady) {
      this.doc.removeEventListener('DOMContentLoaded', this.pendingReady)
      this.pendingReady = null
    }
    if (this.scrollListener) {
      const view = this.doc.defaultView
      view?.removeEventListener('scroll', this.scrollListener, { capture: true })
      view?.removeEventListener('resize', this.scrollListener)
      this.scrollListener = null
    }
    if (this.sweepTimer !== null) {
      clearTimeout(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.layoutTimer !== null) {
      clearTimeout(this.layoutTimer)
      this.layoutTimer = null
    }
    this.layoutRetries = 0
    this.layoutPending = false
    this.observer?.disconnect()
    this.observer = null
    this.mutationObserver?.disconnect()
    this.mutationObserver = null
    this.batcher.clear()
    // A restart should see every image again, including ones reported before.
    this.guard.clear()
    this.waiting = new WeakSet()
    this.observed = new WeakMap()
    this.reported = new WeakMap()
  }

  /**
   * Visits every image and reports the ones within range, nearest the viewport first. Collecting before
   * enqueueing matters: a long chapter can have more in-range images than one batch holds, and DOM order
   * would otherwise decide which batch goes out first.
   */
  private scan(): void {
    if (!this.observer) return
    this.layoutPending = false
    const inRange: InRange[] = []
    this.doc.querySelectorAll('img').forEach((img) => {
      const hit = this.observe(img)
      if (hit) inRange.push(hit)
    })
    this.enqueueNearestFirst(inRange)
    if (this.layoutPending) this.scheduleLayoutRetry()
  }

  /**
   * Distance of an image to the current viewport, or `null` while that cannot be known: the image has no
   * rendered box (lazy-load placeholder, `display: none`, not laid out yet) or the viewport has no height.
   * Such images must not be reported as distance 0, because that is indistinguishable from "on screen" and
   * would put every unlaid image of the chapter in the first batch. They stay unreported and are measured
   * again on scroll, resize, load and a short layout retry timer.
   */
  private measure(img: HTMLImageElement): number | null {
    const rect = img.getBoundingClientRect()
    const viewportHeight = this.doc.defaultView?.innerHeight ?? 0
    if (viewportHeight <= 0 || !(rect.bottom - rect.top > 0)) return null
    return Math.max(0, Math.round(distanceToViewport(rect.top, rect.bottom, viewportHeight)))
  }

  private scheduleLayoutRetry(): void {
    if (this.layoutTimer !== null || this.layoutRetries >= LAYOUT_RETRY_MAX) return
    this.layoutRetries++
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null
      this.scan()
    }, LAYOUT_RETRY_MS)
  }

  private enqueueNearestFirst(list: InRange[]): void {
    list.sort((a, b) => a.distance - b.distance)
    for (const { img, distance } of list) {
      this.observer?.unobserve(img)
      this.enqueue(img, distance)
    }
  }

  private urlOf(img: HTMLImageElement): string {
    return chooseImageUrl(
      { currentSrc: img.currentSrc, src: img.src, srcset: img.srcset, complete: img.complete },
      (url) => {
        try {
          return new URL(url, this.doc.baseURI).href
        } catch {
          return url
        }
      },
    )
  }

  /** Returns the image with its current distance when it should be reported now, otherwise `null`. */
  private observe(img: HTMLImageElement): InRange | null {
    const config = this.config
    if (!config?.enabled || !this.observer) return null
    const url = this.urlOf(img)
    if (!url || !isReportableUrl(url)) return null
    if (this.reported.get(img) === url) return null
    if (this.observed.get(img) === url) return this.inRange(img)

    if (img.complete && img.naturalWidth > 0) {
      if (!qualifiesBySize(img.naturalWidth, img.naturalHeight, config.minImageSize)) return null
      this.observed.set(img, url)
      this.observer.observe(img)
      return this.inRange(img)
    } else if (!this.waiting.has(img)) {
      this.waiting.add(img)
      img.addEventListener(
        'load',
        () => {
          this.waiting.delete(img)
          this.layoutPending = false
          const hit = this.observe(img)
          if (hit) this.enqueueNearestFirst([hit])
          if (this.layoutPending) this.scheduleLayoutRetry()
        },
        { once: true },
      )
    }
    return null
  }

  /** Geometry path: the image with its distance when it is already within rootMarginPx of the viewport. */
  private inRange(img: HTMLImageElement): InRange | null {
    const config = this.config
    if (!config?.enabled) return null
    const distance = this.measure(img)
    if (distance === null) {
      this.layoutPending = true
      return null
    }
    return distance > config.rootMarginPx ? null : { img, distance }
  }

  private elementId(img: HTMLImageElement): string {
    let id = img.getAttribute(ELEMENT_ID_ATTR)
    if (!id) {
      id = `rr${this.nextId++}`
      img.setAttribute(ELEMENT_ID_ATTR, id)
    }
    return id
  }

  private enqueue(img: HTMLImageElement, distance: number): void {
    const url = this.urlOf(img)
    if (!url || !isReportableUrl(url)) return
    const elId = this.elementId(img)
    this.reported.set(img, url)
    if (!this.guard.tryEnqueue(elId, url)) return

    this.batcher.add({ elId, url, naturalW: img.naturalWidth, naturalH: img.naturalHeight, distance })
  }
}
