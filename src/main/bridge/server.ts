import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { sniffMime } from '../capture/sniff'
import type { Logger } from '../log/log'
import { checkRequest } from './guards'
import { HISTORY_BODY_LIMIT_BYTES, HistoryOpenRequestSchema, HistoryRequestSchema, TranslateRequestSchema } from './protocol'
import type { BridgeError, HistoryItem, PingResponse, TranslateRequest, TranslateResponse } from './protocol'

/** The only address the bridge ever binds. Not configurable on purpose. */
export const BRIDGE_HOST = '127.0.0.1'

/** JSON overhead allowed on top of the base64 image (ER2.8). */
export const BODY_OVERHEAD_BYTES = 64 * 1024

/** What `translate` receives: the validated request with the image already decoded. */
export interface BridgeTranslateJob {
  bytes: Uint8Array
  priority: number
  context: TranslateRequest['context']
  boxes: TranslateRequest['boxes']
  /** Aborted when the client closes the connection before the answer. */
  signal: AbortSignal
}

/** Failure thrown by `translate`: `code` is a pipeline or stage code, `CANCELLED` for an abort. */
export interface BridgeFailure {
  code: string
  message: string
}

/** Codes that mean "the engine cannot take work now" (answered 503 instead of 502). */
const UNAVAILABLE_CODES = new Set(['SERVER_NOT_READY', 'API_KEY_MISSING', 'MODEL_MISSING'])

/** What the history routes need from the app. */
export interface BridgeHistoryPort {
  /** Stores the visits; returns how many were stored or updated. */
  record(items: readonly HistoryItem[]): number
  /** Shows the history page in the app window. */
  open(): void
}

export interface BridgeServerDeps {
  /** Reading history of the app. Without it the history routes answer 404. */
  history?: BridgeHistoryPort
  /** Status for `GET /ping`. */
  ping(): PingResponse
  translate(job: BridgeTranslateJob): Promise<TranslateResponse>
  /** Largest accepted image, in bytes (`pipeline.maxImageBytes`). Read per request. */
  maxImageBytes(): number
  logger: Logger
  now?: () => number
}

export interface BridgeServer {
  /** Listens on 127.0.0.1:`port` (0 = any free port). Resolves with the port in use; rejects on a bind error. */
  start(port: number): Promise<number>
  /** Stops listening, aborts in-flight requests and closes their sockets. */
  stop(): Promise<void>
  readonly listening: boolean
}

function errorBody(code: string, message: string): BridgeError {
  return { code, message }
}

function isFailure(value: unknown): value is BridgeFailure {
  return typeof value === 'object' && value !== null && typeof (value as BridgeFailure).code === 'string'
}

/**
 * Local HTTP server for the Chrome extension (design 4.1, 4.2). Plain `node:http`, no Electron. All work is
 * behind injected dependencies, so tests run it on `127.0.0.1:0` with fakes.
 */
