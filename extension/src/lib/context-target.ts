// RawReader extension: which picture a right-click means (pure; the page supplies the DOM queries).
//
// The browser's menu gives an image address only when the click lands on an <img>. Readers cover the picture with
// transparent page-flip layers, paint it on a <canvas>, wrap it in links, or show the same picture twice. So the
// content script records where the click landed and this module picks the element from that.

export interface TargetEnv {
  /** `document.elementsFromPoint`, topmost first. */
  elementsAt(x: number, y: number): Element[];
  /** True for a picture element big enough to be a comic page (the click landed on it itself). */
  qualifies(el: Element): boolean;
  /** Stricter test for a picture that lies under something else at the click (a flip layer, a link, an ad). */
  qualifiesBeneath(el: Element): boolean;
  /** True for an element that belongs to this extension's own UI (overlay, status bar, sidebar). */
  isOwnUi(el: Element): boolean;
  /** The picture an overlay of ours is drawn over, or null. */
  originalOfOverlay(el: Element): Element | null;
  /**
   * Lenient size test for the last resort: the user asked for this spot explicitly, so a smaller picture (a
   * narrow column, a thumbnail grid) still counts when nothing bigger lies there.
   */
  qualifiesLoosely?(el: Element): boolean;
  /** The picture an element paints as its CSS background (normalised address), or null. */
  backgroundUrlOf?(el: Element): string | null;
  /** The <img> of the page that shows this address, or null. Sites often keep one next to a background copy. */
  pictureByUrl?(url: string): Element | null;
}

export const isPictureElement = (el: Element | null | undefined): el is HTMLImageElement | HTMLCanvasElement =>
  !!el && (el.tagName === "IMG" || el.tagName === "CANVAS");

/**
 * The picture under a right-click, or null when there is none ("no comic here").
 * 1. The clicked element itself, when it is a picture of page size.
 * 2. One of our own overlays: the picture it covers.
 * 3. The first picture of page size under the click point, skipping our own UI.
 * 4. Otherwise the first smaller picture under the click point (at least 100 px each way).
 * 5. Otherwise an element at the click point that paints a CSS background: the <img> of the page that shows the
 *    same address, when there is one. (A background with no <img> to go with it cannot be translated here.)
 */
export function resolveContextTarget(target: Element | null, point: { x: number; y: number }, env: TargetEnv): Element | null {
  if (target && isPictureElement(target) && env.qualifies(target)) return target;
  if (target && env.isOwnUi(target)) {
    const original = env.originalOfOverlay(target);
    if (original && isPictureElement(original)) return original;
  }
  for (const hit of env.elementsAt(point.x, point.y)) {
    if (env.isOwnUi(hit)) {
      const original = env.originalOfOverlay(hit);
      if (original && isPictureElement(original)) return original;
      continue;
    }
    if (isPictureElement(hit) && env.qualifiesBeneath(hit)) return hit;
  }
  const stack = env.elementsAt(point.x, point.y).filter((hit) => !env.isOwnUi(hit));
  for (const hit of stack) if (isPictureElement(hit) && env.qualifiesLoosely?.(hit)) return hit;
  for (const hit of stack) {
    const url = env.backgroundUrlOf?.(hit);
    const picture = url ? env.pictureByUrl?.(url) : null;
    if (picture && isPictureElement(picture)) return picture;
  }
  return null;
}

/** The first `url(...)` layer of a CSS `background-image` value as an absolute address (no fragment), or null. */
export function cssBackgroundUrl(cssValue: string | null | undefined, baseUrl: string): string | null {
  const value = cssValue?.trim();
  if (!value || value === "none") return null;
  const match = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|\x27((?:[^\x27\\]|\\.)*)\x27|([^)\s]*))\s*\)/i.exec(value);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/\\(.)/g, "$1").trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw;
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** The lenient size test: shown at least 100 px each way (a big file drawn as a small icon does not count). */
export function meetsLooseSize(el: Element): boolean {
  const html = el as HTMLElement;
  return (html.offsetWidth || html.clientWidth) >= 100 && (html.offsetHeight || html.clientHeight) >= 100;
}

/** What the page remembers about the last right-click. */
export interface ContextRecord {
  /** `performance.now()` of the click. */
  at: number;
  x: number;
  y: number;
  pageUrl: string;
  target: Element | null;
  resolved: Element | null;
}

/** The size test used for a picture that was clicked itself: shown or natural size of at least 260 px each way. */
export function meetsPageSize(el: Element): boolean {
  const html = el as HTMLElement;
  const renderedW = html.offsetWidth || html.clientWidth;
  const renderedH = html.offsetHeight || html.clientHeight;
  const naturalW = "naturalWidth" in el ? (el as HTMLImageElement).naturalWidth : (el as HTMLCanvasElement).width;
  const naturalH = "naturalHeight" in el ? (el as HTMLImageElement).naturalHeight : (el as HTMLCanvasElement).height;
  return (renderedW >= 260 && renderedH >= 260) || (naturalW >= 260 && naturalH >= 260);
}

/** The stricter test for a picture under another element: it also has to be shown at least 350 x 280 px. */
export function meetsBeneathSize(el: Element): boolean {
  const html = el as HTMLElement;
  const w = html.offsetWidth || html.clientWidth;
  const h = html.offsetHeight || html.clientHeight;
  if (w === 0 && h === 0) return false;
  return meetsPageSize(el) && w >= 350 && h >= 280;
}

export type CommandCheck =
  | { ok: true; element: Element }
  | { ok: false; reason: "no-record" | "other-page" | "no-element" };

/**
 * Picks the picture for a menu command. The record is only used when it was made on the same page address and its
 * element is still in the document. The address the menu reported (`srcUrl`) only confirms or breaks a tie.
 * `matchesSrc(el)` tells whether an element shows that address.
 */
export function pickForCommand(
  record: ContextRecord | null,
  pageUrl: string,
  isConnected: (el: Element) => boolean,
  srcUrl: string | undefined,
  matchesSrc: (el: Element) => boolean,
  findBySrc: (preferred: Element | null) => Element | null,
): CommandCheck {
  if (!record) return srcUrl ? fallback(findBySrc(null)) : { ok: false, reason: "no-record" };
  if (record.pageUrl !== pageUrl) return { ok: false, reason: "other-page" };
  const resolved = record.resolved && isConnected(record.resolved) ? record.resolved : null;
  if (resolved && (!srcUrl || matchesSrc(resolved))) return { ok: true, element: resolved };
  if (srcUrl) {
    const found = findBySrc(record.target && isConnected(record.target) ? record.target : null);
    if (found) return { ok: true, element: found };
  }
  if (resolved) return { ok: true, element: resolved };
  return { ok: false, reason: "no-element" };
}

function fallback(found: Element | null): CommandCheck {
  return found ? { ok: true, element: found } : { ok: false, reason: "no-element" };
}
