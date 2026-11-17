import { normalizePairingCode, pairingCodesMatch } from './pairing'

/** Extension origins are `chrome-extension://<32 characters a-p>`, nothing else. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/

/** Auth failures allowed per window before the bridge answers 429. */
export const AUTH_FAILURE_LIMIT = 5
export const AUTH_WINDOW_MS = 60_000
export const AUTH_BLOCK_MS = 60_000

/** Counts failed authentications and blocks for a while after too many. The clock is injected. */
export class AuthRateLimiter {
  private failures: number[] = []
  private blockedUntil = 0

  constructor(
    private readonly now: () => number,
    private readonly limit = AUTH_FAILURE_LIMIT,
    private readonly windowMs = AUTH_WINDOW_MS,
    private readonly blockMs = AUTH_BLOCK_MS,
  ) {}

  isBlocked(): boolean {
    return this.now() < this.blockedUntil
  }

  /** Records one failed authentication. More than `limit` inside the window starts the block. */
  recordFailure(): void {
    const now = this.now()
    this.failures = this.failures.filter((at) => now - at < this.windowMs)
    this.failures.push(now)
    if (this.failures.length > this.limit) {
      this.blockedUntil = now + this.blockMs
      this.failures = []
    }
  }

  reset(): void {
    this.failures = []
    this.blockedUntil = 0
  }
}

export interface GuardRequest {
  method: string
  path: string
  host: string | undefined
  origin: string | undefined
  authorization: string | undefined
}

export interface GuardState {
  port: number
  /** The current pairing code (canonical form, no separators). */
  code: string
  /** Extension ID recorded at the first authenticated request, or null before that. */
  recordedExtensionId: string | null
  limiter: AuthRateLimiter
}

export type GuardRoute = 'ping' | 'translate'

export type GuardResult =
  | { ok: true; route: GuardRoute; preflight: boolean; origin: string; extensionId: string; firstUse: boolean }
  | { ok: false; status: 401 | 403 | 404 | 429; code: string; message: string; origin?: string }

const ROUTES: Record<string, { method: string; route: GuardRoute }> = {
  '/ping': { method: 'GET', route: 'ping' },
  '/translate': { method: 'POST', route: 'translate' },
}

const fail = (status: 401 | 403 | 404 | 429, code: string, message: string, origin?: string): GuardResult => ({
  ok: false,
  status,
  code,
  message,
  ...(origin ? { origin } : {}),
})

/** Reads `Bearer <code>`; anything else gives null. */
function bearerOf(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '')
  return match ? (match[1] as string) : null
}

/**
 * Decides whether a request may proceed, from headers alone (the body is not read yet). Order: Host, Origin,
 * route, recorded extension, rate limit, bearer code. The error `origin` is echoed only when the Origin is a
 * well-formed extension origin, so CORS headers on error responses never reflect a page origin.
 */
export function checkRequest(request: GuardRequest, state: GuardState): GuardResult {
  if (request.host !== `127.0.0.1:${state.port}`) return fail(403, 'forbidden-host', 'Host must be 127.0.0.1')

  const origin = request.origin ?? ''
  const originMatch = EXTENSION_ORIGIN.exec(origin)
  if (!originMatch) return fail(403, 'forbidden-origin', 'Only the browser extension may call the bridge')
  const extensionId = originMatch[1] as string

  const entry = ROUTES[request.path]
  const preflight = request.method === 'OPTIONS' && entry !== undefined
  if (!entry || (!preflight && request.method !== entry.method)) return fail(404, 'not-found', 'Not found', origin)

  if (state.recordedExtensionId !== null && state.recordedExtensionId !== extensionId) {
    return fail(403, 'unknown-extension', 'This extension is not paired', origin)
  }

  // A preflight carries no credentials by design; it only learns which headers are allowed.
  if (preflight) return { ok: true, route: entry.route, preflight: true, origin, extensionId, firstUse: false }

  if (state.limiter.isBlocked()) return fail(429, 'rate-limited', 'Too many failed attempts, try again later', origin)

  const provided = bearerOf(request.authorization)
  // The grouped form (ABCD-EFGH-...) and look-alike letters are accepted, so a code pasted as shown still works.
  const normalized = provided === null ? null : normalizePairingCode(provided)
  if (normalized === null || !pairingCodesMatch(state.code, normalized)) {
    state.limiter.recordFailure()
    return fail(401, 'unauthorized', 'Missing or wrong pairing code', origin)
  }
  return {
    ok: true,
    route: entry.route,
    preflight: false,
    origin,
    extensionId,
    firstUse: state.recordedExtensionId === null,
  }
}
