// RawReader extension: reading-history helpers (pure). The history itself lives in the RawReader desktop app (the
// extension only reports pages over the local bridge; see history-sync.ts). It never reads the browser's own history.
// What is reported: address, title, and series and chapter when a site rule gives them. Not pictures, text or translations.

/** Legacy: older versions kept the whole list here. It is moved to the pending queue once and then removed. */
export const READING_HISTORY_KEY = "local:reading-history";
/** The switch in the popup: when off, nothing is reported. */
export const READING_HISTORY_ENABLED_KEY = "local:reading-history-enabled";
/** Messages: a page asks the background to record a visit; the popup asks it to show the history in the app. */
export const MSG_HISTORY_TOUCH = "HISTORY_TOUCH";
export const MSG_HISTORY_OPEN = "HISTORY_OPEN";
export const HISTORY_MAX_URL = 2048;
export const HISTORY_MAX_TITLE = 200;

/** One entry of the legacy list. */
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
