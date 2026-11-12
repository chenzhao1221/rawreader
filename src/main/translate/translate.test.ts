import { describe, expect, it, vi } from 'vitest'
import { TranslateClient } from './client'
import type { TranslateClientOptions } from './client'
import {
  BASELINE_PROMPT_VERSION,
  CONTEXT_LIMITS,
  LMT_PROMPT_VERSION,
  buildBareMtPrompt,
  buildBaselinePrompt,
  buildContext,
  buildIndexPrompt,
  looksLikePromptEcho,
  maxTokensFor,
  normalizeOcrForPrompt,
  promptVersionFor,
  stripThinking,
  truncateUtf8,
  utf8ByteLength,
  zhLangName,
} from './prompts'

describe('prompt builders', () => {
  it('builds the Index-Translate standard prompt without context', () => {
    expect(buildIndexPrompt('Hello there', 'zh-Hans')).toBe(
      '请将以下文本翻译为简体中文，直接输出翻译结果，不要进行任何解释。\n\nHello there',
    )
  })

  it('builds the constrained layout when context is present', () => {
    const prompt = buildIndexPrompt('Run!', 'zh-Hans', ['Where is he?', 'Behind you'])
    expect(prompt).toContain('【源文】\nRun!')
    expect(prompt).toContain('【约束要求】')
    expect(prompt).toContain('Where is he? / Behind you')
    expect(prompt.endsWith('只输出译文，不要有任何额外说明。')).toBe(true)
  })

  it('builds the bare and baseline prompts', () => {
    expect(buildBareMtPrompt('Hi', 'zh-Hans')).toBe('请将以下文本翻译为简体中文，直接输出翻译结果，不要进行任何解释。\n\nHi')
    expect(buildBaselinePrompt('Hi')).toBe('请将以下文本翻译为简体中文，直接输出翻译结果，不要进行任何解释。\n\nHi')
  })

  it('names target languages in Chinese', () => {
    expect(zhLangName('zh-Hans')).toBe('简体中文')
    expect(zhLangName('Korean')).toBe('韩语')
    expect(zhLangName('Klingon')).toBe('Klingon')
    expect(zhLangName(null)).toBe('')
  })

  it('has distinct prompt versions per variant', () => {
    expect(promptVersionFor('lmt')).toBe(LMT_PROMPT_VERSION)
    expect(promptVersionFor('baseline')).toBe(BASELINE_PROMPT_VERSION)
    expect(LMT_PROMPT_VERSION).not.toBe(BASELINE_PROMPT_VERSION)
  })
})

describe('stripThinking', () => {
  it('keeps text after the last closing tag', () => {
    expect(stripThinking('<think>reasoning</think>\n你好')).toBe('你好')
    expect(stripThinking('a</think>b</think> c ')).toBe('c')
  })
  it('drops a dangling opening tag and trims', () => {
    expect(stripThinking('<think>你好 ')).toBe('你好')
    expect(stripThinking('  plain ')).toBe('plain')
  })
})

describe('maxTokensFor', () => {
  it('applies min(256, max(48, 3 * length))', () => {
    expect(maxTokensFor(1)).toBe(48)
    expect(maxTokensFor(16)).toBe(48)
    expect(maxTokensFor(30)).toBe(90)
    expect(maxTokensFor(85)).toBe(255)
    expect(maxTokensFor(86)).toBe(256)
    expect(maxTokensFor(5000)).toBe(256)
  })
})

describe('looksLikePromptEcho', () => {
  it('flags prompt scaffolding in the output', () => {
    expect(looksLikePromptEcho('【约束要求】\n1. ...', 'Hi')).toBe(true)
    expect(looksLikePromptEcho('【参考前文】abc', 'Hi')).toBe(true)
    expect(looksLikePromptEcho('请将以下文本翻译为简体中文', 'Hi')).toBe(true)
    expect(looksLikePromptEcho('只输出译文', 'Hi')).toBe(true)
  })

  it('flags output far longer than the source', () => {
    expect(looksLikePromptEcho('字'.repeat(70), 'Hi')).toBe(true)
    expect(looksLikePromptEcho('字'.repeat(30), 'Hi')).toBe(false)
  })

  it('accepts a normal translation', () => {
    expect(looksLikePromptEcho('你好，世界！', 'Hello, world!')).toBe(false)
  })
})

describe('normalizeOcrForPrompt', () => {
  it('rejoins hyphenated words and sentence-cases ALL CAPS', () => {
    expect(normalizeOcrForPrompt('RESIS- TIRME')).toBe('Resistirme')
    expect(normalizeOcrForPrompt('WHAT ARE YOU DOING? STOP IT!')).toBe('What are you doing? Stop it!')
  })
  it('leaves CJK and mixed case alone, collapses whitespace', () => {
    expect(normalizeOcrForPrompt('  안녕\n  하세요 ')).toBe('안녕 하세요')
    expect(normalizeOcrForPrompt('Hello World')).toBe('Hello World')
    expect(normalizeOcrForPrompt('   ')).toBe('')
  })
})

