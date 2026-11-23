// Portions ported from libre-manga-translator src/entrypoints/content/translation-registry.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
import { DefaultConfig } from "@/lib/configs";
import { getSiteRule } from "@/lib/adapters";
import { quickHash, resolveImagePageIndex } from "./utils";
import type { MangaTargetElement } from "@/lib/canvas";

/**
 * LMT-only, content-isolated translation registry.
 * Strict block: pending → any second request for the same page element returns immediately.
 * Error/crash → markIdle (delete) so the menu command or queue can retrigger.
 * No window.__LMT__ exposure — page world cannot see or bypass.
 *
 * Status is kept per page element (`owner`), not per picture address: a reader can show the same address twice
 * and each of the two pictures is its own task. A call without an owner falls back to the address (older callers).
 */

export type TranslationStatus = "idle" | "pending" | "done" | "partial";

/** The element a status belongs to, or the picture address for a call that has no element. */
export type Owner = object | undefined;

const bySrc = new Map<string, TranslationStatus>(); // srcKey(originalSrc) → status (no owner)
const byOwner = new WeakMap<object, TranslationStatus>();
const byCacheKey = new Map<string, TranslationStatus>(); // `${local:page-cache-…}|${owner id}` → status

let nextOwnerId = 1;
const ownerIds = new WeakMap<object, number>();
const ownerId = (owner: Owner): number => {
  if (!owner) return 0;
  let id = ownerIds.get(owner);
  if (id === undefined) {
    id = nextOwnerId++;
    ownerIds.set(owner, id);
  }
  return id;
};
const cacheSlot = (cacheKey: string, owner: Owner): string => `${cacheKey}|${ownerId(owner)}`;

export function srcKeyOf(src: string): string {
  return src.startsWith("data:") ? quickHash(src) : src;
}

export async function resolveCacheKey(
  img: MangaTargetElement,
  originalSrc: string,
): Promise<string> {
  const { seriesName, chapterId, pageIndex } = await getSiteRule();
  const resolvedPage = resolveImagePageIndex(img, originalSrc, pageIndex);
  const targetLang =
    (await storage.getItem<string>("sync:target-lang")) ?? DefaultConfig.targetLang;
  const imgHash = quickHash(originalSrc);
  return `local:page-cache-${targetLang}-${seriesName}-${chapterId}-p${resolvedPage}-${imgHash}`;
}

export function getStatus(src: string, owner?: Owner): TranslationStatus {
  return (owner ? byOwner.get(owner) : bySrc.get(srcKeyOf(src))) ?? "idle";
}

export function isPending(src: string, owner?: Owner): boolean {
  return getStatus(src, owner) === "pending";
}

export function isDone(src: string, owner?: Owner): boolean {
  return getStatus(src, owner) === "done";
}

export function getStatusByCacheKey(cacheKey: string, owner?: Owner): TranslationStatus {
  return byCacheKey.get(cacheSlot(cacheKey, owner)) ?? "idle";
}

function setStatus(src: string, owner: Owner, status: TranslationStatus): void {
  if (owner) byOwner.set(owner, status);
  else bySrc.set(srcKeyOf(src), status);
}

function emit(src: string, cacheKey: string | undefined, owner: Owner, status: TranslationStatus): void {
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, owner, status },
    }),
  );
}

/** Moves every cache-key claim of this picture and owner that is still `from` to `to` (or drops it). */
function settleCacheKeys(src: string, owner: Owner, from: TranslationStatus, to: TranslationStatus | null): void {
  // Overlay calls without the full page-cache key (it has no img element to resolve the page index). Without this
  // sweep the entry stays "pending" forever and the second-run guard deadlocks every retry. All keys for this src
  // share the `-${imgHash}` suffix, so settle them together.
  const suffix = `-${quickHash(src)}|${ownerId(owner)}`;
  for (const [key, status] of [...byCacheKey]) {
    if (!key.endsWith(suffix)) continue;
    if (to === null) byCacheKey.delete(key);
    else if (status === from) byCacheKey.set(key, to);
  }
}

export function markPending(src: string, cacheKey?: string, owner?: Owner): void {
  setStatus(src, owner, "pending");
  if (cacheKey) byCacheKey.set(cacheSlot(cacheKey, owner), "pending");
  emit(src, cacheKey, owner, "pending");
}

export function markDone(src: string, cacheKey?: string, owner?: Owner): void {
  setStatus(src, owner, "done");
  if (cacheKey) byCacheKey.set(cacheSlot(cacheKey, owner), "done");
  else settleCacheKeys(src, owner, "pending", "done");
  emit(src, cacheKey, owner, "done");
}

/** The run is over but not every part came back. The queue lets its slot go and never re-queues it; no cache is written. */
export function markPartial(src: string, cacheKey?: string, owner?: Owner): void {
  setStatus(src, owner, "partial");
  if (cacheKey) byCacheKey.set(cacheSlot(cacheKey, owner), "partial");
  else settleCacheKeys(src, owner, "pending", "partial");
  emit(src, cacheKey, owner, "partial");
}

export function markIdle(src: string, cacheKey?: string, owner?: Owner): void {
  if (owner) byOwner.delete(owner);
  else bySrc.delete(srcKeyOf(src));
  if (cacheKey) byCacheKey.delete(cacheSlot(cacheKey, owner));
  else settleCacheKeys(src, owner, "pending", null);
  emit(src, cacheKey, owner, "idle");
}

// ── One request for a picture address that is shown twice ──
// The two pictures are two tasks (own overlay, own status line), but the answer is the same, so the second one
// joins the request that is already running instead of paying for it again. It is told everything the first one
// was told. The request is cancelled only when every task that joined has gone.

interface SharedEntry {
  events: unknown[];
  listeners: Set<(event: any) => void>;
  controller: AbortController;
  refs: number;
  settled: boolean;
  promise: Promise<any>;
}

const sharedCalls = new Map<string, SharedEntry>();

export function joinSharedCall<E, R>(
  key: string,
  start: (emit: (event: E) => void, signal: AbortSignal) => Promise<R>,
  options: { onEvent: (event: E) => void; signal?: AbortSignal | undefined; cancelled: R },
): Promise<R> {
  let entry = sharedCalls.get(key);
  if (!entry) {
    const created: SharedEntry = {
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      refs: 0,
      settled: false,
      promise: Promise.resolve(),
    };
    const emitAll = (event: E) => {
      created.events.push(event);
      for (const listener of [...created.listeners]) listener(event);
    };
    created.promise = start(emitAll, created.controller.signal).finally(() => {
      created.settled = true;
      if (sharedCalls.get(key) === created) sharedCalls.delete(key);
    });
    sharedCalls.set(key, created);
    entry = created;
  }
  const joined = entry;
  joined.refs += 1;
  for (const event of joined.events) options.onEvent(event as E);
  joined.listeners.add(options.onEvent as (event: unknown) => void);

  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    joined.listeners.delete(options.onEvent as (event: unknown) => void);
    joined.refs -= 1;
    if (joined.refs <= 0 && !joined.settled) joined.controller.abort();
  };
  const gone = new Promise<R>((resolve) => {
    if (options.signal?.aborted) {
      leave();
      resolve(options.cancelled);
      return;
    }
    options.signal?.addEventListener(
      "abort",
      () => {
        leave();
        resolve(options.cancelled);
      },
      { once: true },
    );
  });
  return Promise.race([joined.promise as Promise<R>, gone]).finally(() => {
    // A normal finish: just drop this listener (the request is over, nothing to cancel).
    left = true;
    joined.listeners.delete(options.onEvent as (event: unknown) => void);
  });
}
