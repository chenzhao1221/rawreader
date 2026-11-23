// Portions ported from libre-manga-translator src/entrypoints/content/auto-translate.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
import { resolveActiveSiteRule, type SiteRule } from "@/lib/adapters";
import * as Registry from "./translation-registry";
import { getElementSrc, type MangaTargetElement } from "@/lib/canvas";

export type TranslateFn = (img: MangaTargetElement) => Promise<void>;

export const MANUAL_CONCURRENCY = 3;

/** The three classes the queue serves, most urgent first: a menu click, a picture on screen, everything else. */
export type QueueClass = "manual" | "viewport" | "offscreen";

const CLASS_RANK: Record<QueueClass, number> = { manual: 2, viewport: 1, offscreen: 0 };

interface QueueEntry {
  img: MangaTargetElement;
  fn: TranslateFn;
  manual: boolean;
}

/** True when any part of the element is on screen right now. */
export function isOnScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth && r.width > 0 && r.height > 0;
}

export interface EnqueueOptions {
  /** The user asked for this picture (menu click). It goes before everything that was queued by itself. */
  manual?: boolean;
}

export class AutoTranslateQueue {
  private queue: QueueEntry[] = [];
  // Slots are held for the full pipeline lifetime and released on the
  // registry `lmt:translation-status` done/partial/idle events — NOT when
  // translateFn settles (it resolves right after overlay mount, long
  // before detect/translate/inpaint finish). Keyed by page element: two
  // pictures with the same address are two tasks.
  private inFlight = new Set<Element>();
  private concurrency = 1;
  private seen = new WeakSet<Element>();
  private lastTranslateFn: TranslateFn | null = null;
  private statusListener: ((e: Event) => void) | null = null;
  /** Called when a picture joins the queue (the status bar starts its line here). */
  onQueued: ((img: MangaTargetElement, manual: boolean) => void) | null = null;
  /** Execution order, for tests and the measurements: element and class at the moment it was started. */
  readonly started: { img: Element; class: QueueClass }[] = [];

  constructor() {
    this.statusListener = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; owner?: Element; status?: string }>).detail;
      if (!detail || !detail.owner) return;
      if (detail.status !== "done" && detail.status !== "idle" && detail.status !== "partial") return;
      const owner = detail.owner;
      if (detail.status === "idle") {
        // Failure/close/error → allow retry via the menu or rescan.
        // Must run even when the slot was already released on `done`:
        // done keeps `seen` (anti-requeue while overlay is open), and the
        // close path fires idle after inFlight was deleted — without this,
        // the second click is silently dropped forever.
        this.seen.delete(owner);
      }
      if (!this.inFlight.has(owner)) return;
      this.inFlight.delete(owner);
      // done and partial → keep `seen` so finished pages never requeue.
      if (this.lastTranslateFn) this.drain();
    };
    document.addEventListener("lmt:translation-status", this.statusListener);
  }

  destroy() {
    if (this.statusListener) {
      document.removeEventListener(
        "lmt:translation-status",
        this.statusListener,
      );
      this.statusListener = null;
    }
  }

  setConcurrency(n: number) {
    const clamped = Math.min(10, Math.max(1, Math.trunc(n) || 1));
    if (clamped === this.concurrency) return;
    this.concurrency = clamped;
    if (this.lastTranslateFn && this.inFlight.size < this.concurrency && this.queue.length > 0) {
      this.drain();
    }
  }

  getConcurrency() {
    return this.concurrency;
  }

  evict(img: MangaTargetElement) {
    this.seen.delete(img);
    if (this.inFlight.delete(img) && this.lastTranslateFn) {
      this.drain();
    }
  }

  enqueue(img: MangaTargetElement, translateFn: TranslateFn, options: EnqueueOptions = {}) {
    const manual = options.manual === true;
    const src = getElementSrc(img);
    if (!src) return;

    // Already waiting: a menu click moves it to the front class, nothing else changes.
    const waiting = this.queue.find((e) => e.img === img);
    if (waiting) {
      if (manual) waiting.manual = true;
      return;
    }
    const status = Registry.getStatus(src, img);
    if (Registry.isPending(src, img) || this.inFlight.has(img) || status === "done") return;
    // A page that came back only in part is retried by the menu click (the pipeline does the retry), never by the scanner.
    if (status === "partial" && !manual) return;
    if (!manual && this.seen.has(img)) return;

    this.seen.add(img);
    this.queue.push({ img, fn: translateFn, manual });
    this.lastTranslateFn = translateFn;
    this.onQueued?.(img, manual);
    this.drain();
  }

  /** Class of a queued picture now: the screen is read when the slot frees up, not when the picture was queued. */
  private classOf(entry: QueueEntry): QueueClass {
    if (entry.manual) return "manual";
    return isOnScreen(entry.img) ? "viewport" : "offscreen";
  }

  /** Index of the entry to start next: highest class first, first come first served inside a class. */
  private pickNext(): number {
    let best = -1;
    let bestRank = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const rank = CLASS_RANK[this.classOf(this.queue[i]!)];
      if (rank > bestRank) {
        best = i;
        bestRank = rank;
        if (rank === CLASS_RANK.manual) break;
      }
    }
    return best;
  }

  private drain() {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const index = this.pickNext();
      const entry = this.queue.splice(index, 1)[0]!;
      const targetImg = entry.img;
      const translateFn = entry.fn;
      const src = getElementSrc(targetImg);
      if (!src || !document.body.contains(targetImg)) {
        // Skip detached images without consuming a slot
        this.seen.delete(targetImg);
        continue;
      }
      // Strict registry guard at drain time as well (covers race between enqueue and drain)
      if (Registry.isPending(src, targetImg) || this.inFlight.has(targetImg)) {
        continue;
      }
      if (Registry.getStatus(src, targetImg) === "done") {
        this.seen.delete(targetImg);
        continue;
      }

      this.started.push({ img: targetImg, class: this.classOf(entry) });
      if (this.started.length > 50) this.started.shift();
      this.inFlight.add(targetImg);
      // Fire-and-forget: translateFn sets up its own overlay and async
      // flow. Failure or done signals through the registry event above.
      translateFn(targetImg)
        .then(() => {
          const status = Registry.getStatus(src, targetImg);
          if (status !== "pending" && status !== "done" && status !== "partial") {
            this.inFlight.delete(targetImg);
            this.seen.delete(targetImg);
            Registry.markIdle(src, undefined, targetImg);
            this.drain();
          }
        })
        .catch((err) => {
          console.warn("LMT: auto-translate task failed:", err);
          this.inFlight.delete(targetImg);
          this.seen.delete(targetImg);
          Registry.markIdle(src, undefined, targetImg);
          this.drain();
        });
    }
  }

  clear() {
    for (const entry of this.queue) this.seen.delete(entry.img);
    this.queue = [];
  }

  get length() {
    return this.queue.length;
  }

  get activeCount() {
    return this.inFlight.size;
  }
}

