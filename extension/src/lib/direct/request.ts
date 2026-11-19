// RawReader extension: direct API mode. Request construction and answer text extraction (pure).
// The API key only appears in the request headers of the object these functions return.
import { apiStyleOf, validateBaseUrl, type DirectApiSettings } from "./providers";

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

/** Request for an image (and the instruction), or for a text-only test when `image` is null. */
export function buildRequest(settings: DirectApiSettings, prompt: string, image: ApiImage | null): BuildResult {
  const base = validateBaseUrl(settings.baseUrl);
  if (!base.ok) return { ok: false, reason: base.reason };
  const model = settings.model.trim();
  if (!model) return { ok: false, reason: "请填写模型名。" };
  if (!settings.apiKey.trim()) return { ok: false, reason: "请填写 API Key。" };
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

  // OpenAI-compatible. No max_tokens: services differ in their limits (glm-4v-flash allows only 1024), so the
  // service default applies and the parser recovers items from a cut-off answer. One user message holds the
  // text and the image; some vision models reject a system role.
  const content: unknown[] = [{ type: "text", text: prompt }];
  if (image) content.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } });
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
      }),
    },
  };
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
