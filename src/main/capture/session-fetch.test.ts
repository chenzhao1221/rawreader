import { describe, expect, it, vi } from 'vitest'
import { createSessionFetch } from './session-fetch'

describe('createSessionFetch', () => {
  it('sends the page as Referer and returns the body', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(Uint8Array.from([1, 2, 3]), { status: 200 })))
    const result = await createSessionFetch({ fetch })('https://cdn.example/1.png', 'https://site.example/ch1', 100)
    expect(result).toEqual({ ok: true, bytes: Uint8Array.from([1, 2, 3]) })
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['Referer']).toBe('https://site.example/ch1')
  })

  it('reports HTTP errors', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('no', { status: 403 })))
    expect(await createSessionFetch({ fetch })('https://cdn.example/1.png', 'https://s.example/', 100)).toEqual({
      ok: false,
      reason: 'http-error',
    })
  })

  it('reports bodies above the limit', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(new Uint8Array(50), { status: 200 })))
    expect(await createSessionFetch({ fetch })('https://cdn.example/1.png', 'https://s.example/', 10)).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })
})
