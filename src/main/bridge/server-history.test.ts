import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_ALLOWED_ORIGIN } from '../../shared/bridge'
import { silentLogger } from '../log/log'
import { createBridgeServer } from './server'
import type { BridgeHistoryPort, BridgeServer, BridgeServerDeps } from './server'
import { HISTORY_BODY_LIMIT_BYTES, MAX_HISTORY_ITEMS } from './protocol'

interface Reply {
  status: number
  json: unknown
}

function call(port: number, path: string, body: unknown, headers: Record<string, string | undefined> = {}, method = 'POST'): Promise<Reply> {
  const merged: Record<string, string | undefined> = { Host: `127.0.0.1:${port}`, Origin: BRIDGE_ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...headers }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) out[key] = value
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: out }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
}

describe('bridge history routes', () => {
  let server: BridgeServer | null = null

  async function boot(withHistory = true) {
    const history = { record: vi.fn((items: readonly unknown[]) => items.length), open: vi.fn() } satisfies BridgeHistoryPort
    const deps: BridgeServerDeps = {
      ping: () => ({ v: 1, app: 'App', version: '0.0.1', ready: true, engine: 'local' }),
      translate: () => Promise.reject(new Error('not used')),
      maxImageBytes: () => 1000,
      logger: silentLogger,
      ...(withHistory ? { history } : {}),
    }
    server = createBridgeServer(deps)
    return { port: await server.start(0), history }
  }

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  const item = (n: number) => ({ url: `https://reader.example.com/c/${n}`, title: `Chapter ${n}`, visitedAt: 1_700_000_000_000 + n })

  it('POST /history hands the validated items to the app and answers how many were stored', async () => {
    const { port, history } = await boot()
    const reply = await call(port, '/history', { v: 1, items: [item(1), { url: 'https://reader.example.com/c/2', series: 'S', chapter: '2' }] })
    expect(reply).toEqual({ status: 200, json: { v: 1, accepted: 2 } })
    expect(history.record).toHaveBeenCalledWith([item(1), { url: 'https://reader.example.com/c/2', series: 'S', chapter: '2' }])
  })

  it('rejects an empty list, too many items, unknown fields and a wrong version with 400', async () => {
    const { port, history } = await boot()
    const bad: unknown[] = [
      { v: 1, items: [] },
      { v: 1, items: Array.from({ length: MAX_HISTORY_ITEMS + 1 }, (_, i) => item(i)) },
      { v: 1, items: [{ ...item(1), cookie: 'x' }] },
      { v: 2, items: [item(1)] },
      { v: 1, items: [{ url: '' }] },
      { v: 1, items: [{ url: 'https://example.com/', visitedAt: Number.NaN }] },
      'not json',
    ]
    for (const body of bad) expect((await call(port, '/history', body)).status).toBe(400)
    expect(history.record).not.toHaveBeenCalled()
  })

  it('answers 413 for a body over the limit without calling the app', async () => {
    const { port, history } = await boot()
    const huge = JSON.stringify({ v: 1, items: [{ url: 'https://example.com/', title: 'x'.repeat(HISTORY_BODY_LIMIT_BYTES) }] })
    expect((await call(port, '/history', huge)).status).toBe(413)
    expect(history.record).not.toHaveBeenCalled()
  })

  it('POST /history/open asks the app to show the history', async () => {
    const { port, history } = await boot()
    expect(await call(port, '/history/open', { v: 1 })).toEqual({ status: 200, json: { v: 1, ok: true } })
    expect(history.open).toHaveBeenCalledTimes(1)
    expect((await call(port, '/history/open', { v: 1, extra: true })).status).toBe(400)
    expect(history.open).toHaveBeenCalledTimes(1)
  })

  it('refuses a web page, another extension and a missing Origin with 403, and never reaches the app', async () => {
    const { port, history } = await boot()
    for (const origin of ['https://site.example', `chrome-extension://${'b'.repeat(32)}`, undefined]) {
      expect((await call(port, '/history', { v: 1, items: [item(1)] }, { Origin: origin })).status).toBe(403)
      expect((await call(port, '/history/open', { v: 1 }, { Origin: origin })).status).toBe(403)
    }
    expect((await call(port, '/history', { v: 1, items: [item(1)] }, { Host: 'evil.example' })).status).toBe(403)
    expect(history.record).not.toHaveBeenCalled()
    expect(history.open).not.toHaveBeenCalled()
  })

  it('answers GET on the history routes with 404 and an app without history with 404', async () => {
    const { port } = await boot()
    expect((await call(port, '/history', '', {}, 'GET')).status).toBe(404)
    await server?.stop()
    const { port: second } = await boot(false)
    expect((await call(second, '/history', { v: 1, items: [item(1)] })).status).toBe(404)
    expect((await call(second, '/history/open', { v: 1 })).status).toBe(404)
  })
})
