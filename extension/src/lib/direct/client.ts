// RawReader extension: direct API mode. One request to a vision model does detection, reading and translation.
// The result has the same shape as the app bridge answer, so BridgeMemo and the overlay need no changes.
// Network access goes through `fetchImpl` so tests never reach a real API.
import { bytesToBase64, type FetchLike } from "../bridge/client";
import type { BridgeBox, BridgeContext, BridgeTranslateReply, BridgeUnit } from "../bridge/protocol";
import { codeForStatus, scrubMessage, type DirectFailure } from "./errors";
import { ImageTooLargeError, MAX_SEND_BYTES, MAX_SEND_SIDE, prepareImage, type ImageCodec } from "./image";
import { looksTruncated, parseModelOutput } from "./parse";
import { buildPrompt, TEST_PROMPT, type NormBox } from "./prompt";
import { apiStyleOf, type DirectApiSettings } from "./providers";
import {
  answerTruncated,
  buildRequest,
  effectiveMaxTokens,
  extractAnswerText,
  extractErrorText,
  isMaxTokensError,
  type ApiImage,
} from "./request";
import {
  mergeSegmentUnits,
  planSegments,
  segmentBoxToWhole,
  segmentOwning,
  shouldTile,
  wholeBoxToSegment,
  type Segment,
  type SegmentUnit,
} from "./tiles";

/** One API round trip, queue wait included. */
export const DIRECT_TIMEOUT_MS = 120_000;

/** Output limits tried after the requested one when the service refuses it (HTTP 400 naming max_tokens). */
export const FALLBACK_MAX_TOKENS: readonly number[] = [4096, 2048];

/** JPEG qualities tried for one strip segment until it fits the size limit. */
const SEGMENT_QUALITIES: readonly number[] = [0.9, 0.75, 0.6];

/** Shown when the service stopped the answer at the output limit, so the user knows some text may be missing. */
export const TRUNCATED_NOTICE = "输出被截断，可调大输出上限";

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

/** The model's answer text, and whether the service cut it short. */
interface Answer {
  text: string;
  truncated: boolean;
}

type Attempt = { ok: true; answer: Answer } | { ok: false; error: DirectFailure; refusedLimit: boolean };

/** Sends one request with the given output limit. Never throws. */
async function sendOnce(
  settings: DirectApiSettings,
  prompt: string,
  image: ApiImage | null,
  deps: DirectDeps,
  maxTokens: number | undefined,
): Promise<Attempt> {
  const built = buildRequest(settings, prompt, image, maxTokens);
  if (!built.ok) return { ok: false, error: { code: "direct-config", message: built.reason }, refusedLimit: false };
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
    if (deps.signal?.aborted) return { ok: false, error: { code: "timeout", message: "Cancelled" }, refusedLimit: false };
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: { code: "direct-timeout", message: "The request timed out" }, refusedLimit: false };
    }
    return { ok: false, error: { code: "direct-network", message: "Cannot reach the API" }, refusedLimit: false };
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
    return {
      ok: false,
      error: { code: codeForStatus(res.status), message: scrubMessage(`HTTP ${res.status} ${detail}`, settings.apiKey) },
      refusedLimit: isMaxTokensError(res.status, detail),
    };
  }
  const answerText = extractAnswerText(settings, body);
  if (!answerText.trim()) {
    return { ok: false, error: { code: "direct-empty-response", message: "The model returned no text" }, refusedLimit: false };
  }
  return { ok: true, answer: { text: answerText, truncated: answerTruncated(settings, body) || looksTruncated(answerText) } };
}

/**
 * Output limits to try in order: the requested one, then the smaller fallbacks. Gemini has its own fixed limit and
 * gets a single try (`undefined` leaves the Gemini request unchanged).
 */
export function outputLimitsFor(settings: DirectApiSettings): (number | undefined)[] {
  if (apiStyleOf(settings) === "gemini") return [undefined];
  const requested = effectiveMaxTokens(settings.model, settings.maxTokens);
  return [requested, ...FALLBACK_MAX_TOKENS.filter((v) => v < requested)];
}

