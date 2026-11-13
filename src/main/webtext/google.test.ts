import { describe, expect, it, vi } from 'vitest'
import { batchTexts, GoogleTranslator, parseResponse } from './google'
import type { FetchLike } from './google'

/** A fetch double that answers with `body` and records the requests. */
function fakeFetch(body: string | ((batch: number) => string)) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const count = init.body.split('&').length
    const text = typeof body === 'function' ? body(count) : body
    return { ok: true, status: 200, text: async () => text }
  }
  return { impl, calls }
}

describe('batchTexts', () => {
  it('splits on the character limit and keeps order', () => {
    expect(batchTexts(['aaa', 'bbb', 'cc'], 5, 10)).toEqual([['aaa'], ['bbb', 'cc']])
  })

  it('splits on the item limit', () => {
    expect(batchTexts(['a', 'b', 'c'], 100, 2)).toEqual([['a', 'b'], ['c']])
  })

  it('gives a text longer than the limit a batch of its own', () => {
    expect(batchTexts(['a'.repeat(10), 'b', 'c'], 5, 10)).toEqual([['a'.repeat(10)], ['b', 'c']])
  })

  it('returns nothing for no texts', () => {
    expect(batchTexts([])).toEqual([])
  })
})

describe('parseResponse', () => {
  it('reads the several-text form', () => {
    expect(parseResponse('[["你好","en"],["世界","en"]]', 2)).toEqual({ translations: ['你好', '世界'], detected: 'en' })
  })

  it('reads the one-text form with and without a language', () => {
    expect(parseResponse('["你好","en"]', 1)).toEqual({ translations: ['你好'], detected: 'en' })
    expect(parseResponse('"你好"', 1)).toEqual({ translations: ['你好'], detected: '' })
  })

  it('keeps empty answers in place', () => {
    expect(parseResponse('[[null,"en"],["世界","en"]]', 2)).toEqual({ translations: ['', '世界'], detected: 'en' })
  })

  it('rejects an answer with the wrong number of items', () => {
    expect(() => parseResponse('[["你好","en"]]', 2)).toThrow(/1 items for 2 texts/)
  })
})

describe('GoogleTranslator', () => {
  it('sends every batch and joins the answers', async () => {
    const { impl, calls } = fakeFetch((count) => JSON.stringify(Array.from({ length: count }, (_, i) => [`译文${i}`, 'en'])))
    const translator = new GoogleTranslator(impl)
    const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`)
    const result = await translator.translate(texts)
    expect(result.translations).toHaveLength(130)
    expect(result.translations[0]).toBe('译文0')
    expect(result.detected).toBe('en')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.url).toContain('client=gtx')
    expect(calls[0]?.url).toContain('sl=auto')
    expect(calls[0]?.url).toContain('tl=zh-CN')
    expect(calls[0]?.init.body).toContain('q=text%200')
  })

  it('sends the requested target language', async () => {
    const { impl, calls } = fakeFetch('[["Hallo","en"]]')
    await new GoogleTranslator(impl).translate(['Hello'], 'de')
    expect(calls[0]?.url).toContain('tl=de')
  })

  it('makes no request for no texts', async () => {
    const { impl, calls } = fakeFetch('[]')
    expect(await new GoogleTranslator(impl).translate([])).toEqual({ translations: [], detected: '' })
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-OK answer', async () => {
    const impl: FetchLike = async () => ({ ok: false, status: 503, text: async () => '' })
    await expect(new GoogleTranslator(impl).translate(['Hello'])).rejects.toThrow('Google Translate HTTP 503')
  })
})
