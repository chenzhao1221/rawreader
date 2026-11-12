import { decodeDataUrl } from './body'
import { sha256Hex } from './hash'
import { sniffMime } from './sniff'
import type { ImageMime } from './sniff'
import { isFetchableImageUrl } from './url-check'

export type CaptureErrorCode =
  | 'CAPTURE_UNAVAILABLE'
  | 'URL_NOT_ALLOWED'
  | 'FETCH_FAILED'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'

export interface CapturedImage {
  bytes: Uint8Array
  mime: ImageMime
  /** Lower-case hex sha256 of `bytes`. */
  hash: string
  /** Which path produced the bytes. */
  source: 'cdp' | 'fetch' | 'data-url'
}

export type CaptureResult = { ok: true; image: CapturedImage } | { ok: false; code: CaptureErrorCode; detail?: string }

/** Side effects of capture, injected so the order of attempts is unit-tested. */
export interface CaptureDeps {
  /** Bytes the browser already loaded (CDP `Network.getResponseBody`), or null when unavailable. */
  getLoadedBytes(url: string): Promise<Uint8Array | null>
  /** `session.fetch` on the browse partition with a Referer. Rejects on network errors. */
  fetchBytes(url: string, referer: string, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'too-large' | 'http-error' }>
}

export interface CaptureRequest {
  url: string
  /** URL of the page that shows the image. */
  pageUrl: string
  maxBytes: number
}

/**
 * Capture order (R4): bytes the browser already loaded, then a fetch on the
 * same session. Never a screenshot. `blob:` URLs only work through the first
 * path; if it fails they report CAPTURE_UNAVAILABLE.
 */
export async function captureImage(deps: CaptureDeps, request: CaptureRequest): Promise<CaptureResult> {
  const { url, pageUrl, maxBytes } = request

  if (url.startsWith('data:')) {
    const bytes = decodeDataUrl(url)
    if (bytes === null) return { ok: false, code: 'FETCH_FAILED', detail: 'malformed data URL' }
    return finish(bytes, 'data-url', maxBytes)
  }

  let loaded: Uint8Array | null = null
  try {
    loaded = await deps.getLoadedBytes(url)
  } catch {
    loaded = null
  }
  if (loaded !== null && loaded.byteLength > 0) {
    const result = finish(loaded, 'cdp', maxBytes)
    // A body that is present but not an image (for example an HTML error page) falls through to the fetch.
    if (result.ok || result.code === 'TOO_LARGE') return result
  }

  if (url.startsWith('blob:')) return { ok: false, code: 'CAPTURE_UNAVAILABLE', detail: 'blob URL without a CDP body' }
  if (!isFetchableImageUrl(url)) return { ok: false, code: 'URL_NOT_ALLOWED' }

  let fetched: Awaited<ReturnType<CaptureDeps['fetchBytes']>>
  try {
    fetched = await deps.fetchBytes(url, pageUrl, maxBytes)
  } catch (error) {
    return { ok: false, code: 'FETCH_FAILED', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!fetched.ok) {
    return fetched.reason === 'too-large'
      ? { ok: false, code: 'TOO_LARGE' }
      : { ok: false, code: 'FETCH_FAILED', detail: 'HTTP error status' }
  }
  return finish(fetched.bytes, 'fetch', maxBytes)
}

function finish(bytes: Uint8Array, source: CapturedImage['source'], maxBytes: number): CaptureResult {
  if (bytes.byteLength > maxBytes) return { ok: false, code: 'TOO_LARGE' }
  const mime = sniffMime(bytes)
  if (mime === null) return { ok: false, code: 'UNSUPPORTED_TYPE' }
  return { ok: true, image: { bytes, mime, hash: sha256Hex(bytes), source } }
}