export class AutoTranslateOrchestrator {
  private isEnabled = false;
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private queue = new AutoTranslateQueue();
  private observedImages = new WeakSet<MangaTargetElement>();
  private activeRule: SiteRule | null = null;
  private translateFn: ((img: MangaTargetElement) => Promise<void>) | null = null;
  private unwatchStorage: (() => void) | null = null;
  private unwatchConcurrency: (() => void) | null = null;

  async init(
    translateFn: (img: MangaTargetElement) => Promise<void>,
    hooks: { onQueued?: (img: MangaTargetElement, manual: boolean) => void } = {},
  ) {
    this.translateFn = translateFn;
    this.queue.onQueued = hooks.onQueued ?? null;

    await this.applyCap();
    const initialEnabled =
      await storage.getItem<boolean>("sync:auto-translate");
    if (initialEnabled ?? false) {
      await this.start();
    }

    this.unwatchStorage = storage.watch<boolean>(
      "sync:auto-translate",
      async (newVal) => {
        if (newVal) {
          // Cap first so the rescan drains at the slider value, not stale 3.
          await this.applyCap();
          this.start();
        } else {
          this.stop();
          // Manual-only mode: absolute cap of 3, slider ignored.
          this.queue.setConcurrency(MANUAL_CONCURRENCY);
        }
      },
    );

    this.unwatchConcurrency = storage.watch<number>(
      "sync:auto-translate-concurrency",
      async () => {
        await this.applyCap();
      },
    );
  }

  /** Menu click on one picture: it goes before everything the queue picked up by itself. */
  enqueueManual(img: MangaTargetElement) {
    if (this.translateFn) {
      this.queue.enqueue(img, this.translateFn, { manual: true });
    }
  }

