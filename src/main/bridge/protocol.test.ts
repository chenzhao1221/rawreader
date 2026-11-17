import { describe, expect, it } from 'vitest'
import type { TranslateBytesResult } from '../pipeline/scheduler'
import { normalizeContext } from './context'
import { PingResponseSchema, TranslateRequestSchema, TranslateResponseSchema, toBridgeResult } from './protocol'

const image = 'iVBORw0KGgoAAAANSUhEUg=='
const box = { x1: 1, y1: 2, x2: 30, y2: 40 }

describe('TranslateRequestSchema', () => {
  it('accepts the minimal request and fills the box confidence', () => {
    expect(TranslateRequestSchema.parse({ v: 1, image })).toEqual({ v: 1, image })
    expect(TranslateRequestSchema.parse({ v: 1, image, boxes: [box] }).boxes?.[0]?.confidence).toBe(1)
  })

  it.each([
    ['unknown field', { v: 1, image, extra: true }],
    ['wrong version', { v: 2, image }],
    ['no image', { v: 1 }],
    ['short image', { v: 1, image: 'abc' }],
    ['non-numeric priority', { v: 1, image, priority: 'high' }],
    ['unknown context field', { v: 1, image, context: { glossary: 'x' } }],
    ['inverted box', { v: 1, image, boxes: [{ x1: 30, y1: 2, x2: 1, y2: 40 }] }],
    ['box with extra field', { v: 1, image, boxes: [{ ...box, kind: 'bubble' }] }],
    ['empty boxes', { v: 1, image, boxes: [] }],
    ['too many boxes', { v: 1, image, boxes: Array.from({ length: 61 }, () => box) }],
  ])('rejects %s', (_name, body) => {
    expect(TranslateRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('toBridgeResult', () => {
  const result: TranslateBytesResult = {
    hash: 'f'.repeat(64),
    width: 800,
    height: 1200,
    cached: true,
    captureSource: 'bridge',
    timings: { captureMs: 0, detectMs: 10.4, ocrMs: 20.6, translateMs: 30 },
    units: [
      {
        kind: 'bubble',
        bubbleOnly: false,
        drawBox: { x1: 1, y1: 2, x2: 3, y2: 4, confidence: 0.9 },
        ocrBox: { x1: 1, y1: 2, x2: 3, y2: 4, confidence: 0.8 },
        ocrText: 'こんにちは',
        translation: '你好',
        status: 'ok',
      },
    ],
  }

  it('maps a pipeline result to a response that matches the response schema and leaks nothing else', () => {
    const out = toBridgeResult(result)
    expect(TranslateResponseSchema.parse(out)).toEqual(out)
    expect(out.timings).toEqual({ detectMs: 10, ocrMs: 21, translateMs: 30 })
    expect(out.cached).toBe(true)
    expect(JSON.stringify(out)).not.toContain('captureSource')
  })
})

describe('PingResponseSchema', () => {
  it('accepts ready and not-ready answers and nothing extra', () => {
    expect(PingResponseSchema.safeParse({ v: 1, app: 'App', version: '1', ready: true, engine: 'local' }).success).toBe(true)
    expect(
      PingResponseSchema.safeParse({ v: 1, app: 'App', version: '1', ready: false, engine: 'gemini', reason: { code: 'API_KEY_MISSING', message: 'm' } }).success,
    ).toBe(true)
    expect(PingResponseSchema.safeParse({ v: 1, app: 'App', version: '1', ready: true, engine: 'local', path: 'C:\\x' }).success).toBe(false)
  })
})

describe('normalizeContext', () => {
  it('returns undefined for no or empty context, so such requests share the desktop cache', () => {
    expect(normalizeContext(undefined)).toBeUndefined()
    expect(normalizeContext({})).toBeUndefined()
    expect(normalizeContext({ seriesName: '  ', summary: '' })).toBeUndefined()
  })

  it('builds prompt lines and a stable hash that changes with the content', () => {
    const a = normalizeContext({ seriesName: 'Series', summary: 'A story', dictionary: 'a = b\nc = d' })
    expect(a?.background).toHaveLength(3)
    expect(a?.background[2]).toContain('a = b；c = d')
    expect(normalizeContext({ seriesName: 'Series', summary: 'A story', dictionary: 'a = b\nc = d' })?.hash).toBe(a?.hash)
    expect(normalizeContext({ seriesName: 'Series', summary: 'Another', dictionary: 'a = b\nc = d' })?.hash).not.toBe(a?.hash)
  })

  it('caps each part in UTF-8 bytes', () => {
    const big = normalizeContext({ summary: '字'.repeat(5000) })
    // 2000 bytes = 666 three-byte characters.
    expect(big?.background[0]).toBe(`剧情：${'字'.repeat(666)}`)
  })
})
