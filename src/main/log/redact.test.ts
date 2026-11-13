import { describe, expect, it } from 'vitest'
import { hashPrefix, redactText, redactUrl, redactValue } from './redact'

describe('redactUrl', () => {
  it('keeps the origin only: no path, query string or fragment', () => {
    expect(redactUrl('https://cdn.example.com/a/b.jpg?token=abc&x=1#frag')).toBe('https://cdn.example.com/[redacted]')
    expect(redactUrl('https://example.com/img/1.png')).toBe('https://example.com/[redacted]')
  })

  it('leaves a bare origin unchanged', () => {
    expect(redactUrl('https://example.com/')).toBe('https://example.com/')
    expect(redactUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  })

  it('drops userinfo', () => {
    const out = redactUrl('https://user:hunter2@example.com/p')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('user')
  })

  it('handles text that is not a URL', () => {
    expect(redactUrl('not a url, cookie: abc')).toContain('[redacted]')
  })
})

describe('redactText', () => {
  it('redacts URLs embedded in a sentence', () => {
    const out = redactText('Fetching https://img.example.com/p/1.webp?sig=SECRET123&e=9 now')
    expect(out).toBe('Fetching https://img.example.com/[redacted] now')
    expect(out).not.toContain('SECRET123')
  })

  it('redacts cookie and authorization headers', () => {
    const out = redactText('Cookie: session=abc123; theme=dark\nAuthorization: Bearer abcdefghijkl\nok')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('abcdefghijkl')
    expect(out).toContain('Cookie: [redacted]')
    expect(out).toContain('Authorization: [redacted]')
    expect(out).toContain('ok')
  })

  it('redacts set-cookie and JSON-style headers', () => {
    expect(redactText('set-cookie=sid=xyz; Path=/')).not.toContain('xyz')
    expect(redactText('{"cookie":"sid=xyz789"}')).not.toContain('xyz789')
  })

  it('redacts bare bearer tokens', () => {
    expect(redactText('sent Bearer eyJhbGciOi.payload.sig here')).toBe('sent Bearer [redacted] here')
  })

  it('summarises data URLs instead of logging their payload', () => {
    const payload = 'A'.repeat(500)
    const out = redactText(`img data:image/png;base64,${payload} end`)
    expect(out).not.toContain(payload)
    expect(out).toContain('data:image/png;')
    expect(out).toContain('chars omitted')
  })

  it('redacts blob URLs', () => {
    const out = redactText('blob:https://site.example/3f2a-1111?x=1')
    expect(out).not.toContain('x=1')
  })

  it('redacts secret query parameters of relative URLs', () => {
    expect(redactText('GET /api/img?token=abc123&page=2')).not.toContain('abc123')
  })

  it('leaves ordinary text alone', () => {
    expect(redactText('detect: 12 boxes in 340 ms')).toBe('detect: 12 boxes in 340 ms')
  })
})

describe('redactValue', () => {
  it('redacts sensitive keys and nested URLs', () => {
    const out = redactValue({
      headers: { Cookie: 'a=b', Authorization: 'Bearer zzzzzzzz', Accept: 'image/*' },
      url: 'https://x.example/a.jpg?k=1',
      list: ['https://y.example/b.png?z=2'],
    }) as Record<string, any>
    expect(out.headers.Cookie).toBe('[redacted]')
    expect(out.headers.Authorization).toBe('[redacted]')
    expect(out.headers.Accept).toBe('image/*')
    expect(out.url).toBe('https://x.example/[redacted]')
    expect(out.list[0]).toBe('https://y.example/[redacted]')
  })

  it('serialises errors with redacted messages', () => {
    const out = redactValue(new Error('failed https://a.example/p?token=1')) as Record<string, string>
    expect(out['message']).toBe('failed https://a.example/[redacted]')
  })

  it('summarises binary buffers', () => {
    expect(redactValue(new Uint8Array(10))).toBe('[10 bytes]')
  })

  it('passes primitives through', () => {
    expect(redactValue(42)).toBe(42)
    expect(redactValue(null)).toBeNull()
  })
})

describe('hashPrefix', () => {
  it('keeps ten characters', () => {
    expect(hashPrefix('0123456789abcdef')).toBe('0123456789')
  })
})
