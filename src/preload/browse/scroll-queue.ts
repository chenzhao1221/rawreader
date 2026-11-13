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
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target instanceof HTMLImageElement) {
            this.observer?.unobserve(entry.target)
            this.enqueue(entry.target)
          }
        }
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
    if (this.sweepTimer !== null) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.scan()
    }, SWEEP_DELAY_MS)
  }
  /** Stops observing and drops queued, unsent work. Already reported images are not recalled here. */
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
    }    this.observer?.disconnect()
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

  private scan(): void {
    if (!this.observer) return
    this.doc.querySelectorAll('img').forEach((img) => this.observe(img))
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

  private observe(img: HTMLImageElement): void {
    const config = this.config
    if (!config?.enabled || !this.observer) return
    const url = this.urlOf(img)
    if (!url || !isReportableUrl(url)) return
    if (this.reported.get(img) === url) return
    if (this.observed.get(img) === url) {
      this.enqueueIfInRange(img)
      return
    }

    if (img.complete && img.naturalWidth > 0) {
      if (!qualifiesBySize(img.naturalWidth, img.naturalHeight, config.minImageSize)) return
      this.observed.set(img, url)
      this.observer.observe(img)
      this.enqueueIfInRange(img)
    } else if (!this.waiting.has(img)) {
      this.waiting.add(img)
      img.addEventListener(
        'load',
        () => {
          this.waiting.delete(img)
          this.observe(img)
        },
        { once: true },
      )
    }
  }

  /** Geometry path: enqueue right away when the image is already within ootMarginPx of the viewport. */
  private enqueueIfInRange(img: HTMLImageElement): void {
    const config = this.config
    if (!config?.enabled) return
    const rect = img.getBoundingClientRect()
    const viewportHeight = this.doc.defaultView?.innerHeight ?? 0
    if (distanceToViewport(rect.top, rect.bottom, viewportHeight) > config.rootMarginPx) return
    this.observer?.unobserve(img)
    this.enqueue(img)
  }

  private elementId(img: HTMLImageElement): string {
    let id = img.getAttribute(ELEMENT_ID_ATTR)
    if (!id) {
      id = `rr${this.nextId++}`
      img.setAttribute(ELEMENT_ID_ATTR, id)
    }
    return id
  }

  private enqueue(img: HTMLImageElement): void {
    const url = this.urlOf(img)
    if (!url || !isReportableUrl(url)) return
    const elId = this.elementId(img)
    this.reported.set(img, url)
    if (!this.guard.tryEnqueue(elId, url)) return

    const rect = img.getBoundingClientRect()
    const viewportHeight = this.doc.defaultView?.innerHeight ?? 0
    this.batcher.add({
      elId,
      url,
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      distance: Math.max(0, Math.round(distanceToViewport(rect.top, rect.bottom, viewportHeight))),
    })
  }
}
