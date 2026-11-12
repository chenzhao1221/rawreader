import { LLAMA_HOST } from '../../shared/constants'

/** The only llama-server endpoint used for inference. `/completion` echoes the source for Index-Translate-2B. */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatRequest {
  port: number
  /** Server alias. llama-server serves a single model and ignores it, but it keeps logs readable. */
  model: string
  messages: ChatMessage[]
  maxTokens: number
  temperature: number
  signal?: AbortSignal
  timeoutMs: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

export type ChatErrorCode = 'ABORTED' | 'TIMEOUT' | 'NETWORK' | 'HTTP_ERROR' | 'BAD_RESPONSE'

export type ChatResult =
  | { ok: true; text: string; finishReason: string | null }
  | { ok: false; error: { code: ChatErrorCode; message: string } }

interface ChatCompletionBody {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> | null }
    finish_reason?: string | null
  }>
}

/** Extracts the assistant text from `choices[0].message.content` (string or text parts). */
export function extractChatText(body: unknown): { text: string; finishReason: string | null } | null {
  const choice = (body as ChatCompletionBody | null)?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return { text: content, finishReason: choice?.finish_reason ?? null }
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part.type === 'text' || part.type === undefined)
      .map((part) => part.text ?? '')
      .join('')
    return { text, finishReason: choice?.finish_reason ?? null }
  }
  return null
}

/** Posts one chat completion to a local llama-server. Never throws. */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  const doFetch = request.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout

  let response: Response
  try {
    response = await doFetch(`http://${LLAMA_HOST}:${request.port}${CHAT_COMPLETIONS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: false,
      }),
      signal,
    })
  } catch (error) {
    if (request.signal?.aborted) return { ok: false, error: { code: 'ABORTED', message: 'Request was cancelled' } }
    if (timeout.aborted) return { ok: false, error: { code: 'TIMEOUT', message: `No answer within ${request.timeoutMs} ms` } }
    return { ok: false, error: { code: 'NETWORK', message: error instanceof Error ? error.message : String(error) } }
  }

  if (!response.ok) {
    const detail = await response.text().then((t) => t.slice(0, 200)).catch(() => '')
    return { ok: false, error: { code: 'HTTP_ERROR', message: `HTTP ${response.status} ${detail}`.trim() } }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (request.signal?.aborted) return { ok: false, error: { code: 'ABORTED', message: 'Request was cancelled' } }
    if (timeout.aborted) return { ok: false, error: { code: 'TIMEOUT', message: `No answer within ${request.timeoutMs} ms` } }
    return { ok: false, error: { code: 'BAD_RESPONSE', message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` } }
  }
  const extracted = extractChatText(body)
  if (extracted === null) return { ok: false, error: { code: 'BAD_RESPONSE', message: 'Response has no message content' } }
  return { ok: true, text: extracted.text, finishReason: extracted.finishReason }
}
