import { describe, expect, it, vi } from 'vitest'
import { GEMINI_MAX_CROPS, GeminiClient, geminiPrompt, parseGeminiAnswer } from './client'
import type { FetchLike } from './client'

/** Wraps an answer text the way the Gemini endpoint does. */
function envelope(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })
}

function answer(items: unknown): string {
  return envelope(JSON.stringify(items))
}

type FetchCall = Parameters<FetchLike>

function recordingFetch(respond: (call: number, body: string) => { ok?: boolean; status?: number; text: string }) {
  const calls: FetchCall[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push([url, init])
    const reply = respond(calls.length, init.body)
    return { ok: reply.ok ?? true, status: reply.status ?? 200, text: async () => reply.text }
  }
  return { calls, fetchFn }
}

describe('parseGeminiAnswer', () => {
  it('reads a normal JSON answer', () => {
    const body = answer([{ i: 1, source: '내', translation: '我' }])

    expect(parseGeminiAnswer(body, 1)).toEqual([{ source: '내', translation: '我' }])
  })

  it('reads the array even when it is wrapped in a json code block', () => {
    const body = envelope('```json\n[{"i":1,"source":"Hi","translation":"嗨"}]\n```')

    expect(parseGeminiAnswer(body, 1)).toEqual([{ source: 'Hi', translation: '嗨' }])
  })

  it('ignores out-of-range and duplicate numbers, keeping the first duplicate', () => {
    const body = answer([
      { i: 0, source: 'zero', translation: '零' },
      { i: 4, source: 'four', translation: '四' },
      { i: 2, source: 'first', translation: '一' },
      { i: 2, source: 'second', translation: '二' },
      { i: 3, source: 'three', translation: '三' },
    ])

    expect(parseGeminiAnswer(body, 3)).toEqual([null, { source: 'first', translation: '一' }, { source: 'three', translation: '三' }])
  })

  it('leaves missing numbers null', () => {
    const body = answer([{ i: 2, source: 'B', translation: '乙' }])

    expect(parseGeminiAnswer(body, 3)).toEqual([null, { source: 'B', translation: '乙' }, null])
  })

  it('returns null when the body or the answer is not JSON', () => {
    expect(parseGeminiAnswer('not json', 1)).toBeNull()
    expect(parseGeminiAnswer(envelope('not json'), 1)).toBeNull()
  })

  it('returns null when the answer is not an array', () => {
    expect(parseGeminiAnswer(envelope('{"i":1}'), 1)).toBeNull()
    expect(parseGeminiAnswer(JSON.stringify({}), 1)).toBeNull()
  })
})

describe('GeminiClient.readAndTranslate', () => {
  it('posts the crops to the model URL with the key in a header and numbered images', async () => {
    const crops = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])]
    const { calls, fetchFn } = recordingFetch(() =>
      ({ text: answer([{ i: 1, source: 'a', translation: 'A' }, { i: 2, source: 'b', translation: 'B' }]) }),
    )
    const client = new GeminiClient({ fetch: fetchFn, getApiKey: () => 'secret-key', getModel: () => 'gemini-2.5-flash' })

    const out = await client.readAndTranslate(crops)

    expect(out).toEqual([{ source: 'a', translation: 'A' }, { source: 'b', translation: 'B' }])
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]!
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(url).not.toContain('secret-key')
    expect(init.headers['x-goog-api-key']).toBe('secret-key')
    const parts = JSON.parse(init.body).contents[0].parts as Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>
    expect(parts[0]?.text).toBe(geminiPrompt(2))
    expect(parts[1]?.text).toBe('1.')
    expect(parts[2]?.inline_data).toEqual({ mime_type: 'image/png', data: Buffer.from(crops[0]!).toString('base64') })
    expect(parts[3]?.text).toBe('2.')
    expect(parts[4]?.inline_data).toEqual({ mime_type: 'image/png', data: Buffer.from(crops[1]!).toString('base64') })
  })

  it('answers empty text for absent crops without sending them', async () => {
    const { calls, fetchFn } = recordingFetch(() => ({ text: answer([{ i: 1, source: 'a', translation: 'A' }]) }))
    const client = new GeminiClient({ fetch: fetchFn, getApiKey: () => 'secret-key', getModel: () => 'gemini-2.5-flash' })

    const out = await client.readAndTranslate([null, Uint8Array.from([9]), null])

    expect(out).toEqual([{ source: '', translation: '' }, { source: 'a', translation: 'A' }, { source: '', translation: '' }])
    const parts = JSON.parse(calls[0]![1].body).contents[0].parts as unknown[]
    expect(parts).toHaveLength(3)
  })

  it('splits more than the maximum crops into several requests, keeping the order', async () => {
    const { calls, fetchFn } = recordingFetch((call, body) => {
      const parts = JSON.parse(body).contents[0].parts as Array<{ inline_data?: unknown }>
      const count = parts.filter((part) => part.inline_data).length
      const items = Array.from({ length: count }, (_, i) => ({ i: i + 1, source: `c${call}-${i + 1}`, translation: `t${call}-${i + 1}` }))
      return { text: answer(items) }
    })
    const client = new GeminiClient({ fetch: fetchFn, getApiKey: () => 'secret-key', getModel: () => 'm' })
    const crops = Array.from({ length: GEMINI_MAX_CROPS + 1 }, (_, i) => Uint8Array.from([i + 1]))

    const out = await client.readAndTranslate(crops)

    expect(calls).toHaveLength(2)
    expect(out).toHaveLength(GEMINI_MAX_CROPS + 1)
    expect(out[0]).toEqual({ source: 'c1-1', translation: 't1-1' })
    expect(out[GEMINI_MAX_CROPS - 1]).toEqual({ source: `c1-${GEMINI_MAX_CROPS}`, translation: `t1-${GEMINI_MAX_CROPS}` })
    expect(out[GEMINI_MAX_CROPS]).toEqual({ source: 'c2-1', translation: 't2-1' })
  })

  it('sends nothing and reports an error without a key', async () => {
    const onError = vi.fn()
    const { calls, fetchFn } = recordingFetch(() => ({ text: answer([]) }))
    const client = new GeminiClient({ fetch: fetchFn, getApiKey: () => null, getModel: () => 'm', onError })

    const out = await client.readAndTranslate([Uint8Array.from([1]), Uint8Array.from([2])])

    expect(calls).toHaveLength(0)
    expect(out).toEqual([null, null])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('key'))
  })

  it('reports the HTTP status and answers null on an error response', async () => {
    const onError = vi.fn()
    const { fetchFn } = recordingFetch(() => ({ ok: false, status: 403, text: 'forbidden' }))
    const client = new GeminiClient({ fetch: fetchFn, getApiKey: () => 'secret-key', getModel: () => 'm', onError })

    const out = await client.readAndTranslate([Uint8Array.from([1])])

    expect(out).toEqual([null])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('403'))
  })
})