/** Sends one request, stepping down the output limit when the service refuses it. Never throws. */
async function callApi(settings: DirectApiSettings, prompt: string, image: ApiImage | null, deps: DirectDeps): Promise<Answer | { error: DirectFailure }> {
  const limits = outputLimitsFor(settings);
  for (let i = 0; ; i++) {
    const attempt = await sendOnce(settings, prompt, image, deps, limits[i]);
    if (attempt.ok) return attempt.answer;
    const hasNext = i + 1 < limits.length;
    if (!attempt.refusedLimit || !hasNext) return { error: attempt.error };
  }
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

const imageFailure = (error: unknown, settings: DirectApiSettings): DirectFailure => {
  if (error instanceof ImageTooLargeError) return { code: "direct-image-too-large", message: error.message };
  return { code: "direct-image", message: scrubMessage((error as Error)?.message ?? "Cannot decode the image", settings.apiKey) };
};

/** The user's regions in 0..1 fractions of the original image. */
function regionsOf(boxes: BridgeBox[], width: number, height: number): NormBox[] {
  return boxes.map((b) => ({
    x1: Math.max(0, Math.min(1, b.x1 / width)),
    y1: Math.max(0, Math.min(1, b.y1 / height)),
    x2: Math.max(0, Math.min(1, b.x2 / width)),
    y2: Math.max(0, Math.min(1, b.y2 / height)),
  }));
}

function replyFor(units: BridgeUnit[], width: number, height: number, truncated: boolean, elapsedMs: number): BridgeTranslateReply {
  return {
    result: {
      v: 1,
      hash: "",
      width,
      height,
      cached: false,
      units,
      timings: { detectMs: 0, ocrMs: 0, translateMs: elapsedMs },
      ...(truncated ? { notice: TRUNCATED_NOTICE } : {}),
    },
  };
}

/** One image, one request. */
async function translateWhole(
  settings: DirectApiSettings,
  params: DirectTranslateParams,
  elapsed: () => number,
): Promise<BridgeTranslateReply> {
  let prepared;
  try {
    prepared = await prepareImage(params.bytes, params.codec);
  } catch (error) {
    return { error: imageFailure(error, settings) };
  }
  const { originalWidth: w, originalHeight: h } = prepared;
  const regions = params.boxes?.length ? regionsOf(params.boxes, w, h) : undefined;

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
  return replyFor(units, w, h, answer.truncated, elapsed());
}

/** Encodes one segment of a strip, lowering the quality until it fits the size limit. */
async function cropSegment(codec: ImageCodec, bytes: Uint8Array, segment: Segment, width: number): Promise<Uint8Array> {
  for (const quality of SEGMENT_QUALITIES) {
    const encoded = await codec.cropEncodeJpeg(
      bytes,
      { x: 0, y: segment.top, w: width, h: segment.height },
      segment.sendWidth,
      segment.sendHeight,
      quality,
    );
    if (encoded.length <= MAX_SEND_BYTES) return encoded;
  }
  throw new ImageTooLargeError();
}

/** A long strip: one request per overlapping segment, one after another, then the boxes are mapped back. */
async function translateStrip(
  settings: DirectApiSettings,
  params: DirectTranslateParams,
  size: { width: number; height: number },
  elapsed: () => number,
): Promise<BridgeTranslateReply> {
  const { width: w, height: h } = size;
  const segments = planSegments(w, h, MAX_SEND_SIDE);
  const regions = params.boxes?.length ? regionsOf(params.boxes, w, h) : undefined;
  const collected: SegmentUnit<{ source: string; translation: string }>[] = [];
  let truncated = false;

  for (const segment of segments) {
    let segBytes: Uint8Array;
    try {
      segBytes = await cropSegment(params.codec, params.bytes, segment, w);
    } catch (error) {
      return { error: imageFailure(error, settings) };
    }

    // The user's regions go to the segment that holds their centre. Each region is sent once.
    const owned = regions ? regions.map((box, index) => ({ box, index })).filter((r) => segmentOwning(r.box, segments, h) === segment.index) : undefined;
    if (owned && owned.length === 0) continue;
    const segRegions = owned?.map((r) => wholeBoxToSegment(r.box, segment, h));

    const prompt = buildPrompt({
      targetLang: params.targetLang,
      width: segment.sendWidth,
      height: segment.sendHeight,
      context: params.context,
      regions: segRegions,
    });
    const image = { mime: "image/jpeg", base64: bytesToBase64(segBytes) };

    // A failed segment is retried once. A cancelled request is not retried.
    let answer = await callApi(settings, prompt, image, params);
    if ("error" in answer && !params.signal?.aborted) answer = await callApi(settings, prompt, image, params);
    if ("error" in answer) return { error: answer.error };
    truncated ||= answer.truncated;

    const parsed = parseModelOutput(answer.text, { width: segment.sendWidth, height: segment.sendHeight, regions: segRegions });
    if (owned) {
      // Region mode: the boxes are the user's own, the model only supplies the text, in the same order.
      parsed.units.forEach((u, j) => {
        const region = owned[j];
        if (region) collected.push({ segment: segment.index, box: region.box, value: { source: u.source, translation: u.translation } });
      });
    } else {
      for (const u of parsed.units) {
        collected.push({
          segment: segment.index,
          box: segmentBoxToWhole(u.box, segment, h),
          value: { source: u.source, translation: u.translation },
        });
      }
    }
  }

  const kept = regions ? collected : mergeSegmentUnits(collected);
  const units = kept.map((u) => toUnit(u.box, w, h, u.value.source, u.value.translation));
  return replyFor(units, w, h, truncated, elapsed());
}

/** Detects, reads and translates one image with a vision model. Failures come back as `{ error }`. */
export async function translateDirect(settings: DirectApiSettings, params: DirectTranslateParams): Promise<BridgeTranslateReply> {
  const now = params.now ?? (() => performance.now());
  const started = now();
  const elapsed = () => Math.round(now() - started);

  let size: { width: number; height: number };
  try {
    size = await params.codec.measure(params.bytes);
  } catch (error) {
    return { error: imageFailure(error, settings) };
  }
  if (shouldTile(size.width, size.height)) return translateStrip(settings, params, size, elapsed);
  return translateWhole(settings, params, elapsed);
}

/** "Test connection": a text-only request, so it costs almost nothing. */
export async function testDirect(settings: DirectApiSettings, deps: DirectDeps = {}): Promise<{ ok: true } | { error: DirectFailure }> {
  const answer = await callApi(settings, TEST_PROMPT, null, { ...deps, timeoutMs: deps.timeoutMs ?? 30_000 });
  return "error" in answer ? { error: answer.error } : { ok: true };
}
