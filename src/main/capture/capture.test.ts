import { describe, expect, it, vi } from 'vitest'
import { decodeDataUrl, readLimited } from './body'
import { captureImage } from './capture'
import type { CaptureDeps } from './capture'
import { sha256Hex } from './hash'
import { RequestMap } from './request-map'
import { sniffMime } from './sniff'
import { isAllowedImageUrl, isFetchableImageUrl, urlKey } from './url-check'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1])
const HTML = new TextEncoder().encode('<html><body>blocked</body></html>')

function webp(): Uint8Array {
  return new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
}

describe('sniffMime', () => {
  it('detects the supported formats', () => {
    expect(sniffMime(PNG)).toBe('image/png')
    expect(sniffMime(JPEG)).toBe('image/jpeg')
    expect(sniffMime(webp())).toBe('image/webp')
    expect(sniffMime(new TextEncoder().encode('GIF89a\0\0\0\0\0\0\0'))).toBe('image/gif')
    expect(sniffMime(Uint8Array.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0]))).toBe('image/avif')
  })

  it('rejects other content instead of defaulting to JPEG', () => {
    expect(sniffMime(HTML)).toBeNull()
    expect(sniffMime(new Uint8Array(4))).toBeNull()
    // HEIC has an ftyp box but not an avif brand.
    expect(sniffMime(Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0]))).toBeNull()
  })
})

describe('isAllowedImageUrl', () => {
  it.each([
    'https://cdn.example.com/a.jpg?x=1',
    'http://img.example.org/p/1.png',
  ])('allows %s', (url) => expect(isAllowedImageUrl(url)).toBe(true))

  it.each([
    'file:///C:/secret.png',
    'javascript:alert(1)',
    'ftp://example.com/a.png',
    'http://localhost/a.png',
    'http://127.0.0.1:18791/health',
    'http://10.0.0.5/a.png',
    'http://172.16.3.4/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[::1]/a.png',
    'http://[fd00::1]/a.png',
    'https://user:pass@example.com/a.png',
    'http://printer.local/a.png',
    'not a url',
    '',
  ])('rejects %s', (url) => expect(isAllowedImageUrl(url)).toBe(false))

  it('accepts data URLs only for the fetch fallback check', () => {
    expect(isAllowedImageUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isFetchableImageUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isFetchableImageUrl('blob:https://a.example/1')).toBe(false)
  })
})

describe('urlKey and RequestMap', () => {
  it('ignores the fragment', () => {
    expect(urlKey('https://a.example/p.jpg#x')).toBe('https://a.example/p.jpg')
  })

  it('evicts the least recently used entry', () => {
    const map = new RequestMap(2)
    map.set('https://a/1', 'r1')
    map.set('https://a/2', 'r2')
    expect(map.get('https://a/1')).toBe('r1') // refreshes 1
    map.set('https://a/3', 'r3') // evicts 2
    expect(map.get('https://a/2')).toBeUndefined()
    expect(map.get('https://a/1#frag')).toBe('r1')
    expect(map.size).toBe(2)
    map.clear()
    expect(map.size).toBe(0)
  })
})

describe('readLimited and decodeDataUrl', () => {
  function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
  }

  it('concatenates chunks under the limit', async () => {
    const result = await readLimited(stream([Uint8Array.from([1, 2]), Uint8Array.from([3])]), 10)
    expect(result).toEqual({ ok: true, bytes: Uint8Array.from([1, 2, 3]) })
  })

  it('stops when the body exceeds the limit', async () => {
    const result = await readLimited(stream([new Uint8Array(6), new Uint8Array(6)]), 10)
    expect(result).toEqual({ ok: false, reason: 'too-large' })
  })

  it('rejects early on a declared length above the limit', async () => {
    expect(await readLimited(stream([new Uint8Array(1)]), 10, 11)).toEqual({ ok: false, reason: 'too-large' })
  })

  it('decodes base64 and percent-encoded data URLs', () => {
    expect(decodeDataUrl('data:image/png;base64,AQID')).toEqual(Uint8Array.from([1, 2, 3]))
    expect(decodeDataUrl('data:text/plain,%01%02')).toEqual(Uint8Array.from([1, 2]))
    expect(decodeDataUrl('data:broken')).toBeNull()
  })
})

