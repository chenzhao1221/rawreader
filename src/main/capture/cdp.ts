import type { Logger } from '../log/log'
import { RequestMap } from './request-map'

/** Raise the CDP buffers so long webtoon strips are not evicted before we read them (design section 7). */
export const MAX_RESOURCE_BUFFER_BYTES = 64 * 1024 * 1024
export const MAX_TOTAL_BUFFER_BYTES = 512 * 1024 * 1024

/** The slice of `webContents` and its debugger this module uses. Lets tests pass a fake. */
export interface DebuggerLike {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}

export interface WebContentsLike {
  debugger: DebuggerLike
  on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
  isDestroyed(): boolean
}

export interface CdpCapture {
  /** Body of the finished image response for `url`, or null when CDP cannot provide it. */
  getBody(url: string): Promise<Uint8Array | null>
  /** False after the debugger detached (for example DevTools opened) or failed to attach. */
  isAvailable(): boolean
  dispose(): void
}

interface ResponseReceivedParams {
  requestId: string
  type?: string
  response?: { url?: string; status?: number }
}

interface LoadingFinishedParams {
  requestId: string
}

/**
 * Attaches the CDP debugger to the browse view and records which request id
 * produced each finished image response. Only metadata is kept; bodies are read
 * on demand through `Network.getResponseBody`.
 */
export function attachCdpCapture(wc: WebContentsLike, logger: Logger): CdpCapture {
  const finished = new RequestMap(2000)
  /** Image responses seen but not yet finished: requestId -> url. */
  const inFlight = new Map<string, string>()
  let available = false

  const reset = (): void => {
    finished.clear()
    inFlight.clear()
  }

  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) reset()
  })

  wc.debugger.on('message', (_event, method, params) => {
    if (method === 'Network.responseReceived') {
      const p = params as ResponseReceivedParams
      const status = p.response?.status ?? 0
      if (p.type === 'Image' && p.response?.url && status >= 200 && status < 300) {
        inFlight.set(p.requestId, p.response.url)
      }
    } else if (method === 'Network.loadingFinished') {
      const p = params as LoadingFinishedParams
      const url = inFlight.get(p.requestId)
      if (url !== undefined) {
        inFlight.delete(p.requestId)
        finished.set(url, p.requestId)
      }
    } else if (method === 'Network.loadingFailed') {
      inFlight.delete((params as LoadingFinishedParams).requestId)
    }
  })

  wc.debugger.on('detach', (_event, reason) => {
    available = false
    reset()
    logger.warn(`CDP debugger detached (${reason}); using the fetch fallback`)
  })

  try {
    wc.debugger.attach('1.3')
    available = true
    void wc.debugger
      .sendCommand('Network.enable', {
        maxResourceBufferSize: MAX_RESOURCE_BUFFER_BYTES,
        maxTotalBufferSize: MAX_TOTAL_BUFFER_BYTES,
      })
      .catch((error: unknown) => {
        available = false
        logger.warn(`Network.enable failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  } catch (error) {
    logger.warn(`Cannot attach the CDP debugger: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    isAvailable: () => available,
    async getBody(url) {
      if (!available || wc.isDestroyed()) return null
      const requestId = finished.get(url)
      if (requestId === undefined) return null
      try {
        const result = (await wc.debugger.sendCommand('Network.getResponseBody', { requestId })) as {
          body: string
          base64Encoded: boolean
        }
        return new Uint8Array(Buffer.from(result.body, result.base64Encoded ? 'base64' : 'latin1'))
      } catch {
        // Evicted from the browser's buffer, or the request is gone.
        return null
      }
    },
    dispose() {
      available = false
      reset()
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach()
      } catch {
        // The webContents may already be gone.
      }
    },
  }
}
