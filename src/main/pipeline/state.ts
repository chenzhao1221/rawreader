// Portions ported from libre-manga-translator src/entrypoints/content/translation-registry.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: keyed by image content hash instead of `src` plus page index, runs in the main
// process (no DOM events, no WXT storage), keeps element subscriptions per document so one run serves
// every element that shows the same bytes (R5.4), and claims carry a token so a cancelled run cannot
// overwrite a newer one.

import type { ImageFailure, ImageResult, Subscriber } from './types'

/** LMT statuses: idle, pending, done. `error` is new: a failed hash is retried only on request. */
export type RegistryStatus = 'idle' | 'pending' | 'done' | 'error'

export type Claim =
  /** First element for this hash: the caller must run the pipeline and finish with `markDone` or `markIdle`. */
  | { kind: 'start'; token: number }
  /** A run is already pending: the subscriber receives the result when it finishes. */
  | { kind: 'joined' }
  /** Result already known. */
  | { kind: 'done'; result: ImageResult }

interface Entry {
  status: RegistryStatus
  token: number
  result: ImageResult | null
  subscribers: Map<string, Subscriber>
}

export interface Completion {
  subscribers: Subscriber[]
  result: ImageResult | null
  failure: ImageFailure | null
}

const subscriberKey = (s: Subscriber): string => `${s.docId}\u0000${s.elId}`

/**
 * In-memory registry of pipeline state per content hash. Strict block as in
 * LMT: a second request for a pending hash never starts a second run. An
 * error or cancellation goes back to idle so a later request can retry.
 * Results stay in memory only (bounded by `maxResults`); the persistent cache
 * is a later slice.
 */
export class ImageRegistry {
  private readonly entries = new Map<string, Entry>()
  private nextToken = 1

  constructor(private readonly maxResults = 200) {}

  getStatus(hash: string): RegistryStatus {
    return this.entries.get(hash)?.status ?? 'idle'
  }

  /** Registers `subscriber` for `hash` and says who runs the work. */
  claim(hash: string, subscriber: Subscriber): Claim {
    const entry = this.entries.get(hash)
    if (entry?.status === 'done' && entry.result) {
      // Refresh recency for eviction.
      this.entries.delete(hash)
      this.entries.set(hash, entry)
      return { kind: 'done', result: entry.result }
    }
    if (entry?.status === 'pending') {
      entry.subscribers.set(subscriberKey(subscriber), subscriber)
      return { kind: 'joined' }
    }
    const token = this.nextToken++
    this.entries.set(hash, {
      status: 'pending',
      token,
      result: null,
      subscribers: new Map([[subscriberKey(subscriber), subscriber]]),
    })
    return { kind: 'start', token }
  }

  /** Finishes a run. Returns the subscribers to notify, or `null` when the token is stale. */
  markDone(hash: string, token: number, result: ImageResult): Completion | null {
    const entry = this.entries.get(hash)
    if (!entry || entry.token !== token || entry.status !== 'pending') return null
    const subscribers = [...entry.subscribers.values()]
    entry.status = 'done'
    entry.result = result
    entry.subscribers = new Map()
    this.evict()
    return { subscribers, result, failure: null }
  }

  /** Failure or cancellation: back to idle (LMT `markIdle`) so the pill or a rescan can retry. */
  markIdle(hash: string, token: number, failure: ImageFailure | null): Completion | null {
    const entry = this.entries.get(hash)
    if (!entry || entry.token !== token || entry.status !== 'pending') return null
    const subscribers = [...entry.subscribers.values()]
    this.entries.delete(hash)
    return { subscribers, result: null, failure }
  }

  /**
   * Navigation: forget every pending run and every subscriber of `docId`.
   * Finished results are kept (same bytes on the next page need no work).
   */
  dropDocument(docId: string): void {
    for (const [hash, entry] of [...this.entries]) {
      if (entry.status === 'pending') {
        // Stale tokens make the old run's completion a no-op.
        this.entries.delete(hash)
      } else {
        for (const [key, sub] of entry.subscribers) if (sub.docId === docId) entry.subscribers.delete(key)
      }
    }
  }

  /** Forgets one finished result so the next claim starts a fresh run (it was produced under other settings). */
  discardResult(hash: string): void {
    if (this.entries.get(hash)?.status === 'done') this.entries.delete(hash)
  }

  /** Forget everything, including results (cache cleared). */
  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  private evict(): void {
    let done = 0
    for (const entry of this.entries.values()) if (entry.status === 'done') done++
    for (const [hash, entry] of this.entries) {
      if (done <= this.maxResults) break
      if (entry.status === 'done') {
        this.entries.delete(hash)
        done--
      }
    }
  }
}
