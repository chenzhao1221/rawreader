/**
 * Pure helpers for choosing and filtering page images. No DOM access, so
 * Vitest can test them in a plain Node environment.
 */

export interface SrcsetCandidate {
  url: string
  /** Width descriptor (`800w`) in pixels, or null. */
  width: number | null
  /** Pixel density descriptor (`2x`), or null. */
  density: number | null
}

/** Parses a `srcset` attribute. Malformed entries are skipped. */
export function parseSrcset(srcset: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = []
  // URLs may contain commas (data URLs), so split on a comma followed by whitespace or the end.
  for (const part of srcset.split(/,\s+|,$/)) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const pieces = trimmed.split(/\s+/)
    const url = pieces[0]
    if (!url) continue
    let width: number | null = null
    let density: number | null = null
    const descriptor = pieces[1]
    if (descriptor) {
      const value = Number.parseFloat(descriptor)
      if (/w$/i.test(descriptor) && Number.isFinite(value)) width = value
      else if (/x$/i.test(descriptor) && Number.isFinite(value)) density = value
    }
    out.push({ url, width, density })
  }
  return out
}

/** The largest candidate by width, then density. Without descriptors the last entry wins. */
export function pickLargestCandidate(candidates: SrcsetCandidate[]): SrcsetCandidate | null {
  let best: SrcsetCandidate | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    const score = candidate.width ?? (candidate.density !== null ? candidate.density * 1000 : 1)
    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

export interface ImageSourceInfo {
  /** `img.currentSrc`: what the browser actually loaded (empty before the first load). */
  currentSrc: string
  src: string
  srcset: string
  complete: boolean
}

/**
 * Picks the URL to capture. The URL the browser already loaded wins, so the
 * CDP path finds its bytes; before the first load the largest srcset
 * candidate, then `src`.
 */
export function chooseImageUrl(info: ImageSourceInfo, resolve: (url: string) => string): string {
  if (info.complete && info.currentSrc) return info.currentSrc
  if (info.srcset) {
    const largest = pickLargestCandidate(parseSrcset(info.srcset))
    if (largest) return resolve(largest.url)
  }
  return info.currentSrc || info.src
}

/** R5.2: both natural dimensions must reach the configured minimum. */
export function qualifiesBySize(naturalW: number, naturalH: number, minImageSize: number): boolean {
  return naturalW >= minImageSize && naturalH >= minImageSize
}

/** Distance in CSS pixels between a rect and the viewport; 0 when they overlap vertically. */
export function distanceToViewport(rectTop: number, rectBottom: number, viewportHeight: number): number {
  if (rectBottom < 0) return -rectBottom
  if (rectTop > viewportHeight) return rectTop - viewportHeight
  return 0
}

/** URLs the page scanner reports: http(s), data and blob. Everything else is dropped in the page. */
export function isReportableUrl(url: string): boolean {
  return /^(https?:|data:image\/|blob:)/i.test(url)
}