describe('captureImage', () => {
  const page = 'https://site.example/chapter/1'
  function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps & { getLoadedBytes: ReturnType<typeof vi.fn>; fetchBytes: ReturnType<typeof vi.fn> } {
    return {
      getLoadedBytes: vi.fn(() => Promise.resolve(null)),
      fetchBytes: vi.fn(() => Promise.resolve({ ok: true as const, bytes: JPEG })),
      ...overrides,
    } as never
  }

  it('prefers bytes the browser already loaded and does not fetch', async () => {
    const d = deps({ getLoadedBytes: vi.fn(() => Promise.resolve(PNG)) })
    const result = await captureImage(d, { url: 'https://cdn.example/1.png', pageUrl: page, maxBytes: 1000 })
    expect(result).toMatchObject({ ok: true, image: { source: 'cdp', mime: 'image/png', hash: sha256Hex(PNG) } })
    expect(d.fetchBytes).not.toHaveBeenCalled()
  })

  it('falls back to fetch with the page as Referer when CDP has no body', async () => {
    const d = deps()
    const result = await captureImage(d, { url: 'https://cdn.example/1.jpg', pageUrl: page, maxBytes: 1000 })
    expect(result).toMatchObject({ ok: true, image: { source: 'fetch', mime: 'image/jpeg' } })
    expect(d.fetchBytes).toHaveBeenCalledWith('https://cdn.example/1.jpg', page, 1000)
  })

  it('falls back to fetch when CDP throws or returns a non-image body', async () => {
    const throwing = deps({ getLoadedBytes: vi.fn(() => Promise.reject(new Error('detached'))) })
    expect(await captureImage(throwing, { url: 'https://cdn.example/1.jpg', pageUrl: page, maxBytes: 1000 })).toMatchObject({ ok: true })
    expect(throwing.fetchBytes).toHaveBeenCalledTimes(1)

    const html = deps({ getLoadedBytes: vi.fn(() => Promise.resolve(HTML)) })
    expect(await captureImage(html, { url: 'https://cdn.example/1.jpg', pageUrl: page, maxBytes: 1000 })).toMatchObject({ ok: true, image: { source: 'fetch' } })
  })

  it('hashes the same bytes identically regardless of URL', async () => {
    const a = await captureImage(deps({ getLoadedBytes: vi.fn(() => Promise.resolve(PNG)) }), { url: 'https://a.example/x.png', pageUrl: page, maxBytes: 1000 })
    const b = await captureImage(deps({ getLoadedBytes: vi.fn(() => Promise.resolve(PNG)) }), { url: 'https://b.example/y.png?t=2', pageUrl: page, maxBytes: 1000 })
    expect(a.ok && b.ok && a.image.hash === b.image.hash).toBe(true)
  })

  it('refuses disallowed fetch URLs', async () => {
    const d = deps()
    const result = await captureImage(d, { url: 'http://127.0.0.1:18791/x.png', pageUrl: page, maxBytes: 1000 })
    expect(result).toEqual({ ok: false, code: 'URL_NOT_ALLOWED' })
    expect(d.fetchBytes).not.toHaveBeenCalled()
  })

  it('reports CAPTURE_UNAVAILABLE for a blob URL without a CDP body', async () => {
    const result = await captureImage(deps(), { url: 'blob:https://site.example/abc', pageUrl: page, maxBytes: 1000 })
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_UNAVAILABLE' })
  })

  it('enforces the size limit on both paths', async () => {
    const cdp = deps({ getLoadedBytes: vi.fn(() => Promise.resolve(PNG)) })
    expect(await captureImage(cdp, { url: 'https://cdn.example/1.png', pageUrl: page, maxBytes: 5 })).toEqual({ ok: false, code: 'TOO_LARGE' })
    const fetchTooLarge = deps({ fetchBytes: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'too-large' as const })) })
    expect(await captureImage(fetchTooLarge, { url: 'https://cdn.example/1.png', pageUrl: page, maxBytes: 5 })).toEqual({ ok: false, code: 'TOO_LARGE' })
  })

  it('rejects unsupported content and network failures', async () => {
    const html = deps({ fetchBytes: vi.fn(() => Promise.resolve({ ok: true as const, bytes: HTML })) })
    expect(await captureImage(html, { url: 'https://cdn.example/1.png', pageUrl: page, maxBytes: 1000 })).toEqual({ ok: false, code: 'UNSUPPORTED_TYPE' })
    const failing = deps({ fetchBytes: vi.fn(() => Promise.reject(new Error('ECONNRESET'))) })
    expect(await captureImage(failing, { url: 'https://cdn.example/1.png', pageUrl: page, maxBytes: 1000 })).toMatchObject({ ok: false, code: 'FETCH_FAILED' })
  })

  it('decodes data URLs without any network access', async () => {
    const d = deps()
    const url = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    const result = await captureImage(d, { url, pageUrl: page, maxBytes: 1000 })
    expect(result).toMatchObject({ ok: true, image: { source: 'data-url', mime: 'image/png' } })
    expect(d.getLoadedBytes).not.toHaveBeenCalled()
    expect(d.fetchBytes).not.toHaveBeenCalled()
  })
})
