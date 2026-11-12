import { describe, expect, it } from 'vitest'
import { isHttpUrl, normalizeAddress } from './address'

describe('normalizeAddress', () => {
  it('adds https:// to a scheme-less host', () => {
    expect(normalizeAddress('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(normalizeAddress('  www.example.com/path?q=1 ')).toEqual({ ok: true, url: 'https://www.example.com/path?q=1' })
  })

  it('accepts localhost with and without a port', () => {
    expect(normalizeAddress('localhost')).toEqual({ ok: true, url: 'https://localhost/' })
    expect(normalizeAddress('localhost:3000')).toEqual({ ok: true, url: 'https://localhost:3000/' })
    expect(normalizeAddress('localhost:3000/a')).toEqual({ ok: true, url: 'https://localhost:3000/a' })
    expect(normalizeAddress('example.com:8080')).toEqual({ ok: true, url: 'https://example.com:8080/' })
  })

  it('keeps explicit http and https URLs', () => {
    expect(normalizeAddress('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' })
    expect(normalizeAddress('HTTPS://Example.com/A')).toEqual({ ok: true, url: 'https://example.com/A' })
  })

  it('rejects empty input', () => {
    expect(normalizeAddress('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeAddress('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it.each(['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'about:blank', 'data:text/html,<b>x</b>', 'ftp://example.com', 'chrome://settings', 'blob:https://example.com/abc'])(
    'rejects the %s scheme',
    (input) => {
      expect(normalizeAddress(input)).toEqual({ ok: false, reason: 'unsupported-scheme' })
    },
  )

  it('rejects text with spaces and bare words (no search engine in phase 1)', () => {
    expect(normalizeAddress('one piece raw')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeAddress('example .com')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeAddress('manga')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a malformed URL that has a scheme', () => {
    expect(normalizeAddress('http://')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('isHttpUrl', () => {
  it('accepts only http and https', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('file:///C:/x')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})
