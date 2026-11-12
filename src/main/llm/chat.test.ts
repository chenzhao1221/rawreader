import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHAT_COMPLETIONS_PATH, chat, extractChatText } from './chat'

const reply = (content: unknown, init: ResponseInit = { status: 200 }) =>
  Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), init))

const base = { port: 18792, model: 'Index-Translate-2B', maxTokens: 64, temperature: 0, timeoutMs: 1000 }

describe('chat', () => {
  it('posts to /v1/chat/completions on loopback with the OpenAI body shape', async () => {
    const fetchImpl = vi.fn(() => reply('你好'))
    const result = await chat({ ...base, messages: [{ role: 'user', content: 'hi' }], fetchImpl })
    expect(result).toEqual({ ok: true, text: '你好', finishReason: 'stop' })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:18792/v1/chat/completions')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'Index-Translate-2B', max_tokens: 64, temperature: 0, stream: false })
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('reads text parts content', async () => {
    const fetchImpl = vi.fn(() => reply([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))
    expect(await chat({ ...base, messages: [], fetchImpl })).toMatchObject({ ok: true, text: 'ab' })
  })

  it('maps HTTP errors, bad bodies, network errors and cancellation', async () => {
    const http = vi.fn(() => Promise.resolve(new Response('overloaded', { status: 503 })))
    expect(await chat({ ...base, messages: [], fetchImpl: http })).toMatchObject({ ok: false, error: { code: 'HTTP_ERROR' } })

    const bad = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 })))
    expect(await chat({ ...base, messages: [], fetchImpl: bad })).toMatchObject({ ok: false, error: { code: 'BAD_RESPONSE' } })

    const network = vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    expect(await chat({ ...base, messages: [], fetchImpl: network })).toMatchObject({ ok: false, error: { code: 'NETWORK' } })

    const controller = new AbortController()
    controller.abort()
    const aborted = vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    expect(await chat({ ...base, messages: [], fetchImpl: aborted, signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'ABORTED' },
    })
  })

  it('reports a timeout', async () => {
    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')))
        }),
    )
    expect(await chat({ ...base, timeoutMs: 20, messages: [], fetchImpl: slow as never })).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT' },
    })
  })
})

describe('extractChatText', () => {
  it('returns null without content', () => {
    expect(extractChatText({})).toBeNull()
    expect(extractChatText({ choices: [{ message: { content: null } }] })).toBeNull()
  })
})

describe('inference endpoint hygiene (tech.md: never use /completion)', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sourceFiles(path)
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
  }

  it('uses the chat completions path', () => {
    expect(CHAT_COMPLETIONS_PATH).toBe('/v1/chat/completions')
  })

  it('has no reference to the /completion endpoint in production sources', () => {
    const root = join(import.meta.dirname, '..')
    const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const offenders = sourceFiles(root).filter((file) => /\/completion\b(?!s)/.test(withoutComments(readFileSync(file, 'utf8'))))
    expect(offenders).toEqual([])
  })
})