export function createBridgeServer(deps: BridgeServerDeps): BridgeServer {
  const now = deps.now ?? Date.now
  let server: Server | null = null
  let port = 0
  /** Aborted on stop(): every in-flight request stops its work. */
  let lifetime = new AbortController()

  function send(res: ServerResponse, status: number, body: unknown, origin?: string, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.destroyed) return
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Only a validated extension origin is ever echoed. No wildcard, no credentials.
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      ...extra,
    })
    res.end(text)
  }

  /** Reads the body with a hard cap; returns null after answering 413. */
  function readBody(req: IncomingMessage, res: ServerResponse, limit: number, origin: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > limit) {
        send(res, 413, errorBody('too-large', 'Request body is too large'), origin, { Connection: 'close' })
        resolve(null)
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      let done = false
      const finish = (value: Buffer | null): void => {
        if (done) return
        done = true
        resolve(value)
      }
      req.on('data', (chunk: Buffer) => {
        if (done) return
        total += chunk.length
        if (total > limit) {
          // Stop buffering at once; the connection is closed after the answer.
          chunks.length = 0
          send(res, 413, errorBody('too-large', 'Request body is too large'), origin, { Connection: 'close' })
          finish(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => finish(Buffer.concat(chunks, total)))
      req.on('error', () => finish(null))
      req.on('close', () => finish(null))
    })
  }

  /** `POST /history` (visits from the extension) and `POST /history/open` (show the history page). */
  async function handleHistory(req: IncomingMessage, res: ServerResponse, origin: string, route: 'history' | 'history-open'): Promise<void> {
    const history = deps.history
    if (!history) {
      send(res, 404, errorBody('not-found', 'Not found'), origin)
      return
    }
    const body = await readBody(req, res, route === 'history' ? HISTORY_BODY_LIMIT_BYTES : 1024, origin)
    if (body === null) return
    let json: unknown
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      send(res, 400, errorBody('bad-request', 'Body is not valid JSON'), origin)
      return
    }
    if (route === 'history-open') {
      if (!HistoryOpenRequestSchema.safeParse(json).success) {
        send(res, 400, errorBody('bad-request', 'Invalid request: body'), origin)
        return
      }
      history.open()
      send(res, 200, { v: 1, ok: true }, origin)
      return
    }
    const parsed = HistoryRequestSchema.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      send(res, 400, errorBody('bad-request', `Invalid request: ${issue?.path.join('.') || 'body'}`), origin)
      return
    }
    send(res, 200, { v: 1, accepted: history.record(parsed.data.items) }, origin)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now()
    const method = req.method ?? ''
    let path = '/'
    try {
      path = new URL(req.url ?? '/', 'http://bridge.invalid').pathname
    } catch {
      // Keep '/', which is not a route.
    }
    let status = 0
    let bytesIn = 0
    res.once('finish', () => {
      status = res.statusCode
      deps.logger.info(`bridge ${method} ${path} ${status} ${now() - started}ms in=${bytesIn}B`)
    })

    // Nothing below may reflect or log headers or the image.
    const verdict = checkRequest({ method, path, host: req.headers.host, origin: req.headers.origin }, { port })
    if (!verdict.ok) {
      send(res, verdict.status, errorBody(verdict.code, verdict.message), verdict.origin, { Connection: 'close' })
      return
    }
    const origin = verdict.origin

    if (verdict.preflight) {
      send(res, 204, undefined, origin, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        'Access-Control-Allow-Private-Network': 'true',
      })
      return
    }

    if (verdict.route === 'ping') {
      send(res, 200, deps.ping(), origin)
      return
    }

    if (verdict.route === 'history' || verdict.route === 'history-open') {
      await handleHistory(req, res, origin, verdict.route)
      return
    }

    // POST /translate
    const maxImage = deps.maxImageBytes()
    const bodyLimit = Math.ceil((maxImage * 4) / 3) + BODY_OVERHEAD_BYTES
    const body = await readBody(req, res, bodyLimit, origin)
    if (body === null) return
    bytesIn = body.length

    let json: unknown
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      send(res, 400, errorBody('bad-request', 'Body is not valid JSON'), origin)
      return
    }
    const parsed = TranslateRequestSchema.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      send(res, 400, errorBody('bad-request', `Invalid request: ${issue?.path.join('.') || 'body'}`), origin)
      return
    }
    const request = parsed.data
    const bytes = new Uint8Array(Buffer.from(request.image, 'base64'))
    if (bytes.length > maxImage) {
      send(res, 413, errorBody('too-large', 'Image is larger than the allowed size'), origin)
      return
    }
    if (sniffMime(bytes) === null) {
      send(res, 415, errorBody('unsupported-image', 'Not a supported image format'), origin)
      return
    }

    // Client gone before the answer: stop queued and running stages. No response is possible then.
    const controller = new AbortController()
    const onLifetime = (): void => controller.abort()
    lifetime.signal.addEventListener('abort', onLifetime, { once: true })
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
      lifetime.signal.removeEventListener('abort', onLifetime)
    })
    try {
      const result = await deps.translate({
        bytes,
        priority: request.priority ?? 0,
        context: request.context,
        boxes: request.boxes,
        signal: controller.signal,
      })
      send(res, 200, result, origin)
    } catch (error) {
      if (controller.signal.aborted) return
      const failure = isFailure(error) ? error : { code: 'internal', message: 'Translation failed' }
      const unavailable = UNAVAILABLE_CODES.has(failure.code)
      send(res, unavailable ? 503 : failure.code === 'internal' ? 500 : 502, errorBody(failure.code, failure.message), origin)
    }
  }

  return {
    get listening() {
      return server?.listening ?? false
    },

    start(requestedPort) {
      if (server) return Promise.reject(new Error('Bridge is already running'))
      const created = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
          deps.logger.error(`bridge handler failed: ${error instanceof Error ? error.message : String(error)}`)
          send(res, 500, errorBody('internal', 'Internal error'))
        })
      })
      // A slow or silent client must not hold a connection forever.
      created.headersTimeout = 10_000
      created.requestTimeout = 120_000
      created.keepAliveTimeout = 5_000
      lifetime = new AbortController()
      server = created
      return new Promise<number>((resolve, reject) => {
        let listeningNow = false
        created.on('error', (error: Error) => {
          if (listeningNow) {
            deps.logger.error(`bridge server error: ${error.message}`)
            return
          }
          server = null
          reject(error)
        })
        created.listen(requestedPort, BRIDGE_HOST, () => {
          const address = created.address()
          port = typeof address === 'object' && address ? address.port : requestedPort
          listeningNow = true
          resolve(port)
        })
      })
    },

    async stop() {
      const current = server
      if (!current) return
      server = null
      lifetime.abort()
      await new Promise<void>((resolve) => {
        current.close(() => resolve())
        current.closeAllConnections()
      })
    },
  }
}
