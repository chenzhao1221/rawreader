// Portions ported from libre-manga-translator src/lib/security.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: renamed `isAllowedImageUrl` options, added `isFetchableImageUrl`
// (which also accepts `data:` URLs for the fetch fallback) and a URL key helper.

/**
 * Validates whether an image URL is safe for the main-process fetch fallback.
 * Strictly enforces HTTPS/HTTP and rejects loopback, RFC1918 private IPs,
 * link-local/cloud metadata, internal schemes and embedded credentials.
 * Page-supplied URLs are untrusted: without this check a page could make the
 * app fetch addresses on the user's own machine or network.
 */
export function isAllowedImageUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  // 1. Strict protocol allowlist: HTTPS or HTTP only.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  // 2. Reject credentials embedded in the URL (user:pass@host).
  if (parsed.username || parsed.password) return false

  // Normalise host (lower case, remove brackets for IPv6).
  let host = parsed.hostname.toLowerCase().trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) return false

  // 3. Reject localhost, local domain suffixes and mDNS.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return false
  }

  // 4. Reject integer or hex representations of IP addresses (common SSRF bypasses).
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false

  // 5. IPv4 numeric validation.
  const ipv4Parts = host.split('.')
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d+$/.test(p))) {
    const octets = ipv4Parts.map((p) => parseInt(p, 10))
    if (octets.some((o) => o < 0 || o > 255)) return false

    const b0 = octets[0] ?? 0
    const b1 = octets[1] ?? 0

    if (b0 === 0) return false // 0.0.0.0/8 current network
    if (b0 === 127) return false // loopback
    if (b0 === 10) return false // RFC1918
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return false // RFC1918
    if (b0 === 192 && b1 === 168) return false // RFC1918
    if (b0 === 169 && b1 === 254) return false // link-local and cloud metadata
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return false // CGNAT
    if (b0 === 192 && b1 === 0) return false // IETF protocol assignments
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return false // benchmark tests
    if (b0 >= 224) return false // multicast and reserved
  }

  // 6. IPv6 validation.
  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.includes('::ffff:127.') ||
    host.includes('::ffff:10.') ||
    host.includes('::ffff:192.168.') ||
    host.includes('::ffff:172.') ||
    host.includes('::ffff:169.254.')
  ) {
    return false
  }

  return true
}

/** RawReader addition: the fetch fallback accepts allowed http(s) URLs and `data:` URLs (R4.5). */
export function isFetchableImageUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string') return false
  if (rawUrl.startsWith('data:')) return true
  return isAllowedImageUrl(rawUrl)
}

/** Key used to match a page image URL with a CDP request: the URL without its fragment. */
export function urlKey(rawUrl: string): string {
  const hash = rawUrl.indexOf('#')
  return hash === -1 ? rawUrl : rawUrl.slice(0, hash)
}
