import type { NavRejectReason } from '../../shared/ipc/contract'

export type AddressResult = { ok: true; url: string } | { ok: false; reason: NavRejectReason }

/** `scheme:` at the start, except `host:port` forms such as `localhost:3000`. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i

/** True when `url` parses and uses the `http:` or `https:` scheme. */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Turns address-bar text into a loadable URL. Only `http:` and `https:` are
 * accepted. Text without a scheme must look like a host (contains a dot, is
 * `localhost`, or is a bracketed IPv6 literal) and gets `https://` in front.
 * Anything else is rejected: phase 1 has no search engine.
 */
export function normalizeAddress(input: string): AddressResult {
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'empty' }

  if (SCHEME_PREFIX.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'unsupported-scheme' }
    }
    return { ok: true, url: url.href }
  }

  if (/\s/.test(text)) return { ok: false, reason: 'invalid' }

  let url: URL
  try {
    url = new URL(`https://${text}`)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const host = url.hostname
  const looksLikeHost = host === 'localhost' || host.includes('.') || host.startsWith('[')
  if (!looksLikeHost) return { ok: false, reason: 'invalid' }
  return { ok: true, url: url.href }
}