  /**
   * Right-click "translate this page's images": queues every loaded, qualifying image on the page once, nearest to
   * the top of the viewport first. Works with auto-translate off. Returns how many images were offered to the queue.
   */
  async enqueueAllQualifying(): Promise<number> {
    if (!this.translateFn) return 0;
    this.activeRule ??= await resolveActiveSiteRule();
    const found: MangaTargetElement[] = [];
    if (this.activeRule?.imageSelector) {
      try {
        const root = this.activeRule.containerSelector
          ? document.querySelector(this.activeRule.containerSelector) ?? document
          : document;
        found.push(...root.querySelectorAll<MangaTargetElement>(this.activeRule.imageSelector));
      } catch {
        // Selector syntax error: fall back to the generic scan.
      }
    }
    if (found.length === 0) found.push(...document.querySelectorAll<MangaTargetElement>("img, canvas"));

    const ready = found.filter((img) =>
      (img instanceof HTMLCanvasElement ? img.width > 0 && img.height > 0 : img.complete && img.naturalWidth > 0) &&
      this.isQualifyingImage(img),
    );
    ready.sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top));
    for (const img of ready) {
      if (this.translateFn) this.queue.enqueue(img, this.translateFn);
    }
    return ready.length;
  }

  /** Unified cap: slider 1..10 when auto ON, absolute 3 when OFF. */
  private async applyCap() {
    const [enabled, slider] = await Promise.all([
      storage.getItem<boolean>("sync:auto-translate"),
      storage.getItem<number>("sync:auto-translate-concurrency"),
    ]);
    this.queue.setConcurrency(
      enabled ? (slider ?? 1) : MANUAL_CONCURRENCY,
    );
  }

  async start() {
    if (this.isEnabled) return;
    this.isEnabled = true;
    this.activeRule = await resolveActiveSiteRule();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            (entry.target instanceof HTMLImageElement || entry.target instanceof HTMLCanvasElement)
          ) {
            const img = entry.target;
            this.observer?.unobserve(img);
            if (this.translateFn) {
              this.queue.enqueue(img, this.translateFn);
            }
          }
        }
      },
      {
        root: null,
        rootMargin: "200px",
        threshold: 0,
      },
    );

    this.scanAndObserve();

    this.mutationObserver = new MutationObserver((mutations) => {
      if (!this.isEnabled) return;
      let shouldScan = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        this.scanAndObserve();
      }
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stop() {
    this.isEnabled = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    this.queue.clear();
    // Fresh WeakSet so a restart rescan re-observes dropped pages.
    // In-flight pipelines keep their registry slots and finish normally.
    this.observedImages = new WeakSet();
  }

  destroy() {
    this.stop();
    this.queue.destroy();
    if (this.unwatchStorage) {
      this.unwatchStorage();
      this.unwatchStorage = null;
    }
    if (this.unwatchConcurrency) {
      this.unwatchConcurrency();
      this.unwatchConcurrency = null;
    }
  }

  private isQualifyingImage(img: MangaTargetElement): boolean {
    if (this.activeRule?.imageSelector) {
      try {
        if (img.matches(this.activeRule.imageSelector)) return true;
      } catch {
        // Selector syntax error fallback
      }
    }

    // Generic fallback: images or canvases must be strictly > 500px in both dimensions
    const naturalW = "naturalWidth" in img ? img.naturalWidth : img.width;
    const naturalH = "naturalHeight" in img ? img.naturalHeight : img.height;
    const clientW = img.clientWidth || img.offsetWidth;
    const clientH = img.clientHeight || img.offsetHeight;

    if (naturalW > 0 && naturalH > 0) {
      return naturalW > 500 && naturalH > 500;
    }

    return clientW > 500 && clientH > 500;
  }

  private observeImage(img: MangaTargetElement) {
    if (this.observedImages.has(img)) return;
    const src = getElementSrc(img);
    if (!src) return;
    if (Registry.isPending(src, img) || Registry.getStatus(src, img) === "done") return;

    const isReady =
      img instanceof HTMLCanvasElement
        ? img.width > 0 && img.height > 0
        : img.complete && img.naturalWidth > 0;

    if (isReady) {
      if (this.isQualifyingImage(img)) {
        this.observedImages.add(img);
        this.observer?.observe(img);
      }
    } else if (img instanceof HTMLImageElement) {
      const onLoad = () => {
        img.removeEventListener("load", onLoad);
        if (!this.isEnabled) return;
        const loadedSrc = getElementSrc(img);
        if (Registry.isPending(loadedSrc, img) || Registry.getStatus(loadedSrc, img) === "done") return;
        if (this.isQualifyingImage(img)) {
          this.observedImages.add(img);
          this.observer?.observe(img);
        }
      };
      img.addEventListener("load", onLoad, { once: true });
    }
  }

  private scanAndObserve() {
    if (!this.isEnabled) return;

    if (this.activeRule?.imageSelector) {
      const root = this.activeRule.containerSelector
        ? document.querySelector(this.activeRule.containerSelector) ?? document
        : document;

      try {
        const matchingImgs = root.querySelectorAll<MangaTargetElement>(
          this.activeRule.imageSelector,
        );
        matchingImgs.forEach((img) => this.observeImage(img));
        if (matchingImgs.length > 0) return;
      } catch {
        // Fall back to generic scan if rule query fails
      }
    }

    // Fallback scan across all document images & canvases
    const allImages = document.querySelectorAll<MangaTargetElement>("img, canvas");
    allImages.forEach((img) => this.observeImage(img));
  }
}
