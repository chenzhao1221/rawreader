import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Deterministic bytes of the given size (never real model data). */
export function fixtureBytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size)
  let x = seed >>> 0 || 1
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out[i] = x >>> 24
  }
  return out
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export type RouteBehavior =
  | { kind: 'ok' }
  /** Serve the whole file with 200 even when a Range header is present. */
  | { kind: 'ignore-range' }
  | { kind: 'status'; status: number }
  /** Send `bytes` of the body and then drop the connection. */
  | { kind: 'truncate'; bytes: number }
  /** 206 with a Content-Range that starts somewhere else. */
  | { kind: 'wrong-content-range' }
  /** Send the body in small chunks with a delay, so a test can abort in the middle. */
  | { kind: 'slow'; chunk: number; delayMs: number }
  /** Same length as the real file but different content. */
  | { kind: 'corrupt' }

export interface RecordedRequest {
  path: string
  range: string | null
}

export interface TestServer {
  baseUrl: string
  requests: RecordedRequest[]
  /** Sets the behaviour list for a path. Each request consumes the first entry; the last entry repeats. */
  route(path: string, body: Uint8Array, behaviors?: RouteBehavior[]): void
  close(): Promise<void>
}

function parseRange(header: string | undefined, total: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = header?.match(/^bytes=(\d+)-(\d*)$/)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
  if (start >= total) return 'unsatisfiable'
  return { start, end }
}

export async function startTestServer(): Promise<TestServer> {
  const routes = new Map<string, { body: Uint8Array; behaviors: RouteBehavior[]; calls: number }>()
  const requests: RecordedRequest[] = []

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const range = typeof req.headers.range === 'string' ? req.headers.range : null
    requests.push({ path, range })
    const route = routes.get(path)
    if (!route) {
      res.writeHead(404).end()
      return
    }
    const behavior = route.behaviors[Math.min(route.calls, route.behaviors.length - 1)] ?? { kind: 'ok' }
    route.calls++
    const { body } = route
    const total = body.byteLength

    if (behavior.kind === 'status') {
      res.writeHead(behavior.status).end()
      return
    }

    const parsed = behavior.kind === 'ignore-range' ? null : parseRange(range ?? undefined, total)
    if (parsed === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
      return
    }

    let payload = body
    if (behavior.kind === 'corrupt') {
      payload = Uint8Array.from(body, (b) => b ^ 0xff)
    }

    let start = 0
    let status = 200
    const headers: Record<string, string | number> = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' }
    if (parsed) {
      start = parsed.start
      status = 206
      const shown = behavior.kind === 'wrong-content-range' ? Math.max(0, start - 1) : start
      headers['Content-Range'] = `bytes ${shown}-${parsed.end}/${total}`
    }
    const slice = payload.subarray(start)
    headers['Content-Length'] = slice.byteLength
    res.writeHead(status, headers)

    if (behavior.kind === 'truncate') {
      res.write(slice.subarray(0, behavior.bytes), () => {
        res.destroy()
      })
      return
    }
    if (behavior.kind === 'slow') {
      let offset = 0
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer)
          return
        }
        if (offset >= slice.byteLength) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write(slice.subarray(offset, offset + behavior.chunk))
        offset += behavior.chunk
      }, behavior.delayMs)
      res.on('close', () => clearInterval(timer))
      return
    }
    res.end(slice)
  }

  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    route(path, body, behaviors = [{ kind: 'ok' }]) {
      routes.set(path, { body, behaviors, calls: 0 })
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}
