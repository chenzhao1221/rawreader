import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../log/log'
import { attachCdpCapture } from './cdp'
import type { WebContentsLike } from './cdp'

function fakeWebContents() {
  let onMessage: (e: unknown, method: string, params: unknown) => void = () => {}
  let onDetach: (e: unknown, reason: string) => void = () => {}
  let onNav: (d: { isMainFrame: boolean; isSameDocument: boolean }) => void = () => {}
  const sendCommand = vi.fn((method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'Network.getResponseBody') {
      return params?.['requestId'] === 'gone'
        ? Promise.reject(new Error('No resource with given identifier'))
        : Promise.resolve({ body: Buffer.from([9, 8, 7]).toString('base64'), base64Encoded: true })
    }
    return Promise.resolve({})
  })
  const wc: WebContentsLike = {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => true,
      sendCommand,
      on: ((event: string, listener: never) => {
        if (event === 'message') onMessage = listener
        else onDetach = listener
      }) as never,
    },
    on: ((_event: string, listener: never) => {
      onNav = listener
    }) as never,
    isDestroyed: () => false,
  }
  return {
    wc,
    sendCommand,
    message: (method: string, params: unknown) => onMessage({}, method, params),
    detach: (reason: string) => onDetach({}, reason),
    navigate: (isMainFrame: boolean, isSameDocument = false) => onNav({ isMainFrame, isSameDocument }),
  }
}

const imageResponse = (requestId: string, url: string, status = 200) => ({
  requestId,
  type: 'Image',
  response: { url, status },
})

describe('attachCdpCapture', () => {
  it('enables the Network domain with raised buffers', () => {
    const f = fakeWebContents()
    attachCdpCapture(f.wc, silentLogger)
    expect(f.sendCommand).toHaveBeenCalledWith(
      'Network.enable',
      expect.objectContaining({ maxResourceBufferSize: expect.any(Number), maxTotalBufferSize: expect.any(Number) }),
    )
  })

  it('returns the body of a finished image response', async () => {
    const f = fakeWebContents()
    const cdp = attachCdpCapture(f.wc, silentLogger)
    f.message('Network.responseReceived', imageResponse('r1', 'https://cdn.example/1.jpg?t=1'))
    expect(await cdp.getBody('https://cdn.example/1.jpg?t=1')).toBeNull() // not finished yet
    f.message('Network.loadingFinished', { requestId: 'r1' })
    expect(await cdp.getBody('https://cdn.example/1.jpg?t=1')).toEqual(Uint8Array.from([9, 8, 7]))
  })

  it('ignores non-image and failed responses', async () => {
    const f = fakeWebContents()
    const cdp = attachCdpCapture(f.wc, silentLogger)
    f.message('Network.responseReceived', { requestId: 'a', type: 'Script', response: { url: 'https://x/a.js', status: 200 } })
    f.message('Network.loadingFinished', { requestId: 'a' })
    f.message('Network.responseReceived', imageResponse('b', 'https://x/b.png', 404))
    f.message('Network.loadingFinished', { requestId: 'b' })
    expect(await cdp.getBody('https://x/a.js')).toBeNull()
    expect(await cdp.getBody('https://x/b.png')).toBeNull()
  })

  it('returns null when the browser no longer has the body', async () => {
    const f = fakeWebContents()
    const cdp = attachCdpCapture(f.wc, silentLogger)
    f.message('Network.responseReceived', imageResponse('gone', 'https://x/c.png'))
    f.message('Network.loadingFinished', { requestId: 'gone' })
    expect(await cdp.getBody('https://x/c.png')).toBeNull()
  })

  it('forgets requests on main-frame navigation but not on same-document navigation', async () => {
    const f = fakeWebContents()
    const cdp = attachCdpCapture(f.wc, silentLogger)
    f.message('Network.responseReceived', imageResponse('r1', 'https://x/d.png'))
    f.message('Network.loadingFinished', { requestId: 'r1' })
    f.navigate(true, true)
    f.navigate(false)
    expect(await cdp.getBody('https://x/d.png')).not.toBeNull()
    f.navigate(true)
    expect(await cdp.getBody('https://x/d.png')).toBeNull()
  })

  it('becomes unavailable after the debugger detaches', async () => {
    const f = fakeWebContents()
    const cdp = attachCdpCapture(f.wc, silentLogger)
    f.message('Network.responseReceived', imageResponse('r1', 'https://x/e.png'))
    f.message('Network.loadingFinished', { requestId: 'r1' })
    f.detach('target closed')
    expect(cdp.isAvailable()).toBe(false)
    expect(await cdp.getBody('https://x/e.png')).toBeNull()
  })

  it('stays unavailable when attach throws', async () => {
    const f = fakeWebContents()
    ;(f.wc.debugger.attach as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Another debugger is already attached')
    })
    const cdp = attachCdpCapture(f.wc, silentLogger)
    expect(cdp.isAvailable()).toBe(false)
    expect(await cdp.getBody('https://x/f.png')).toBeNull()
  })
})
