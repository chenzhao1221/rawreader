import { BRIDGE_ALLOWED_ORIGIN } from '../../shared/bridge'

export interface GuardRequest {
  method: string
  path: string
  host: string | undefined
  origin: string | undefined
}

export interface GuardState {
  /** Port the server is bound to; the Host header must name it. */
  port: number
}

export type GuardRoute = 'ping' | 'translate' | 'history' | 'history-open'

export type GuardResult =
  | { ok: true; route: GuardRoute; preflight: boolean; origin: string }
  | { ok: false; status: 403 | 404; code: string; message: string; origin?: string }

const ROUTES: Record<string, { method: string; route: GuardRoute }> = {
  '/ping': { method: 'GET', route: 'ping' },
  '/translate': { method: 'POST', route: 'translate' },
  '/history': { method: 'POST', route: 'history' },
  '/history/open': { method: 'POST', route: 'history-open' },
}

const fail = (status: 403 | 404, code: string, message: string, origin?: string): GuardResult => ({
  ok: false,
  status,
  code,
  message,
  ...(origin ? { origin } : {}),
})

/**
 * Decides whether a request may proceed, from headers alone (the body is not read yet). Order: Host, Origin,
 * route. The only accepted Origin is the pinned extension's (`BRIDGE_ALLOWED_ORIGIN`). Web pages, other
 * extensions and requests without an Origin get 403. The error `origin` is set only for the allowed Origin, so
 * CORS headers are never sent to anyone else.
 */
export function checkRequest(request: GuardRequest, state: GuardState): GuardResult {
  if (request.host !== `127.0.0.1:${state.port}`) return fail(403, 'forbidden-host', 'Host must be 127.0.0.1')

  if (request.origin !== BRIDGE_ALLOWED_ORIGIN) return fail(403, 'forbidden-origin', 'Only the RawReader extension may call the bridge')
  const origin = request.origin

  const entry = ROUTES[request.path]
  const preflight = request.method === 'OPTIONS' && entry !== undefined
  if (!entry || (!preflight && request.method !== entry.method)) return fail(404, 'not-found', 'Not found', origin)

  return { ok: true, route: entry.route, preflight, origin }
}