// RawReader extension: the reading history (pure). Which comic pages the user translated, kept only in this
// browser's extension storage. It never reads the browser's own history and never leaves the machine.
// Stored: address, title, host, series and chapter (when a site rule gives them), two times and a count.
// Not stored: pictures, source text, translations.

export const READING_HISTORY_KEY = "local:reading-history";
export const READING_HISTORY_ENABLED_KEY = "local:reading-history-enabled";
/** Messages: the page asks the background to record a visit; the popup asks it to delete (all writes go through the background). */
export const MSG_HISTORY_TOUCH = "HISTORY_TOUCH";
export const MSG_HISTORY_REMOVE = "HISTORY_REMOVE";
export const MSG_HISTORY_CLEAR = "HISTORY_CLEAR";
export const HISTORY_MAX_ENTRIES = 1000;
export const HISTORY_MAX_URL = 2048;
export const HISTORY_MAX_TITLE = 200;
/** The same address touched again within this time counts once. */
export const HISTORY_DUPLICATE_WINDOW_MS = 5_000;
/** Pages of one chapter read within this time of each other become one entry. */
export const HISTORY_SAME_CHAPTER_WINDOW_MS = 30 * 60_000;

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  site: string;
  series: string;
  chapter: string;
  firstVisitedAt: number;
  lastVisitedAt: number;
  visits: number;
}

export interface HistoryTouch {
  url: string;
  title?: string | undefined;
  series?: string | undefined;
  chapter?: string | undefined;
}

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid", "_ga", "ref_src"]);

/** http(s) only. */
export function isSafeHistoryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The address as it is compared and stored: no fragment, no tracking parameters. Null for anything but http(s) or an address that is too long. */
export function normalizeHistoryUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  const text = url.href;
  return text.length > HISTORY_MAX_URL ? null : text;
}

const clip = (text: string | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export interface TouchOptions {
  now?: number;
  makeId?: () => string;
  max?: number;
}

/**
 * Records a visit. `list` is newest first and is not modified. Returns the new list, or the same list when the
 * touch changes nothing (a repeat of the same address within five seconds, an address that cannot be stored).
 *  - same address: updates title and time, counts a visit, moves to the front;
 *  - same site, series and chapter within 30 minutes: one entry, now pointing at the newest page;
 *  - otherwise a new entry. At most `max` entries are kept; the oldest by last visit go first.
 */
export function touchHistory(list: readonly HistoryEntry[], touch: HistoryTouch, options: TouchOptions = {}): HistoryEntry[] {
  const now = options.now ?? Date.now();
  const makeId = options.makeId ?? (() => crypto.randomUUID());
  const max = options.max ?? HISTORY_MAX_ENTRIES;
  const url = normalizeHistoryUrl(touch.url);
  if (!url) return list as HistoryEntry[];

  const title = clip(touch.title, HISTORY_MAX_TITLE);
  const series = clip(touch.series, 200);
  const chapter = clip(touch.chapter, 200);
  let site = "";
  try {
    site = new URL(url).hostname;
  } catch {
    // unreachable: the address was just parsed
  }

  const sameUrl = list.findIndex((e) => e.url === url);
  if (sameUrl >= 0) {
    const entry = list[sameUrl]!;
    if (now - entry.lastVisitedAt < HISTORY_DUPLICATE_WINDOW_MS) return list as HistoryEntry[];
    const updated: HistoryEntry = {
      ...entry,
      title: title || entry.title,
      series: series || entry.series,
      chapter: chapter || entry.chapter,
      lastVisitedAt: now,
      visits: entry.visits + 1,
    };
    return trim([updated, ...list.filter((_, i) => i !== sameUrl)], max);
  }

  if (series && chapter) {
    const sameChapter = list.findIndex(
      (e) => e.site === site && e.series === series && e.chapter === chapter && now - e.lastVisitedAt <= HISTORY_SAME_CHAPTER_WINDOW_MS,
    );
    if (sameChapter >= 0) {
      const entry = list[sameChapter]!;
      const updated: HistoryEntry = { ...entry, url, title: title || entry.title, lastVisitedAt: now, visits: entry.visits + 1 };
      return trim([updated, ...list.filter((_, i) => i !== sameChapter)], max);
    }
  }

  const created: HistoryEntry = { id: makeId(), url, title, site, series, chapter, firstVisitedAt: now, lastVisitedAt: now, visits: 1 };
  return trim([created, ...list], max);
}

/** Newest first, at most `max` entries: the ones with the oldest last visit are dropped. */
function trim(list: HistoryEntry[], max: number): HistoryEntry[] {
  const sorted = [...list].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
  return sorted.length > max ? sorted.slice(0, max) : sorted;
}

export const removeHistoryEntry = (list: readonly HistoryEntry[], id: string): HistoryEntry[] => list.filter((e) => e.id !== id);

/** Case-insensitive match on title, address, site and series. Every word of the query has to match somewhere. */
export function searchHistory(list: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((e) => {
    const hay = `${e.title}\n${e.url}\n${e.site}\n${e.series}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type HistoryGroupName = "今天" | "昨天" | "更早";

/** Groups a newest-first list for the popup. Days are local days. */
export function groupHistory(list: readonly HistoryEntry[], now: number): { name: HistoryGroupName; entries: HistoryEntry[] }[] {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const groups: Record<HistoryGroupName, HistoryEntry[]> = { 今天: [], 昨天: [], 更早: [] };
  for (const entry of list) {
    if (entry.lastVisitedAt >= today) groups["今天"].push(entry);
    else if (entry.lastVisitedAt >= yesterday) groups["昨天"].push(entry);
    else groups["更早"].push(entry);
  }
  return (Object.keys(groups) as HistoryGroupName[]).filter((name) => groups[name].length > 0).map((name) => ({ name, entries: groups[name] }));
}

/** Turns a stored value of unknown shape into a list. Entries with wrong types are dropped. */
export function parseHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.url !== "string" || typeof e.lastVisitedAt !== "number") continue;
    out.push({
      id: e.id,
      url: e.url,
      title: typeof e.title === "string" ? e.title : "",
      site: typeof e.site === "string" ? e.site : "",
      series: typeof e.series === "string" ? e.series : "",
      chapter: typeof e.chapter === "string" ? e.chapter : "",
      firstVisitedAt: typeof e.firstVisitedAt === "number" ? e.firstVisitedAt : e.lastVisitedAt,
      lastVisitedAt: e.lastVisitedAt,
      visits: typeof e.visits === "number" && e.visits >= 1 ? Math.floor(e.visits) : 1,
    });
  }
  return out;
}

/** Runs writes one after the other so two callers cannot overwrite each other's change. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}