describe('context selection', () => {
  const sources = ['one', '', 'two', 'three', 'four']

  it('takes up to N previous non-empty bubbles in reading order', () => {
    expect(buildContext(sources, 4, 3)).toEqual(['one', 'two', 'three'])
    expect(buildContext(sources, 4, 2)).toEqual(['two', 'three'])
    expect(buildContext(sources, 0, 3)).toEqual([])
    expect(buildContext(sources, 4, 0)).toEqual([])
  })

  it('caps bytes per bubble and in total', () => {
    const long = 'あ'.repeat(200) // 600 bytes
    const [clipped] = buildContext([long, 'x'], 1, 3)
    expect(utf8ByteLength(clipped!)).toBeLessThanOrEqual(CONTEXT_LIMITS.unitBytes)
    const many = Array.from({ length: 10 }, () => 'あ'.repeat(80)) // 240 bytes each
    const ctx = buildContext(many, 10, 10)
    expect(ctx.reduce((n, s) => n + utf8ByteLength(s), 0)).toBeLessThanOrEqual(CONTEXT_LIMITS.totalBytes)
  })

  it('truncates by UTF-8 bytes without splitting code points', () => {
    expect(truncateUtf8('あいう', 6)).toBe('あい')
    expect(truncateUtf8('あいう', 5)).toBe('あ')
    expect(truncateUtf8('a😀b', 4)).toBe('a')
    expect(truncateUtf8('abc', 0)).toBe('')
  })
})

describe('TranslateClient', () => {
  function reply(text: string, status = 200) {
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status }),
    )
  }

  function setup(answers: Array<string | Error>, overrides: Partial<TranslateClientOptions> = {}) {
    const bodies: Array<Record<string, any>> = []
    let call = 0
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      const answer = answers[Math.min(call++, answers.length - 1)]!
      return answer instanceof Error ? Promise.reject(answer) : reply(answer)
    })
    const client = new TranslateClient({
      getPort: () => 18792,
      model: 'Index-Translate-2B',
      targetLang: 'zh-Hans',
      promptVariant: 'lmt',
      contextUnits: 3,
      fetchImpl: fetchImpl as never,
      ...overrides,
    })
    return { client, fetchImpl, bodies }
  }

  it('makes one chat request per bubble with temperature 0 and a capped max_tokens', async () => {
    const { client, bodies, fetchImpl } = setup(['你好'])
    const result = await client.translate({ sources: ['Hello'], index: 0 })
    expect(result).toMatchObject({ ok: true, translation: '你好', echo: false, retriedBare: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:18792/v1/chat/completions')
    expect(bodies[0]).toMatchObject({ temperature: 0, max_tokens: 48 })
    expect(bodies[0]!['messages']).toEqual([{ role: 'user', content: buildIndexPrompt('Hello', 'zh-Hans') }])
  })

  it('skips the request for empty input (empty in, empty out)', async () => {
    const { client, fetchImpl } = setup(['x'])
    expect(await client.translate({ sources: ['  ', 'Hi'], index: 0 })).toMatchObject({ ok: true, translation: '' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('strips think tags from the answer', async () => {
    const { client } = setup(['<think>hmm</think>你好'])
    expect(await client.translate({ sources: ['Hi'], index: 0 })).toMatchObject({ translation: '你好' })
  })

  it('sends previous bubbles of the same image as context', async () => {
    const { client, bodies } = setup(['好'])
    await client.translate({ sources: ['Where is he?', 'Behind you', 'Run!'], index: 2 })
    expect(bodies[0]!['messages'][0].content).toContain('Where is he? / Behind you')
  })

  it('sends no context when contextUnits is 0', async () => {
    const { client, bodies } = setup(['好'], { contextUnits: 0 })
    await client.translate({ sources: ['A', 'B'], index: 1 })
    expect(bodies[0]!['messages'][0].content).toBe(buildIndexPrompt('B', 'zh-Hans'))
  })

  it('retries once with the bare prompt after an echo', async () => {
    const { client, bodies } = setup(['【约束要求】\n1. ...', '你好'])
    const result = await client.translate({ sources: ['Hi', 'Hello'], index: 1 })
    expect(result).toMatchObject({ ok: true, translation: '你好', echo: false, retriedBare: true })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]!['messages'][0].content).toBe(buildBareMtPrompt('Hello', 'zh-Hans'))
  })

  it('leaves the bubble untranslated when the retry echoes too', async () => {
    const { client, fetchImpl } = setup(['请将以下文本翻译为简体中文'])
    const result = await client.translate({ sources: ['Hello'], index: 0 })
    expect(result).toMatchObject({ ok: true, translation: '', echo: true, retriedBare: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('uses the baseline prompt without context or echo guard', async () => {
    const { client, bodies, fetchImpl } = setup(['请将以下文本翻译为简体中文'], { promptVariant: 'baseline' })
    const result = await client.translate({ sources: ['A', 'Hello'], index: 1 })
    expect(bodies[0]!['messages'][0].content).toBe(buildBaselinePrompt('Hello'))
    expect(result).toMatchObject({ ok: true, echo: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('normalises OCR text before prompting', async () => {
    const { client, bodies } = setup(['好'])
    await client.translate({ sources: ['WHAT ARE YOU DOING?'], index: 0 })
    expect(bodies[0]!['messages'][0].content).toContain('What are you doing?')
  })

  it('retries a network error once and then reports it', async () => {
    const { client, fetchImpl } = setup([new TypeError('fetch failed')])
    expect(await client.translate({ sources: ['Hi'], index: 0 })).toMatchObject({ ok: false, error: { code: 'NETWORK' } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry HTTP errors', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('no', { status: 500 })))
    const client = new TranslateClient({
      getPort: () => 1,
      model: 'm',
      targetLang: 'zh-Hans',
      promptVariant: 'lmt',
      contextUnits: 3,
      fetchImpl: fetchImpl as never,
    })
    expect(await client.translate({ sources: ['Hi'], index: 0 })).toMatchObject({ ok: false, error: { code: 'HTTP_ERROR' } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
