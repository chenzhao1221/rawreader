/**
 * Pure redaction helpers for log output. Nothing here imports Electron or Node
 * APIs, so Vitest can test it directly.
 *
 * Rules (product.md): never log cookies, auth headers, or full image URLs with
 * query strings. Query strings and fragments are always dropped from URLs.
 */

const REDACTED = '[redacted]'

/** Header or object keys whose value is always replaced. Compared in lower case. */
const SENSITIVE_KEYS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'secret',
])

const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>`\\)\]}]+/gi
const BLOB_PATTERN = /\bblob:https?:\/\/[^\s"'<>`\\)\]}]+/gi
const DATA_URL_PATTERN = /\bdata:([a-z0-9.+/-]*)(?:;[a-z0-9.+=_-]+)*,[^\s"'<>`\\)\]}]*/gi
const HEADER_PATTERN =
  /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)(\s*["']?\s*[:=]\s*["']?)[^\r\n"']*/gi
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g
const QUERY_PARAM_SECRET_PATTERN = /([?&;](?:token|access_token|key|api_key|apikey|sig|signature|auth|password)=)[^&\s"']*/gi

/**
 * Removes the query string and fragment from a URL. Userinfo (user:password@)
 * is dropped too. A marker shows that something was removed. Input that does
 * not parse as a URL is returned through `redactText`.
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return redactText(url)
  }
  const hadExtra = parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== ''
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  return hadExtra ? `${base}?${REDACTED}` : base
}

/** Redacts URLs, data URLs, cookie/authorization headers and bearer tokens inside free text. */
export function redactText(text: string): string {
  return text
    .replace(DATA_URL_PATTERN, (match, mime: string) => `data:${mime || 'unknown'};[${match.length} chars omitted]`)
    .replace(BLOB_PATTERN, (match) => `blob:${redactUrl(match.slice('blob:'.length))}`)
    .replace(URL_PATTERN, (match) => redactUrl(match))
    .replace(HEADER_PATTERN, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(QUERY_PARAM_SECRET_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
}

/** Redacts a logged value: strings through `redactText`, objects key by key, errors by message and stack. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 6) return '[max depth]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactText(value.message) }
    if (value.stack) out['stack'] = redactText(value.stack)
    return out
  }
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(item, depth + 1)
  }
  return out
}

/** Short, non-reversible label for a content hash in logs. */
export function hashPrefix(hash: string): string {
  return hash.slice(0, 10)
}
