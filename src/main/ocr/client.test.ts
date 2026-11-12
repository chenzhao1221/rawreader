import { describe, expect, it, vi } from 'vitest'
import { OCR_PROMPT, OcrClient, cleanOcrOutput, pngDataUrl } from './client'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const ok = (text: string) =>
  Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 }))

describe('OcrClient', () => {
  it('sends one image_url part plus "OCR:" at temperature 0', async () => {
    const fetchImpl = vi.fn(() => ok('  안녕하세요  '))
    const client = new OcrClient({ getPort: () => 18791, model: 'PaddleOCR-VL-1.5', fetchImpl })
    expect(await client.recognize(PNG)).toEqual({ ok: true, text: '안녕하세요' })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:18791/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.temperature).toBe(0)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` } },
      { type: 'text', text: OCR_PROMPT },
    ])
    expect(OCR_PROMPT).toBe('OCR:')
  })

  it('treats empty output as a successful "no text"', async () => {
    const client = new OcrClient({ getPort: () => 1, model: 'm', fetchImpl: vi.fn(() => ok('   ')) })
    expect(await client.recognize(PNG)).toEqual({ ok: true, text: '' })
  })

  it('retries once and then reports the error', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('busy', { status: 503 })))
    const client = new OcrClient({ getPort: () => 1, model: 'm', fetchImpl })
    expect(await client.recognize(PNG)).toMatchObject({ ok: false, error: { code: 'HTTP_ERROR' } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('succeeds on the retry', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')))
      .mockImplementationOnce(() => ok('text'))
    const client = new OcrClient({ getPort: () => 1, model: 'm', fetchImpl })
    expect(await client.recognize(PNG)).toEqual({ ok: true, text: 'text' })
  })

  it('does not retry a cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(() => ok('x'))
    const client = new OcrClient({ getPort: () => 1, model: 'm', fetchImpl })
    expect(await client.recognize(PNG, controller.signal)).toMatchObject({ ok: false, error: { code: 'ABORTED' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the port at call time', async () => {
    let port = 18791
    const fetchImpl = vi.fn(() => ok('a'))
    const client = new OcrClient({ getPort: () => port, model: 'm', fetchImpl })
    port = 19000
    await client.recognize(PNG)
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(':19000/')
  })
})

describe('cleanOcrOutput and pngDataUrl', () => {
  it('removes layout tokens and tidies whitespace', () => {
    expect(cleanOcrOutput('<|LOC_1|> hello   world \n\n  next <|/LOC|>')).toBe('hello world\nnext')
  })

  it('builds a base64 PNG data URL', () => {
    expect(pngDataUrl(Uint8Array.from([1, 2, 3]))).toBe('data:image/png;base64,AQID')
  })
})
