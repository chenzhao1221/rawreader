import { chat } from '../llm/chat'
import type { ChatResult } from '../llm/chat'
import {
  BATCH_MAX_ITEMS,
  buildBareMtPrompt,
  buildBaselinePrompt,
  buildBatchPrompt,
  buildContext,
  buildIndexPrompt,
  looksLikePromptEcho,
  maxTokensFor,
  maxTokensForBatch,
  normalizeOcrForPrompt,
  parseBatchOutput,
  stripThinking,
} from './prompts'
import type { PromptVariant } from './prompts'

const TRANSLATE_TIMEOUT_MS = 30_000

export interface TranslateClientOptions {
  /** Port of llama-server #2. Read per call so a free-port fallback is honoured. */
  getPort: () => number
  model: string
  targetLang: string
  promptVariant: PromptVariant
  /** How many previous bubbles of the same image go in as context (0 = none). */
  contextUnits: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface TranslateRequest {
  /** OCR text of every unit on the image, in reading order (raw, not normalised). */
  sources: readonly string[]
  /** Index of the unit to translate. */
  index: number
  signal?: AbortSignal
}

export type TranslateResult =
  | {
      ok: true
      translation: string
      /** True when the model echoed its prompt even after the bare retry; the unit stays untranslated. */
      echo: boolean
      /** True when the first answer was an echo and the bare retry was used. */
      retriedBare: boolean
      /** The prompt that produced the answer (for logs and the smoke run). */
      prompt: string
    }
  | { ok: false; error: { code: string; message: string } }

/**
 * Translation client for llama-server #2 (Index-Translate-2B). One
 * `/v1/chat/completions` request per bubble (R8.1); the caller bounds how many
 * run in parallel. Empty input gives empty output without a request (R8.6).
 */
export class TranslateClient {
  constructor(private readonly options: TranslateClientOptions) {}

  async translate(request: TranslateRequest): Promise<TranslateResult> {
    const { options } = this
    const sources = request.sources.map((s) => normalizeOcrForPrompt(s ?? ''))
    const source = sources[request.index] ?? ''
    if (source.length === 0) return { ok: true, translation: '', echo: false, retriedBare: false, prompt: '' }

    const lmt = options.promptVariant === 'lmt'
    const prompt = lmt
      ? buildIndexPrompt(source, options.targetLang, buildContext(sources, request.index, options.contextUnits))
      : buildBaselinePrompt(source, options.targetLang)

    const first = await this.ask(prompt, source, request.signal)
    if (!first.ok) return first
    if (!lmt || !looksLikePromptEcho(first.text, source)) {
      return { ok: true, translation: first.text, echo: false, retriedBare: false, prompt }
    }

    // Echo guard: one retry with the bare prompt, then leave the bubble untranslated.
    const barePrompt = buildBareMtPrompt(source, options.targetLang)
    const retry = await this.ask(barePrompt, source, request.signal)
    if (!retry.ok) return retry
    if (looksLikePromptEcho(retry.text, source)) {
      return { ok: true, translation: '', echo: true, retriedBare: true, prompt: barePrompt }
    }
    return { ok: true, translation: retry.text, echo: false, retriedBare: true, prompt: barePrompt }
  }

  /**
   * Translates every bubble of an image in numbered batches. Returns one entry per source: the
   * translation, '' for an empty source, or null where the batch answer could not be used (the caller
   * then translates that bubble on its own). Transport errors also give nulls, never a throw.
   */
  async translateBatch(rawSources: readonly string[], signal?: AbortSignal): Promise<(string | null)[]> {
    const sources = rawSources.map((s) => normalizeOcrForPrompt(s ?? ''))
    const out: (string | null)[] = sources.map((s) => (s.length === 0 ? '' : null))
    const indexes = sources.flatMap((s, i) => (s.length > 0 ? [i] : []))
    for (let start = 0; start < indexes.length; start += BATCH_MAX_ITEMS) {
      const chunk = indexes.slice(start, start + BATCH_MAX_ITEMS)
      const texts = chunk.map((i) => sources[i] as string)
      // A single bubble gains nothing from the batch format.
      if (texts.length < 2) continue
      const answer = await this.ask(
        buildBatchPrompt(texts, this.options.targetLang),
        texts.join(''),
        signal,
        maxTokensForBatch(texts.map((t) => t.length)),
      )
      if (!answer.ok) continue
      const lines = parseBatchOutput(answer.text, texts.length)
      if (!lines) continue
      chunk.forEach((sourceIndex, k) => {
        const line = lines[k] as string
        if (!looksLikePromptEcho(line, texts[k] as string)) out[sourceIndex] = line
      })
    }
    return out
  }

  private async ask(
    prompt: string,
    source: string,
    signal: AbortSignal | undefined,
    maxTokens: number = maxTokensFor(source.length),
  ): Promise<{ ok: true; text: string } | { ok: false; error: { code: string; message: string } }> {
    const { options } = this
    let result: ChatResult | null = null
    // One retry for transport errors only (a server that is still warming up).
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await chat({
        port: options.getPort(),
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature: 0,
        timeoutMs: options.timeoutMs ?? TRANSLATE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
      if (result.ok) return { ok: true, text: stripThinking(result.text) }
      if (result.error.code !== 'NETWORK') break
    }
    return { ok: false, error: result && !result.ok ? result.error : { code: 'UNKNOWN', message: 'Translation failed' } }
  }
}
