// Picks the <img> the user right-clicked. Pure logic (no DOM types beyond a small structural interface) so it is
// unit-tested in plain Node. The caller supplies the images stacked at the click point and all images of the page.

export interface ImageLike {
  currentSrc?: string
  src?: string
  getAttribute(name: string): string | null
}

/** Attributes lazy-loading pages use for the real image URL, before a script copies it into `src`. */
const LAZY_ATTRIBUTES = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-original-src', 'data-echo']
const SRCSET_ATTRIBUTES = ['srcset', 'data-srcset', 'data-lazy-srcset']

/** Resolves against the page URL and drops the fragment. data: and blob: URLs are kept as they are. Null when unusable. */
export function normalizeUrl(raw: string | null | undefined, baseUrl: string): string | null {
  const value = raw?.trim()
  if (!value) return null
  if (/^(data|blob):/i.test(value)) return value
  try {
    const url = new URL(value, baseUrl)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** URLs in a srcset value, descriptors removed. A data: URL stays whole (it contains commas). */
function srcsetUrls(value: string | null): string[] {
  const text = value?.trim()
  if (!text) return []
  if (/^data:/i.test(text)) return [text.split(/\s+/)[0]!]
  return text
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((url): url is string => !!url)
}

/** Every URL the image is known by (shown, lazy attributes, srcset), normalised. */
export function imageUrls(img: ImageLike, baseUrl: string): string[] {
  const raw: (string | null | undefined)[] = [img.currentSrc, img.src, img.getAttribute('src')]
  for (const name of LAZY_ATTRIBUTES) raw.push(img.getAttribute(name))
  for (const name of SRCSET_ATTRIBUTES) raw.push(...srcsetUrls(img.getAttribute(name)))
  const urls: string[] = []
  for (const value of raw) {
    const url = normalizeUrl(value, baseUrl)
    if (url) urls.push(url)
  }
  return urls
}

export function imageMatchesUrl(img: ImageLike, srcUrl: string, baseUrl: string): boolean {
  const wanted = normalizeUrl(srcUrl, baseUrl)
  return wanted !== null && imageUrls(img, baseUrl).includes(wanted)
}

/**
 * 1. An image stacked at the click point that shows `srcUrl` (the browser hit-tested exactly that one).
 * 2. Any image of the page that carries `srcUrl` (an overlay or script hid the element at the click point).
 * 3. The topmost image at the click point (the page rewrote the URL since).
 */
export function pickContextImage<T extends ImageLike>(atPoint: readonly T[], all: Iterable<T>, srcUrl: string, baseUrl: string): T | null {
  const exact = atPoint.find((img) => imageMatchesUrl(img, srcUrl, baseUrl))
  if (exact) return exact
  for (const img of all) if (imageMatchesUrl(img, srcUrl, baseUrl)) return img
  return atPoint[0] ?? null
}

/**
 * The picture a CSS `background-image` value shows: the first `url(...)` layer (gradients are skipped), normalised.
 * Null for `none`, gradients only, or an unusable value. Computed styles quote the URL; unquoted ones are accepted too.
 */
export function backgroundImageUrl(cssValue: string | null | undefined, baseUrl: string): string | null {
  const value = cssValue?.trim()
  if (!value || value === 'none') return null
  const match = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/i.exec(value)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3]
  return normalizeUrl(raw?.replace(/\\(.)/g, '$1'), baseUrl)
}

/**
 * The first element at the click point (topmost first) that paints a picture as its CSS background, with that
 * picture's URL. `backgroundOf(el)` returns the computed `background-image` of an element.
 */
export function pickBackgroundTarget<T>(atPoint: readonly T[], backgroundOf: (el: T) => string | null, baseUrl: string): { el: T; url: string } | null {
  for (const el of atPoint) {
    const url = backgroundImageUrl(backgroundOf(el), baseUrl)
    if (url) return { el, url }
  }
  return null
}