// RawReader extension: the queue of visits that wait to be reported to the desktop app (pure).
// The history lives in the app. A visit is kept here only until the app has taken it; when the app is closed, the
// queue holds the latest visits (300 at most) and they are sent as soon as the app answers again.

import { HISTORY_MAX_TITLE, normalizeHistoryUrl, type HistoryEntry, type HistoryTouch } from "./reading-history";

export const HISTORY_PENDING_KEY = "local:history-pending";
export const HISTORY_PENDING_MAX = 300;
/** Most visits in one request; the app accepts 200. */
export const HISTORY_BATCH_SIZE = 200;

/** A visit waiting for the app. Empty text fields are empty strings. */
export interface PendingVisit {
  url: string;
  title: string;
  series: string;
  chapter: string;
  /** Milliseconds since the epoch. */
  visitedAt: number;
}

/** One item of `POST /history` as the app expects it (empty fields left out). */
export interface BridgeHistoryItem {
  url: string;
  title?: string;
  series?: string;
  chapter?: string;
  visitedAt: number;
}

const clip = (text: string | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Adds a visit. Same address: one item with the newest time (and any text it brings). The oldest go when over the cap. */
export function addPending(list: readonly PendingVisit[], touch: HistoryTouch, now: number, max = HISTORY_PENDING_MAX): PendingVisit[] {
  const url = normalizeHistoryUrl(touch.url);
  if (!url) return list as PendingVisit[];
  const visit: PendingVisit = {
    url,
    title: clip(touch.title, HISTORY_MAX_TITLE),
    series: clip(touch.series, 200),
    chapter: clip(touch.chapter, 200),
    visitedAt: now,
  };
  return mergePending(list, [visit], max);
}

/** Union by address: the newest time wins, empty text fields are filled from the other copy. Newest last, capped at `max`. */
export function mergePending(a: readonly PendingVisit[], b: readonly PendingVisit[], max = HISTORY_PENDING_MAX): PendingVisit[] {
  const byUrl = new Map<string, PendingVisit>();
  for (const visit of [...a, ...b]) {
    const old = byUrl.get(visit.url);
    if (!old) {
      byUrl.set(visit.url, visit);
      continue;
    }
    const [older, newer] = old.visitedAt <= visit.visitedAt ? [old, visit] : [visit, old];
    byUrl.set(visit.url, {
      url: visit.url,
      title: newer.title || older.title,
      series: newer.series || older.series,
      chapter: newer.chapter || older.chapter,
      visitedAt: newer.visitedAt,
    });
  }
  const sorted = [...byUrl.values()].sort((x, y) => x.visitedAt - y.visitedAt);
  return sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

/** Turns a stored value of unknown shape into a queue. Entries with wrong types are dropped. */
export function parsePending(value: unknown): PendingVisit[] {
  if (!Array.isArray(value)) return [];
  const out: PendingVisit[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.url !== "string" || typeof v.visitedAt !== "number" || !Number.isFinite(v.visitedAt)) continue;
    const url = normalizeHistoryUrl(v.url);
    if (!url) continue;
    out.push({
      url,
      title: typeof v.title === "string" ? clip(v.title, HISTORY_MAX_TITLE) : "",
      series: typeof v.series === "string" ? clip(v.series, 200) : "",
      chapter: typeof v.chapter === "string" ? clip(v.chapter, 200) : "",
      visitedAt: v.visitedAt,
    });
  }
  return out;
}

/** The list older versions kept in the extension, as queue items (one visit per entry, at its last visit). */
export function pendingFromLegacy(entries: readonly HistoryEntry[]): PendingVisit[] {
  return parsePending(
    entries.map((e) => ({ url: e.url, title: e.title, series: e.series, chapter: e.chapter, visitedAt: e.lastVisitedAt })),
  );
}

/** The oldest visits, at most one request worth. */
export const nextBatch = (list: readonly PendingVisit[], size = HISTORY_BATCH_SIZE): PendingVisit[] => list.slice(0, size);

/** Drops the visits the app has taken. A visit that changed in the meantime (newer time) stays. */
export function removeSent(list: readonly PendingVisit[], sent: readonly PendingVisit[]): PendingVisit[] {
  const done = new Set(sent.map((v) => `${v.url}\n${v.visitedAt}`));
  return list.filter((v) => !done.has(`${v.url}\n${v.visitedAt}`));
}

export function toBridgeItems(list: readonly PendingVisit[]): BridgeHistoryItem[] {
  return list.map((v) => ({
    url: v.url,
    ...(v.title ? { title: v.title } : {}),
    ...(v.series ? { series: v.series } : {}),
    ...(v.chapter ? { chapter: v.chapter } : {}),
    visitedAt: v.visitedAt,
  }));
}
