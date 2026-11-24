// RawReader extension: direct API mode. Request construction and answer text extraction (pure).
// The API key only appears in the request headers of the object these functions return.
import { apiStyleOf, validateBaseUrl, type DirectApiSettings, type ProviderId } from "./providers";

export interface ApiImage {
  /** MIME type of `base64`, for example "image/jpeg". */
  mime: string;
  base64: string;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Gemini 2.5 counts its thinking tokens against this limit. */
export const GEMINI_MAX_OUTPUT_TOKENS = 8192;

export type BuildResult = { ok: true; request: BuiltRequest } | { ok: false; reason: string };

/** Request for an image (and the instruction), or for a text-only test when `image` is null. `maxTokens` overrides the saved limit (used when a service refuses it). */
export function buildRequest(settings: DirectApiSettings, prompt: string, image: ApiImage | null, maxTokens?: number): BuildResult {
  const base = validateBaseUrl(settings.baseUrl);
  if (!base.ok) return { ok: false, reason: base.reason };
  const model = settings.model.trim();
  if (!model) return { ok: false, reason: "请填写模型名。" };
  if (!settings.apiKey.trim()) return { ok: false, reason: "请填写 API 密钥。" };
  const key = settings.apiKey.trim();

  if (apiStyleOf(settings) === "gemini") {
    const parts: unknown[] = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
    return {
      ok: true,
      request: {
        // The key goes in a header, never in the URL, so it cannot end up in a logged address.
        url: `${base.url}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            ...(image ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    };
  }

  // OpenAI-compatible. One user message holds the text and the image; some vision models reject a system role.
  const content: unknown[] = [{ type: "text", text: prompt }];
  if (image) content.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } });
  const limit = effectiveMaxTokens(model, maxTokens ?? settings.maxTokens);
  return {
    ok: true,
    request: {
      url: `${base.url}/chat/completions`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.2,
        stream: false,
        max_tokens: limit,
        ...thinkingFieldsFor(settings.provider, settings.disableThinking),
      }),
    },
  };
}

/** Output limit for a model: glm-4v-flash accepts at most 1024 tokens, so a larger request would be refused. */
export function effectiveMaxTokens(model: string, requested: number): number {
  const cap = model.trim().toLowerCase() === "glm-4v-flash" ? 1024 : Number.POSITIVE_INFINITY;
  return Math.min(requested, cap);
}

/** Extra body fields that switch thinking off, for the services that have such a switch. Others get none. */
export function thinkingFieldsFor(provider: ProviderId, disableThinking: boolean): Record<string, unknown> {
  if (!disableThinking) return {};
  if (provider === "zhipu") return { thinking: { type: "disabled" } };
  if (provider === "dashscope") return { enable_thinking: false };
  return {};
}

/** True when a failed response says the output limit is too large (HTTP 400 that names max_tokens). */
export function isMaxTokensError(status: number, detail: string): boolean {
  return status === 400 && /max_tokens/i.test(detail);
}

/** True when the service stopped the answer at the output limit. */
export function answerTruncated(settings: Pick<DirectApiSettings, "provider">, body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (apiStyleOf(settings) === "gemini") {
    const candidates = body["candidates"];
    const first = Array.isArray(candidates) ? candidates[0] : undefined;
    return isRecord(first) && first["finishReason"] === "MAX_TOKENS";
  }
  const choices = body["choices"];
  const first = Array.isArray(choices) ? choices[0] : undefined;
  return isRecord(first) && first["finish_reason"] === "length";
}


const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The model's answer text from a parsed response body, or "" when there is none. */
export function extractAnswerText(settings: Pick<DirectApiSettings, "provider">, body: unknown): string {
  if (!isRecord(body)) return "";
  if (apiStyleOf(settings) === "gemini") {
    const candidates = body["candidates"];
    const first = Array.isArray(candidates) ? candidates[0] : undefined;
    const content = isRecord(first) ? first["content"] : undefined;
    const parts = isRecord(content) ? content["parts"] : undefined;
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p): p is Record<string, unknown> => isRecord(p) && p["thought"] !== true && typeof p["text"] === "string")
      .map((p) => p["text"] as string)
      .join("");
  }
  const choices = body["choices"];
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first["message"] : undefined;
  const content = isRecord(message) ? message["content"] : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : isRecord(p) && typeof p["text"] === "string" ? p["text"] : ""))
      .join("");
  }
  return "";
}

/** The service's own error text from an error body (`{error:{message}}`, `{error:"..."}` or `{message}`), or "". */
export function extractErrorText(body: unknown): string {
  if (!isRecord(body)) return "";
  const error = body["error"];
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  return typeof body["message"] === "string" ? body["message"] : "";
}
