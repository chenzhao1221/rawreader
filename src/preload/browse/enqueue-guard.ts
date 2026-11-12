// Portions ported from libre-manga-translator src/entrypoints/content/auto-translate.ts (`AutoTranslateQueue`
// seen-key and queue bookkeeping) @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: the in-page queue only de-duplicates and batches. Concurrency, priority and
// cancellation moved to the main process (p-queue). Keys are element id + URL, not `src` alone.

/**
 * Enqueue-once bookkeeping for one document. An element is reported once per
 * URL; if a site swaps the element's URL (lazy loading, SPA reuse) the new URL
 * counts as new work. `clear()` forgets everything (auto-translate turned off).
 */
export class EnqueueGuard {
  private readonly seen = new Set<string>()

  private key(elId: string, url: string): string {
    return `${elId}\u0000${url}`
  }

  /** Returns true the first time an (element, URL) pair is offered. */
  tryEnqueue(elId: string, url: string): boolean {
    const key = this.key(elId, url)
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }

  /** Allows a retry, for example after a failed load. */
  forget(elId: string, url: string): void {
    this.seen.delete(this.key(elId, url))
  }

  clear(): void {
    this.seen.clear()
  }

  get size(): number {
    return this.seen.size
  }
}

export interface BatcherOptions<T> {
  flush: (items: T[]) => void
  delayMs: number
  maxItems: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Collects items for a short time, then flushes them as one batch, so a burst
 * of images entering the viewport becomes one IPC message that main can sort
 * by distance.
 */
export class Batcher<T> {
  private items: T[] = []
  private handle: unknown = null
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: BatcherOptions<T>) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  add(item: T): void {
    this.items.push(item)
    if (this.items.length >= this.options.maxItems) {
      this.flushNow()
      return
    }
    if (this.handle === null) {
      this.handle = this.setTimer(() => this.flushNow(), this.options.delayMs)
    }
  }

  flushNow(): void {
    if (this.handle !== null) {
      this.clearTimer(this.handle)
      this.handle = null
    }
    if (this.items.length === 0) return
    const batch = this.items
    this.items = []
    this.options.flush(batch)
  }

  /** Drops queued items without sending them. */
  clear(): void {
    if (this.handle !== null) {
      this.clearTimer(this.handle)
      this.handle = null
    }
    this.items = []
  }
}
