import { describe, expect, it } from 'vitest'
import { BRIDGE_ALLOWED_ORIGIN, BRIDGE_EXTENSION_ID } from '../../shared/bridge'
import { checkRequest } from './guards'
import type { GuardRequest } from './guards'

const state = { port: 18793 }
const good: GuardRequest = {
  method: 'POST',
  path: '/translate',
  host: '127.0.0.1:18793',
  origin: BRIDGE_ALLOWED_ORIGIN,
}

describe('checkRequest', () => {
  it('accepts the pinned extension origin on both routes', () => {
    expect(checkRequest(good, state)).toEqual({ ok: true, route: 'translate', preflight: false, origin: BRIDGE_ALLOWED_ORIGIN })
    expect(checkRequest({ ...good, method: 'GET', path: '/ping' }, state)).toMatchObject({ ok: true, route: 'ping' })
  })

  it('accepts a preflight from the pinned origin', () => {
    expect(checkRequest({ ...good, method: 'OPTIONS' }, state)).toMatchObject({ ok: true, route: 'translate', preflight: true })
  })

  it.each<[string, Partial<GuardRequest>]>([
    ['no Origin', { origin: undefined }],
    ['empty Origin', { origin: '' }],
    ['web page Origin', { origin: 'https://site.example' }],
    ['null Origin', { origin: 'null' }],
    ['moz-extension Origin with the same ID', { origin: `moz-extension://${BRIDGE_EXTENSION_ID}` }],
    ['another extension ID', { origin: `chrome-extension://${'a'.repeat(32)}` }],
    ['the pinned origin with a trailing slash', { origin: `${BRIDGE_ALLOWED_ORIGIN}/` }],
    ['the pinned origin with a different case', { origin: BRIDGE_ALLOWED_ORIGIN.toUpperCase() }],
  ])('answers 403 for %s, without a CORS origin', (_name, patch) => {
    const result = checkRequest({ ...good, ...patch }, state)
    expect(result).toMatchObject({ ok: false, status: 403, code: 'forbidden-origin' })
    expect(result.ok === false && result.origin).toBeFalsy()
  })

  it('answers 403 for a foreign Origin on a preflight too', () => {
    expect(checkRequest({ ...good, method: 'OPTIONS', origin: 'https://site.example' }, state)).toMatchObject({ ok: false, status: 403 })
  })

  it.each<[string, Partial<GuardRequest>]>([
    ['localhost name as Host', { host: 'localhost:18793' }],
    ['wrong port in Host', { host: '127.0.0.1:18794' }],
    ['IPv6 loopback Host', { host: '[::1]:18793' }],
    ['no Host', { host: undefined }],
  ])('answers 403 for %s', (_name, patch) => {
    expect(checkRequest({ ...good, ...patch }, state)).toMatchObject({ ok: false, status: 403, code: 'forbidden-host' })
  })

  it('answers 404 for unknown paths and wrong methods from the pinned origin', () => {
    expect(checkRequest({ ...good, path: '/other' }, state)).toMatchObject({ ok: false, status: 404, origin: BRIDGE_ALLOWED_ORIGIN })
    expect(checkRequest({ ...good, method: 'GET' }, state)).toMatchObject({ ok: false, status: 404 })
    expect(checkRequest({ ...good, method: 'OPTIONS', path: '/other' }, state)).toMatchObject({ ok: false, status: 404 })
  })
})