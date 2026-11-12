import { readLimited } from './body'
import type { CaptureDeps } from './capture'

/** The slice of `session` this module uses. */
export interface SessionLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

const FETCH_TIMEOUT_MS = 30_000

/**
 * Fallback path: refetch the image through the browse session so cookies are
 * attached automatically, with the page as Referer (R4.2).
 */
export function createSessionFetch(ses: SessionLike): CaptureDeps['fetchBytes'] {
  return async (url, referer, maxBytes) => {
    const response = await ses.fetch(url, {
      headers: { Referer: referer, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, reason: 'http-error' }
    }
    const declared = Number(response.headers.get('content-length'))
    const body = await readLimited(response.body, maxBytes, Number.isFinite(declared) && declared > 0 ? declared : null)
    return body.ok ? { ok: true, bytes: body.bytes } : { ok: false, reason: 'too-large' }
  }
}
