import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_ALLOWED_ORIGIN } from '../../shared/bridge'
import { silentLogger } from '../log/log'
import { BRIDGE_HOST, createBridgeServer } from './server'
import type { BridgeServer, BridgeServerDeps, BridgeTranslateJob } from './server'
import type { TranslateResponse } from './protocol'

const ORIGIN = BRIDGE_ALLOWED_ORIGIN
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

const okResponse: TranslateResponse = {
  v: 1,
  hash: 'h'.repeat(64),
  width: 10,
  height: 20,
  cached: false,
  units: [],
  timings: { detectMs: 1, ocrMs: 2, translateMs: 3 },
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  json: unknown
}

interface Call {
  method?: string
  path?: string
  headers?: Record<string, string | undefined>
  body?: string | Buffer
}

function send(port: number, call: Call = {}): Promise<Reply> {
  const headers: Record<string, string> = {}
  const defaults: Record<string, string | undefined> = {
    Host: `127.0.0.1:${port}`,
    Origin: ORIGIN,
    ...call.headers,
  }
  for (const [key, value] of Object.entries(defaults)) if (value !== undefined) headers[key] = value
  return new Promise((resolve, reject) => {
    const req = request({ host: BRIDGE_HOST, port, method: call.method ?? 'GET', path: call.path ?? '/ping', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(call.body)
  })
}

const post = (port: number, body: unknown, headers?: Call['headers']): Promise<Reply> =>
  send(port, { method: 'POST', path: '/translate', body: typeof body === 'string' ? body : JSON.stringify(body), headers })

describe('bridge HTTP server', () => {
  let server: BridgeServer | null = null

  async function boot(overrides: Partial<BridgeServerDeps> = {}) {
    const translate = vi.fn((_job: BridgeTranslateJob) => Promise.resolve(okResponse))
    const ping = vi.fn(() => ({ v: 1 as const, app: 'App', version: '0.0.1', ready: true, engine: 'local' as const }))
    const s = createBridgeServer({
      ping,
      translate,
      maxImageBytes: () => 1000,
      logger: silentLogger,
      ...overrides,
    })
    server = s
    const port = await s.start(0)
    return { port, translate, ping, server: s }
  }

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  it('listens on 127.0.0.1 only and offers no way to choose another address', async () => {
    const { port, server: s } = await boot()
    expect(BRIDGE_HOST).toBe('127.0.0.1')
    expect(s.listening).toBe(true)
    expect(s.start.length).toBe(1) // start(port): the address is not a parameter
    const reply = await send(port)
    expect(reply.status).toBe(200)
    await s.stop()
    expect(s.listening).toBe(false)
  })

  it('answers GET /ping with the ping dependency and echoes only the extension origin', async () => {
    const { port } = await boot()
    const reply = await send(port)
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ v: 1, ready: true, engine: 'local' })
    expect(reply.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined()
    expect(reply.headers.vary).toBe('Origin')
  })

  it('answers the CORS preflight for the extension origin only', async () => {
    const { port } = await boot()
    const ok = await send(port, { method: 'OPTIONS', path: '/translate', })
    expect(ok.status).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(ok.headers['access-control-allow-headers']).toBe('Content-Type')
    const page = await send(port, { method: 'OPTIONS', path: '/translate', headers: { Origin: 'https://site.example' } })
    expect(page.status).toBe(403)
    expect(page.headers['access-control-allow-origin']).toBeUndefined()
  })

  it.each<[string, Call, number, string]>([
    ['non-loopback Host', { headers: { Host: 'localhost:1234' } }, 403, 'forbidden-host'],
    ['page Origin', { headers: { Origin: 'https://site.example' } }, 403, 'forbidden-origin'],
    ['no Origin', { headers: { Origin: undefined } }, 403, 'forbidden-origin'],
    ['another extension ID', { headers: { Origin: `chrome-extension://${'b'.repeat(32)}` } }, 403, 'forbidden-origin'],
    ['unknown path', { path: '/admin' }, 404, 'not-found'],
    ['unsupported method', { method: 'DELETE', path: '/translate' }, 404, 'not-found'],
  ])('rejects %s', async (_name, call, status, code) => {
    const { port, translate } = await boot()
    const reply = await send(port, call)
    expect(reply.status).toBe(status)
    expect(reply.json).toMatchObject({ code })
    expect(translate).not.toHaveBeenCalled()
  })

  it('returns 403 for /translate from a web page or without an Origin, and never calls translate', async () => {
    const { port, translate } = await boot()
    expect((await post(port, { v: 1, image: b64(PNG) }, { Origin: 'https://site.example' })).status).toBe(403)
    expect((await post(port, { v: 1, image: b64(PNG) }, { Origin: undefined })).status).toBe(403)
    expect(translate).not.toHaveBeenCalled()
  })

  it('translates: decodes the image, passes priority, context and boxes, and returns the result', async () => {
    const { port, translate } = await boot()
    const box = { x1: 1, y1: 1, x2: 5, y2: 5, confidence: 1 }
    const reply = await post(port, { v: 1, image: b64(PNG), priority: 3, context: { summary: 's' }, boxes: [box] })
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual(okResponse)
    const job = translate.mock.calls[0]?.[0] as BridgeTranslateJob
    expect(Buffer.from(job.bytes).equals(Buffer.from(PNG))).toBe(true)
    expect(job.priority).toBe(3)
    expect(job.context).toEqual({ summary: 's' })
    expect(job.boxes).toEqual([box])
    expect(job.signal.aborted).toBe(false)
  })

  it.each([
    ['invalid JSON', 'not json'],
    ['unknown field', { v: 1, image: b64(PNG), extra: 1 }],
    ['wrong version', { v: 2, image: b64(PNG) }],
  ])('rejects %s with 400', async (_name, body) => {
    const { port, translate } = await boot()
    const reply = await post(port, body)
    expect(reply.status).toBe(400)
    expect(reply.json).toMatchObject({ code: 'bad-request' })
    expect(translate).not.toHaveBeenCalled()
  })

  it('rejects bytes that are not an image with 415', async () => {
    const { port } = await boot()
    const reply = await post(port, { v: 1, image: Buffer.from('this is plain text, not a picture').toString('base64') })
    expect(reply.status).toBe(415)
    expect(reply.json).toMatchObject({ code: 'unsupported-image' })
  })

  it('caps the body: 413 from the declared length, and from streamed bytes without one', async () => {
    const { port, translate } = await boot({ maxImageBytes: () => 300 })
    // limit = ceil(300 * 4/3) + 64 KiB
    const big = { v: 1, image: 'A'.repeat(70_000) }
    const declared = await post(port, big)
    expect(declared.status).toBe(413)

    const streamed = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: BRIDGE_HOST,
          port,
          method: 'POST',
          path: '/translate',
          headers: { Host: `127.0.0.1:${port}`, Origin: ORIGIN, 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', () => resolve(-1))
      req.write('{"v":1,"image":"')
      req.write('A'.repeat(70_000))
      req.end()
    })
    expect(streamed).toBe(413)
    expect(translate).not.toHaveBeenCalled()
  })

  it('rejects a decoded image above the limit with 413', async () => {
    const { port } = await boot({ maxImageBytes: () => 20 })
    const reply = await post(port, { v: 1, image: b64(Uint8Array.from([...PNG, ...new Array(30).fill(1)])) })
    expect(reply.status).toBe(413)
  })

  it('maps failures: 503 when the engine is not ready, 502 for a stage failure', async () => {
    const notReady = await boot({ translate: () => Promise.reject({ code: 'SERVER_NOT_READY', message: 'ocr server is not ready' }) })
    const a = await post(notReady.port, { v: 1, image: b64(PNG) })
    expect(a.status).toBe(503)
    expect(a.json).toMatchObject({ code: 'SERVER_NOT_READY' })
    await server?.stop()

    const stage = await boot({ translate: () => Promise.reject({ code: 'DETECT_FAILED', message: 'boom' }) })
    const b = await post(stage.port, { v: 1, image: b64(PNG) })
    expect(b.status).toBe(502)
    expect(b.json).toMatchObject({ code: 'DETECT_FAILED' })
    await server?.stop()

    const odd = await boot({ translate: () => Promise.reject(new Error('internal detail with C:\\secret\\path')) })
    const c = await post(odd.port, { v: 1, image: b64(PNG) })
    expect(c.status).toBe(500)
    expect(JSON.stringify(c.json)).not.toContain('secret')
  })

  it('aborts the work when the client closes the connection', async () => {
    let seen: AbortSignal | null = null
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => (started = resolve))
    const { port } = await boot({
      translate: (job) => {
        seen = job.signal
        started()
        return new Promise(() => {})
      },
    })
    const req = request({
      host: BRIDGE_HOST,
      port,
      method: 'POST',
      path: '/translate',
      headers: { Host: `127.0.0.1:${port}`, Origin: ORIGIN },
    })
    req.on('error', () => {})
    req.end(JSON.stringify({ v: 1, image: b64(PNG) }))
    await startedPromise
    expect((seen as AbortSignal | null)?.aborted).toBe(false)
    req.destroy()
    await vi.waitFor(() => expect((seen as AbortSignal | null)?.aborted).toBe(true))
  })

  it('aborts in-flight work when the server stops', async () => {
    let seen: AbortSignal | null = null
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => (started = resolve))
    const { port, server: s } = await boot({
      translate: (job) => {
        seen = job.signal
        started()
        return new Promise(() => {})
      },
    })
    const pending = post(port, { v: 1, image: b64(PNG) }).catch(() => null)
    await startedPromise
    await s.stop()
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    await pending
  })

  it('reports a bind error and stays stopped', async () => {
    const first = await boot()
    const second = createBridgeServer({
      ping: () => ({ v: 1, app: 'A', version: '1', ready: true, engine: 'local' }),
      translate: () => Promise.resolve(okResponse),
      maxImageBytes: () => 1000,
      logger: silentLogger,
    })
    await expect(second.start(first.port)).rejects.toThrow()
    expect(second.listening).toBe(false)
  })
})
