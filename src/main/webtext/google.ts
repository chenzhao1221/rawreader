/**
 * Web-page text translation through Google Translate's public web endpoint (the one the Chrome
 * translate bubble's free tier and many extensions use). Only text the page already shows is sent;
 * no cookies, no page URL. The endpoint is fixed here and never taken from a page.
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/t'
/** Google rejects very long bodies; stay well below its limit. */
const MAX_BATCH_CHARS = 4500
const MAX_BATCH_ITEMS = 128
const TIMEOUT_MS = 20_000

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface GoogleResult {
  translations: string[]
  /** Language Google detected for the first text ('' when unknown). */
  detected: string
}

/** Splits texts into request-sized batches, keeping order. A text longer than the limit gets a batch of its own. */
export function batchTexts(texts: readonly string[], maxChars = MAX_BATCH_CHARS, maxItems = MAX_BATCH_ITEMS): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const text of texts) {
    if (current.length > 0 && (size + text.length > maxChars || current.length >= maxItems)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(text)
    size += text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Reads the endpoint's answer. With several `q` values it is `[[translation, lang], ...]`;
 * with one it can be `[translation, lang]` or a bare string.
 */
export function parseResponse(body: string, count: number): GoogleResult {
  const data: unknown = JSON.parse(body)
  const rows: unknown[] = Array.isArray(data) ? (count === 1 && typeof data[0] === 'string' ? [data] : data) : [data]
  const translations: string[] = []
  let detected = ''
  for (const row of rows) {
    if (typeof row === 'string') translations.push(row)
    else if (Array.isArray(row) && typeof row[0] === 'string') {
      translations.push(row[0])
      if (!detected && typeof row[1] === 'string') detected = row[1]
    } else translations.push('')
  }
  if (translations.length !== count) throw new Error(`Google returned ${translations.length} items for ${count} texts`)
  return { translations, detected }
}

export class GoogleTranslator {
  constructor(private readonly fetchImpl: FetchLike) {}

  /** Translates to Simplified Chinese. Empty input gives empty output without a request. */
  async translate(texts: readonly string[], target = 'zh-CN'): Promise<GoogleResult> {
    const translations: string[] = []
    let detected = ''
    for (const batch of batchTexts(texts)) {
      const result = await this.request(batch, target)
      translations.push(...result.translations)
      if (!detected) detected = result.detected
    }
    return { translations, detected }
  }

  private async request(batch: readonly string[], target: string): Promise<GoogleResult> {
    const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: target })
    const body = batch.map((text) => `q=${encodeURIComponent(text)}`).join('&')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(`${ENDPOINT}?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`)
      return parseResponse(await response.text(), batch.length)
    } finally {
      clearTimeout(timer)
    }
  }
}
