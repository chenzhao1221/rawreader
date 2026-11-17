import { describe, expect, it } from 'vitest'
import { AUTH_FAILURE_LIMIT, AuthRateLimiter, checkRequest } from './guards'
import type { GuardRequest, GuardState } from './guards'

const ID = 'a'.repeat(32)
const OTHER_ID = 'b'.repeat(32)
const CODE = 'ABCDEFGHJKMNPQRS'

function state(overrides: Partial<GuardState> = {}, clock = { t: 0 }): GuardState {
  return { port: 18793, code: CODE, recordedExtensionId: null, limiter: new AuthRateLimiter(() => clock.t), ...overrides }
}

const good: GuardRequest = {
  method: 'POST',
  path: '/translate',
  host: '127.0.0.1:18793',
  origin: `chrome-extension://${ID}`,
  authorization: `Bearer ${CODE}`,
}

describe('checkRequest', () => {
  it('accepts a valid request and reports first use until an extension ID is recorded', () => {
    expect(checkRequest(good, state())).toMatchObject({ ok: true, route: 'translate', preflight: false, extensionId: ID, firstUse: true })
    expect(checkRequest(good, state({ recordedExtensionId: ID }))).toMatchObject({ ok: true, firstUse: false })
  })

  it('accepts the grouped, lower-case form of the code', () => {
    const grouped = { ...good, authorization: 'Bearer abcd-efgh-jkmn-pqrs' }
    expect(checkRequest(grouped, state()).ok).toBe(true)
  })

  it.each<[string, Partial<GuardRequest>, number, string]>([
    ['localhost name as Host', { host: 'localhost:18793' }, 403, 'forbidden-host'],
    ['wrong port in Host', { host: '127.0.0.1:18794' }, 403, 'forbidden-host'],
    ['IPv6 loopback Host', { host: '[::1]:18793' }, 403, 'forbidden-host'],
    ['no Host', { host: undefined }, 403, 'forbidden-host'],
    ['no Origin', { origin: undefined }, 403, 'forbidden-origin'],
    ['web page Origin', { origin: 'https://site.example' }, 403, 'forbidden-origin'],
    ['null Origin', { origin: 'null' }, 403, 'forbidden-origin'],
    ['moz-extension Origin', { origin: `moz-extension://${ID}` }, 403, 'forbidden-origin'],
    ['short extension ID', { origin: 'chrome-extension://abc' }, 403, 'forbidden-origin'],
    ['extension ID with letters beyond p', { origin: `chrome-extension://${'z'.repeat(32)}` }, 403, 'forbidden-origin'],
    ['Origin with a path', { origin: `chrome-extension://${ID}/page` }, 403, 'forbidden-origin'],
    ['unknown path', { path: '/admin' }, 404, 'not-found'],
    ['wrong method on /translate', { method: 'GET' }, 404, 'not-found'],
    ['wrong method on /ping', { method: 'POST', path: '/ping' }, 404, 'not-found'],
    ['no Authorization', { authorization: undefined }, 401, 'unauthorized'],
    ['Basic scheme', { authorization: `Basic ${CODE}` }, 401, 'unauthorized'],
    ['wrong code', { authorization: 'Bearer AAAAAAAAAAAAAAAA' }, 401, 'unauthorized'],
    ['malformed code', { authorization: 'Bearer short' }, 401, 'unauthorized'],
  ])('rejects %s', (_name, patch, status, code) => {
    expect(checkRequest({ ...good, ...patch }, state())).toMatchObject({ ok: false, status, code })
  })

  it('rejects a request before looking at credentials when Host or Origin is wrong', () => {
    const s = state()
    const bad = { ...good, host: 'evil.example', authorization: undefined }
    expect(checkRequest(bad, s)).toMatchObject({ status: 403 })
    // A Host or Origin failure is not an auth failure: it never feeds the rate limiter.
    for (let i = 0; i < 20; i++) checkRequest(bad, s)
    expect(s.limiter.isBlocked()).toBe(false)
  })

  it('rejects another extension once an ID is recorded, with its origin echoed only when well formed', () => {
    const result = checkRequest({ ...good, origin: `chrome-extension://${OTHER_ID}` }, state({ recordedExtensionId: ID }))
    expect(result).toMatchObject({ ok: false, status: 403, code: 'unknown-extension', origin: `chrome-extension://${OTHER_ID}` })
    expect(checkRequest({ ...good, origin: 'https://site.example' }, state())).not.toHaveProperty('origin')
  })

  it('lets a preflight through without credentials, but not from a wrong origin or host', () => {
    const preflight = { ...good, method: 'OPTIONS', authorization: undefined }
    expect(checkRequest(preflight, state())).toMatchObject({ ok: true, preflight: true, route: 'translate' })
    expect(checkRequest({ ...preflight, origin: 'https://site.example' }, state())).toMatchObject({ ok: false, status: 403 })
    expect(checkRequest({ ...preflight, path: '/other' }, state())).toMatchObject({ ok: false, status: 404 })
  })
})

describe('auth rate limit', () => {
  const wrong = { ...good, authorization: 'Bearer AAAAAAAAAAAAAAAA' }

  it('answers 429 after more than 5 failures in 60 s, even for the right code, then recovers', () => {
    const clock = { t: 1000 }
    const s = state({}, clock)
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) expect(checkRequest(wrong, s)).toMatchObject({ status: 401 })
    expect(checkRequest(wrong, s)).toMatchObject({ status: 401 }) // the 6th failure starts the block
    expect(checkRequest(good, s)).toMatchObject({ ok: false, status: 429, code: 'rate-limited' })
    clock.t += 59_000
    expect(checkRequest(good, s)).toMatchObject({ status: 429 })
    clock.t += 2_000
    expect(checkRequest(good, s)).toMatchObject({ ok: true })
  })

  it('forgets failures older than the window', () => {
    const clock = { t: 0 }
    const s = state({}, clock)
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) checkRequest(wrong, s)
    clock.t += 61_000
    expect(checkRequest(wrong, s)).toMatchObject({ status: 401 })
    expect(checkRequest(good, s)).toMatchObject({ ok: true })
  })
})
