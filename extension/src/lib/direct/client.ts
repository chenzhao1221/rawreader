// RawReader extension: direct API mode. One request to a vision model does detection, reading and translation.
// The result has the same shape as the app bridge answer, so BridgeMemo and the overlay need no changes.
// Network access goes through `fetchImpl` so tests never reach a real API.
import { bytesToBase64, type FetchLike } from "../bridge/client";
import type { BridgeBox, BridgeContext, BridgeTranslateReply, BridgeUnit } from "../bridge/protocol";
import { codeForStatus, scrubMessage, type DirectFailure } from "./errors";
import { ImageTooLargeError, prepareImage, type ImageCodec } from "./image";
import { parseModelOutput } from "./parse";
import { buildPrompt, TEST_PROMPT, type NormBox } from "./prompt";
import type { DirectApiSettings } from "./providers";
import { buildRequest, extractAnswerText, extractErrorText, type ApiImage } from "./request";

/** One API round trip, queue wait included. */
export const DIRECT_TIMEOUT_MS = 120_000;

export interface DirectDeps {
  fetchImpl?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface DirectTranslateParams extends DirectDeps {
  bytes: Uint8Array;
  codec: ImageCodec;
  /** Language name as stored in `sync:target-lang`. */
  targetLang: string;
  context?: BridgeContext | undefined;
  /** Regions in pixels of the original image (the user drew or edited them). */
  boxes?: BridgeBox[] | undefined;
  now?: (() => number) | undefined;
}

type ApiResult = { text: string } | { error: DirectFailure };

/** Sends one request and returns the model's answer text. Never throws. */
async function callApi(settings: DirectApiSettings, prompt: string, image: ApiImage | null, deps: DirectDeps): Promise<ApiResult> {
  const built = buildRequest(settings, prompt, image);
  if (!built.ok) return { error: { code: "direct-config", message: built.reason } };
  const { request } = built;
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const signals = [AbortSignal.timeout(deps.timeoutMs ?? DIRECT_TIMEOUT_MS)];
  if (deps.signal) signals.push(deps.signal);

  let res: Response;
  try {
    res = await doFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      credentials: "omit",
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (deps.signal?.aborted) return { error: { code: "timeout", message: "Cancelled" } };
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { error: { code: "direct-timeout", message: "The request timed out" } };
    return { error: { code: "direct-network", message: "Cannot reach the API" } };
  }

  let text = "";
  try {
    text = await res.text();
  } catch {
    // An unreadable body is treated like an empty one.
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const detail = extractErrorText(body) || text;
    return { error: { code: codeForStatus(res.status), message: scrubMessage(`HTTP ${res.status} ${detail}`, settings.apiKey) } };
  }
  const answer = extractAnswerText(settings, body);
  if (!answer.trim()) return { error: { code: "direct-empty-response", message: "The model returned no text" } };
  return { text: answer };
}

const toUnit = (box: NormBox, width: number, height: number, source: string, translation: string): BridgeUnit => {
  const draw: BridgeBox = {
    x1: Math.round(box.x1 * width),
    y1: Math.round(box.y1 * height),
    x2: Math.round(box.x2 * width),
    y2: Math.round(box.y2 * height),
    confidence: 1,
  };
  return {
    kind: "bubble",
    bubbleOnly: false,
    drawBox: draw,
    ocrBox: { ...draw },
    ocrText: source,
    translation,
    status: translation.length > 0 ? "ok" : "no-text",
  };
};

/** Detects, reads and translates one image with a vision model. Failures come back as `{ error }`. */
export async function translateDirect(settings: DirectApiSettings, params: DirectTranslateParams): Promise<BridgeTranslateReply> {
  const now = params.now ?? (() => performance.now());
  const started = now();

  let prepared;
  try {
    prepared = await prepareImage(params.bytes, params.codec);
  } catch (error) {
    if (error instanceof ImageTooLargeError) return { error: { code: "direct-image-too-large", message: error.message } };
    return { error: { code: "direct-image", message: scrubMessage((error as Error)?.message ?? "Cannot decode the image", settings.apiKey) } };
  }

  const { originalWidth: w, originalHeight: h } = prepared;
  const regions: NormBox[] | undefined = params.boxes?.length
    ? params.boxes.map((b) => ({
        x1: Math.max(0, Math.min(1, b.x1 / w)),
        y1: Math.max(0, Math.min(1, b.y1 / h)),
        x2: Math.max(0, Math.min(1, b.x2 / w)),
        y2: Math.max(0, Math.min(1, b.y2 / h)),
      }))
    : undefined;

  const prompt = buildPrompt({
    targetLang: params.targetLang,
    width: prepared.width,
    height: prepared.height,
    context: params.context,
    regions,
  });
  const answer = await callApi(settings, prompt, { mime: prepared.mime, base64: bytesToBase64(prepared.bytes) }, params);
  if ("error" in answer) return { error: answer.error };

  const parsed = parseModelOutput(answer.text, { width: prepared.width, height: prepared.height, regions });
  const units = parsed.units.map((u) => toUnit(u.box, w, h, u.source, u.translation));
  return {
    result: {
      v: 1,
      hash: "",
      width: w,
      height: h,
      cached: false,
      units,
      timings: { detectMs: 0, ocrMs: 0, translateMs: Math.round(now() - started) },
    },
  };
}

/** "Test connection": a text-only request, so it costs almost nothing. */
export async function testDirect(settings: DirectApiSettings, deps: DirectDeps = {}): Promise<{ ok: true } | { error: DirectFailure }> {
  const answer = await callApi(settings, TEST_PROMPT, null, { ...deps, timeoutMs: deps.timeoutMs ?? 30_000 });
  return "error" in answer ? { error: answer.error } : { ok: true };
}
