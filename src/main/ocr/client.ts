import { chat } from '../llm/chat'
import type { ChatResult } from '../llm/chat'

/** PaddleOCR-VL task prompt. */
export const OCR_PROMPT = 'OCR:'

const OCR_TIMEOUT_MS = 30_000
/** A bubble holds a few sentences; the cap stops a runaway repetition loop. */
const OCR_MAX_TOKENS = 512

export interface OcrClientOptions {
  /** Port of llama-server #1. Read per call so a free-port fallback is honoured. */
  getPort: () => number
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type OcrResult =
  | { ok: true; text: string }
  | { ok: false; error: { code: string; message: string } }

/** Removes layout tokens some OCR-VL builds emit and collapses whitespace. */
export function cleanOcrOutput(raw: string): string {
  return raw
    .replace(/<\|[^|>]*\|>/g, ' ')
    .replace(/\u0000/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** Data URL for an image crop. */
export function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64')}`
}

/**
 * OCR client for llama-server #1 (PaddleOCR-VL-1.5). One request per crop:
 * one `image_url` part plus the text `OCR:`, temperature 0, 30 s timeout and a
 * single retry (R7.2, R7.4). Empty output is a successful "no text".
 */
export class OcrClient {
  constructor(private readonly options: OcrClientOptions) {}

  async recognize(png: Uint8Array, signal?: AbortSignal): Promise<OcrResult> {
    let last: ChatResult | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) return { ok: false, error: { code: 'ABORTED', message: 'Request was cancelled' } }
      last = await chat({
        port: this.options.getPort(),
        model: this.options.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: pngDataUrl(png) } },
              { type: 'text', text: OCR_PROMPT },
            ],
          },
        ],
        maxTokens: OCR_MAX_TOKENS,
        temperature: 0,
        timeoutMs: this.options.timeoutMs ?? OCR_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      })
      if (last.ok) return { ok: true, text: cleanOcrOutput(last.text) }
      if (last.error.code === 'ABORTED') break
    }
    return { ok: false, error: last && !last.ok ? last.error : { code: 'UNKNOWN', message: 'OCR failed' } }
  }
}
