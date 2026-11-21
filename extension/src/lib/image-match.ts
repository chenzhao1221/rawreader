// RawReader extension: finds the page's <img> that belongs to a URL reported by the browser's context menu.
//
// The menu reports the URL the browser actually shows (`currentSrc`). Lazy-loading pages often keep the real URL
// in a data attribute until a script copies it into `src`, so every attribute that can hold the image URL is
// compared. Pure logic: the element type is a small structural interface so it runs in plain Node tests.

export interface ImageLike {
  tagName?: string;
  currentSrc?: string;
  src?: string;
  getAttribute(name: string): string | null;
}

/** Attributes that lazy-loading pages use to hold the real image URL. */
const LAZY_URL_ATTRIBUTES = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url", "data-original-src", "data-echo"];
/** Attributes that hold a srcset list ("url 1x, url 2x"). */
const SRCSET_ATTRIBUTES = ["srcset", "data-srcset", "data-lazy-srcset"];

/** Lower is a closer match. */
export type MatchRank = 0 | 1 | 2;

/** Resolves a URL against the page URL and drops the fragment. data: and blob: URLs only get trimmed. Null when unusable. */
export function normalizeImageUrl(raw: string | null | undefined, baseUrl: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^(data|blob):/i.test(value)) return value;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** The URLs in a srcset value, descriptors removed. A data: URL is kept whole (it can contain commas). */
export function parseSrcset(value: string | null | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  if (/^data:/i.test(text)) return [text.split(/\s+/)[0]!];
  const urls: string[] = [];
  for (const part of text.split(",")) {
    const url = part.trim().split(/\s+/)[0];
    if (url) urls.push(url);
  }
  return urls;
}

/** Every URL an image can be known by, ranked: 0 = what the browser shows, 1 = lazy-load attributes, 2 = srcset lists. */
export function imageUrlCandidates(img: ImageLike, baseUrl: string): { url: string; rank: MatchRank }[] {
  const out: { url: string; rank: MatchRank }[] = [];
  const add = (raw: string | null | undefined, rank: MatchRank) => {
    const url = normalizeImageUrl(raw, baseUrl);
    if (url) out.push({ url, rank });
  };
  add(img.currentSrc, 0);
  add(img.src, 0);
  add(img.getAttribute("src"), 0);
  for (const name of LAZY_URL_ATTRIBUTES) add(img.getAttribute(name), 1);
  for (const name of SRCSET_ATTRIBUTES) for (const url of parseSrcset(img.getAttribute(name))) add(url, 2);
  return out;
}

/** Best (lowest) rank at which the image matches the URL, or null. */
export function matchRank(img: ImageLike, srcUrl: string, baseUrl: string): MatchRank | null {
  const wanted = normalizeImageUrl(srcUrl, baseUrl);
  if (!wanted) return null;
  let best: MatchRank | null = null;
  for (const { url, rank } of imageUrlCandidates(img, baseUrl)) {
    if (url === wanted && (best === null || rank < best)) best = rank;
  }
  return best;
}

/**
 * Picks the image for a context-menu URL.
 * 1. The element the user right-clicked (`preferred`) wins when it matches at any rank.
 * 2. Otherwise the best-ranked match among all images; the first one in document order on a tie.
 * 3. Otherwise the right-clicked element itself when it is an <img>: the page rewrote its URL after the click, or
 *    the menu URL came from a source we cannot read, and the browser did hit-test that element.
 */
export function findImageForSrcUrl<T extends ImageLike>(
  images: Iterable<T>,
  srcUrl: string,
  baseUrl: string,
  preferred?: T | null,
): T | null {
  if (preferred && matchRank(preferred, srcUrl, baseUrl) !== null) return preferred;
  let best: T | null = null;
  let bestRank: MatchRank | null = null;
  for (const img of images) {
    const rank = matchRank(img, srcUrl, baseUrl);
    if (rank === null) continue;
    if (bestRank === null || rank < bestRank) {
      best = img;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  if (best) return best;
  if (preferred && preferred.tagName?.toUpperCase() === "IMG") return preferred;
  return null;
}
