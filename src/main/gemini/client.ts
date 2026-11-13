/**
 * Gemini "one-stop" mode: Gemini reads and translates the bubble crops itself, so no local OCR or
 * translation model is needed. All crops of an image go in one request, numbered in reading order,
 * and come back as JSON. The key is sent in a header, never in the URL (URLs end up in logs).
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const TIMEOUT_MS = 60_000
/** Most crops per request; an image with more is split. */
export const GEMINI_MAX_CROPS = 20

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface GeminiUnit {
  /** Text as Gemini read it ('' when the crop has no text). */
  source: string
  translation: string
}

export interface GeminiOptions {
  fetch: FetchLike
  getApiKey: () => string | null
  getModel: () => string
  /** Why a request gave nothing (HTTP status, bad JSON). Never receives the key. */
  onError?: (message: string) => void
}

/** Instruction sent with the crops. Exported for tests. */
export function geminiPrompt(count: number): string {
  return (
    `下面是同一页漫画里的 ${count} 个对白框截图，按阅读顺序编号 1 到 ${count}。` +
    '读出每张图里的原文，再翻译成自然、口语化的简体中文，像正规汉化组的译文。' +
    '同一页的对白要连起来理解，人称和语气前后一致；拟声词译成中文拟声词。' +
    '图里没有文字、或只有网址和水印时，原文和译文都留空。' +
    '只输出 JSON 数组，每项是 {"i": 编号, "source": 原文, "translation": 译文}，不要别的内容。'
  )
}

/** Reads Gemini's JSON answer. Returns null when it cannot be used; missing numbers stay null. Exported for tests. */
export function parseGeminiAnswer(body: string, count: number): (GeminiUnit | null)[] | null {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const text = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
  if (!text) return null
  let items: unknown
  try {
    items = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    return null
  }
  if (!Array.isArray(items)) return null
  const out: (GeminiUnit | null)[] = Array.from({ length: count }, () => null)
  for (const item of items) {
    const { i, source, translation } = (item ?? {}) as { i?: unknown; source?: unknown; translation?: unknown }
    if (typeof i !== 'number' || i < 1 || i > count || out[i - 1]) continue
    out[i - 1] = { source: typeof source === 'string' ? source.trim() : '', translation: typeof translation === 'string' ? translation.trim() : '' }
  }
  return out
}

export class GeminiClient {
  constructor(private readonly options: GeminiOptions) {}

  /** One entry per crop; null where Gemini gave nothing usable. Never throws for API errors. */
  async readAndTranslate(crops: readonly (Uint8Array | null)[], signal?: AbortSignal): Promise<(GeminiUnit | null)[]> {
    const out: (GeminiUnit | null)[] = crops.map((c) => (c === null ? { source: '', translation: '' } : null))
    const indexes = crops.flatMap((c, i) => (c !== null ? [i] : []))
    for (let start = 0; start < indexes.length; start += GEMINI_MAX_CROPS) {
      const chunk = indexes.slice(start, start + GEMINI_MAX_CROPS)
      const answers = await this.request(chunk.map((i) => crops[i] as Uint8Array), signal)
      chunk.forEach((cropIndex, k) => {
        out[cropIndex] = answers?.[k] ?? null
      })
    }
    return out
  }

  private async request(crops: readonly Uint8Array[], signal?: AbortSignal): Promise<(GeminiUnit | null)[] | null> {
    const key = this.options.getApiKey()
    if (!key) {
      this.options.onError?.('No Gemini API key set')
      return null
    }
    const parts: unknown[] = [{ text: geminiPrompt(crops.length) }]
    crops.forEach((png, i) => {
      parts.push({ text: `${i + 1}.` })
      parts.push({ inline_data: { mime_type: 'image/png', data: Buffer.from(png).toString('base64') } })
    })
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const model = encodeURIComponent(this.options.getModel())
    try {
      const response = await this.options.fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!response.ok) {
        const detail = await response.text().then((t) => t.slice(0, 200)).catch(() => '')
        this.options.onError?.(`Gemini HTTP ${response.status} ${detail}`.trim())
        return null
      }
      const parsed = parseGeminiAnswer(await response.text(), crops.length)
      if (!parsed) this.options.onError?.('Gemini answer was not the expected JSON')
      return parsed
    } catch (error) {
      if (!signal?.aborted) this.options.onError?.(`Gemini request failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}
