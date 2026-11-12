import { describe, expect, it } from 'vitest'
import { sanitizeUserAgent } from './user-agent'

describe('sanitizeUserAgent', () => {
  it('removes the Electron and app tokens and keeps the Chrome ones', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) manga-lab-app/0.1.0 Chrome/146.0.0.0 Electron/45.3.1 Safari/537.36'
    expect(sanitizeUserAgent(ua)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    )
  })

  it('leaves a clean user agent unchanged', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    expect(sanitizeUserAgent(ua)).toBe(ua)
  })

  it('never leaves Electron or an unknown product token behind', () => {
    const out = sanitizeUserAgent('Mozilla/5.0 (X11) Foo/1.2.3 Chrome/1.0 Electron/9.9.9 Safari/1')
    expect(out).not.toMatch(/Electron|Foo/)
  })
})
