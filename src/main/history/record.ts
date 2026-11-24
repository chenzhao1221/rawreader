/**
 * Reading history, pure part: what a visit is allowed to store. Only http(s) pages are kept, without fragment and
 * tracking parameters. Pictures, page text and translations are never stored.
 */

export const HISTORY_MAX_ENTRIES = 5000
export const HISTORY_MAX_URL = 2048
export const HISTORY_MAX_TITLE = 200
/** The same address touched again within this time counts once. */
export const HISTORY_DUPLICATE_WINDOW_MS = 5_000
/** Pages of one series and chapter read within this time of each other become one entry. */
export const HISTORY_SAME_CHAPTER_WINDOW_MS = 30 * 60_000

/** A visit as reported by the built-in browser or by the extension. */
export interface HistoryTouch {
  url: string
  title?: string | undefined
  series?: string | undefined
  chapter?: string | undefined
  /** Time of the visit in ms since the epoch. Defaults to now; a future time counts as now. */
  at?: number | undefined
  /**
   * True for "the page I already recorded finished loading / changed its title": it fills in the title of an
   * existing entry and never counts a visit.
   */
  refresh?: boolean | undefined
}

/** A visit after cleaning: every field is in its stored form. */
export interface CleanTouch {
  url: string
  title: string
  site: string
  series: string
  chapter: string
  at: number
  refresh: boolean
}

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', '_ga', 'ref_src'])

/** The address as it is compared and stored. Null for anything but http(s), or an address that is too long. */
export function normalizeHistoryUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase()
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) url.searchParams.delete(key)
  }
  const text = url.href
  return text.length > HISTORY_MAX_URL ? null : text
}

const clip = (text: string | undefined, max: number): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Cleans a visit, or returns null when it cannot be stored. */
export function cleanTouch(touch: HistoryTouch, now: number): CleanTouch | null {
  const url = normalizeHistoryUrl(touch.url)
  if (!url) return null
  const at = typeof touch.at === 'number' && Number.isFinite(touch.at) && touch.at > 0 ? Math.min(Math.floor(touch.at), now) : now
  return {
    url,
    title: clip(touch.title, HISTORY_MAX_TITLE),
    site: new URL(url).hostname,
    series: clip(touch.series, 200),
    chapter: clip(touch.chapter, 200),
    at,
    refresh: touch.refresh === true,
  }
}

/** Splits a search query into lower-case words. Every word has to match somewhere. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
}
