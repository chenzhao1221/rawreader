// RawReader extension: direct API mode. One request to a vision model does detection, reading and translation.
// The result has the same shape as the app bridge answer, so BridgeMemo and the overlay need no changes.
// Network access goes through `fetchImpl` so tests never reach a real API.
import { bytesToBase64, type FetchLike } from "../bridge/client";
import type { BridgeBox, BridgeContext, BridgeTranslateReply, BridgeUnit, SegmentFailure } from "../bridge/protocol";
import { codeForStatus, scrubMessage, type DirectFailure } from "./errors";
import { ImageTooLargeError, MAX_SEND_BYTES, MAX_SEND_SIDE, prepareImage, type DecodedImage, type ImageCodec } from "./image";
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
  mergeIncremental,
  orderSegments,
  planSegments,
  segmentBoxToWhole,
  segmentOwning,
  shouldTile,
  wholeBoxToSegment,
  type Focus,
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
  /** Measurement hooks (timings only). Never receives text or addresses. */
  trace?: DirectTrace | undefined;
}

/** Measurement hooks of one direct translation. All times are milliseconds. */
export interface DirectTrace {
  plan?(info: { width: number; height: number; segments: number }): void;
  /** Cropping and encoding the JPEG of a segment. */
  encode?(segment: number, ms: number): void;
  /** One request: sent until the answer text was read, and the time spent reading the JSON body. */
  roundTrip?(entry: { segment: number; ms: number; parseMs: number; attempt: number; ok: boolean }): void;
  /** Turning the model's answer into boxes. */
  parse?(segment: number, ms: number): void;
}

/** Which segment and which attempt a request belongs to (for the measurements only). */
interface RequestMeta {
  segment: number;
  attempt: number;
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
  /** Long strips: where the reader is looking, so those segments are requested first. */
  focus?: Focus | undefined;
  /** Long strips: only these segments (zero-based). A retry of the ones that failed. */
  onlySegments?: number[] | undefined;
  /** Long strips: a segment was read. Its units are in pixels of the whole picture, not yet de-duplicated. */
  onSegment?: ((info: { index: number; total: number; done: number; units: BridgeUnit[]; truncated: boolean }) => void) | undefined;
  /** Long strips: a segment failed twice. The others carry on. */
  onSegmentFailed?: ((info: { index: number; total: number; error: DirectFailure }) => void) | undefined;
  /** Long strips: how many segments will be requested, and how many are finished. */
  onProgress?: ((done: number, total: number) => void) | undefined;
  /**
   * Waits for permission to send one request and resolves with the function that gives the place back. Asked once per
   * segment, so a task that is waiting behind a long strip only waits for one segment, not for the whole strip.
   * Rejects when the task is cancelled while it waits.
   */
  acquireSlot?: ((segment: number) => Promise<() => void>) | undefined;
}

const CANCELLED: BridgeTranslateReply = { error: { code: "timeout", message: "Cancelled" } };

/** Runs `work` while holding a request slot (when the caller gave a way to get one). Resolves null when cancelled while waiting. */
async function withSlot<T>(params: DirectTranslateParams, segment: number, work: () => Promise<T>): Promise<T | null> {
  if (!params.acquireSlot) return work();
  let release: () => void;
  try {
    release = await params.acquireSlot(segment);
  } catch {
    return null;
  }
  try {
    return await work();
  } finally {
    release();
  }
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
  meta: RequestMeta = { segment: 0, attempt: 1 },
): Promise<Attempt> {
  const built = buildRequest(settings, prompt, image, maxTokens);
  if (!built.ok) return { ok: false, error: { code: "direct-config", message: built.reason }, refusedLimit: false };
  const { request } = built;
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const signals = [AbortSignal.timeout(deps.timeoutMs ?? DIRECT_TIMEOUT_MS)];
  if (deps.signal) signals.push(deps.signal);

  const sentAt = performance.now();
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
    deps.trace?.roundTrip?.({ ...meta, ms: performance.now() - sentAt, parseMs: 0, ok: false });
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
  const readAt = performance.now();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  deps.trace?.roundTrip?.({ ...meta, ms: readAt - sentAt, parseMs: performance.now() - readAt, ok: res.ok });

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
async function callApi(
  settings: DirectApiSettings,
  prompt: string,
  image: ApiImage | null,
  deps: DirectDeps,
  meta: RequestMeta = { segment: 0, attempt: 1 },
): Promise<Answer | { error: DirectFailure }> {
  const limits = outputLimitsFor(settings);
  for (let i = 0; ; i++) {
    const attempt = await sendOnce(settings, prompt, image, deps, limits[i], meta);
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
  image: DecodedImage,
  elapsed: () => number,
): Promise<BridgeTranslateReply> {
  let prepared;
  const encodeStart = performance.now();
  try {
    prepared = await prepareImage(params.bytes, image);
  } catch (error) {
    return { error: imageFailure(error, settings) };
  }
  params.trace?.encode?.(0, performance.now() - encodeStart);
  params.trace?.plan?.({ width: prepared.originalWidth, height: prepared.originalHeight, segments: 1 });
  const { originalWidth: w, originalHeight: h } = prepared;
  const regions = params.boxes?.length ? regionsOf(params.boxes, w, h) : undefined;

  const prompt = buildPrompt({
    targetLang: params.targetLang,
    width: prepared.width,
    height: prepared.height,
    context: params.context,
    regions,
  });
  const sent = await withSlot(params, 0, () => callApi(settings, prompt, { mime: prepared.mime, base64: bytesToBase64(prepared.bytes) }, params));
  if (sent === null) return CANCELLED;
  const answer = sent;
  if ("error" in answer) return { error: answer.error };

  const parseStart = performance.now();
  const parsed = parseModelOutput(answer.text, { width: prepared.width, height: prepared.height, regions });
  params.trace?.parse?.(0, performance.now() - parseStart);
  const units = parsed.units.map((u) => toUnit(u.box, w, h, u.source, u.translation));
  return replyFor(units, w, h, answer.truncated, elapsed());
}

/** Encodes one segment of a strip, lowering the quality until it fits the size limit. */
async function cropSegment(image: DecodedImage, segment: Segment, width: number): Promise<Uint8Array> {
  for (const quality of SEGMENT_QUALITIES) {
    const encoded = await image.cropEncodeJpeg(
      { x: 0, y: segment.top, w: width, h: segment.height },
      segment.sendWidth,
      segment.sendHeight,
      quality,
    );
    if (encoded.length <= MAX_SEND_BYTES) return encoded;
  }
  throw new ImageTooLargeError();
}

/** Failures that no other segment can do better on: a wrong key, a bad setting, a missing model, a cancel. */
const FATAL_CODES = new Set(["direct-auth", "direct-config", "direct-not-found", "timeout"]);

/** Same words for a segment that did not come back as for any failed request. */
const failureOf = (segment: number, error: DirectFailure): SegmentFailure => ({ segment, code: error.code, message: error.message });

/**
 * A long strip: one request per overlapping segment, one after another. The segment around the click goes first,
 * then the ones on screen, then the rest (`focus`). Each segment that comes back is reported at once (`onSegment`)
 * with its boxes mapped to the whole picture. A segment that fails twice is reported (`onSegmentFailed`) and the
 * others carry on; the answer then lists the failed ones. `onlySegments` runs just those (a retry).
 */
async function translateStrip(
  settings: DirectApiSettings,
  params: DirectTranslateParams,
  image: DecodedImage,
  elapsed: () => number,
): Promise<BridgeTranslateReply> {
  const { width: w, height: h } = image;
  const segments = planSegments(w, h, MAX_SEND_SIDE);
  params.trace?.plan?.({ width: w, height: h, segments: segments.length });
  const regions = params.boxes?.length ? regionsOf(params.boxes, w, h) : undefined;
  const wanted = params.onlySegments ? segments.filter((s) => params.onlySegments!.includes(s.index)) : segments;

  // The user's regions go to the segment that holds their centre. Each region is sent once. A segment without a
  // region is not cropped, not encoded and not requested.
  const ownedBy = (segment: Segment) =>
    regions ? regions.map((box, index) => ({ box, index })).filter((r) => segmentOwning(r.box, segments, h) === segment.index) : undefined;
  const work = orderSegments(wanted, params.focus, h)
    .map((segment) => ({ segment, owned: ownedBy(segment) }))
    .filter((item) => !item.owned || item.owned.length > 0);

  let shown: SegmentUnit<{ source: string; translation: string }>[] = [];
  const failed: SegmentFailure[] = [];
  let truncated = false;
  let done = 0;
  params.onProgress?.(0, work.length);

  for (const { segment, owned } of work) {
    if (params.signal?.aborted) return CANCELLED;
    const segRegions = owned?.map((r) => wholeBoxToSegment(r.box, segment, h));
    const prompt = buildPrompt({
      targetLang: params.targetLang,
      width: segment.sendWidth,
      height: segment.sendHeight,
      context: params.context,
      regions: segRegions,
    });

    // One slot per segment: crop, encode and send (with its one retry) while holding it, then give it back so a
    // waiting task of a higher priority can go next.
    const outcome = await withSlot(params, segment.index, async (): Promise<{ answer: Answer | { error: DirectFailure } } | { reply: BridgeTranslateReply }> => {
      let segBytes: Uint8Array;
      const encodeStart = performance.now();
      try {
        segBytes = await cropSegment(image, segment, w);
      } catch (error) {
        return { reply: { error: imageFailure(error, settings) } };
      }
      params.trace?.encode?.(segment.index, performance.now() - encodeStart);
      const picture = { mime: "image/jpeg", base64: bytesToBase64(segBytes) };
      // A failed segment is retried once. A cancelled request is not retried.
      let result = await callApi(settings, prompt, picture, params, { segment: segment.index, attempt: 1 });
      if ("error" in result && !params.signal?.aborted) result = await callApi(settings, prompt, picture, params, { segment: segment.index, attempt: 2 });
      return { answer: result };
    });
    if (outcome === null) return CANCELLED;
    if ("reply" in outcome) return outcome.reply;
    const answer = outcome.answer;
    if ("error" in answer) {
      if (FATAL_CODES.has(answer.error.code)) return { error: answer.error };
      const failure = failureOf(segment.index, answer.error);
      failed.push(failure);
      params.onSegmentFailed?.({ index: segment.index, total: work.length, error: answer.error });
      continue;
    }
    truncated ||= answer.truncated;

    const parseStart = performance.now();
    const parsed = parseModelOutput(answer.text, { width: segment.sendWidth, height: segment.sendHeight, regions: segRegions });
    params.trace?.parse?.(segment.index, performance.now() - parseStart);

    const found: SegmentUnit<{ source: string; translation: string }>[] = [];
    if (owned) {
      // Region mode: the boxes are the user's own, the model only supplies the text, in the same order.
      parsed.units.forEach((u, j) => {
        const region = owned[j];
        if (region) found.push({ segment: segment.index, box: region.box, value: { source: u.source, translation: u.translation } });
      });
    } else {
      for (const u of parsed.units) {
        found.push({
          segment: segment.index,
          box: segmentBoxToWhole(u.box, segment, h),
          value: { source: u.source, translation: u.translation },
        });
      }
    }
    // Segments overlap, so one bubble can be read twice. The one already on screen stays; the later copy is dropped.
    shown = regions ? [...shown, ...found] : mergeIncremental(shown, found).kept;
    done += 1;
    params.onSegment?.({
      index: segment.index,
      total: work.length,
      done,
      units: found.map((u) => toUnit(u.box, w, h, u.value.source, u.value.translation)),
      truncated: answer.truncated,
    });
  }

  // Every segment that was asked for failed: nothing to show, so it is an error like a single-request failure.
  if (work.length > 0 && failed.length === work.length) {
    const first = failed[0]!;
    return { error: { code: first.code, message: first.message } };
  }

  // Top to bottom, whatever order the segments came back in.
  const ordered = [...shown].sort((a, b) => a.segment - b.segment);
  const units = ordered.map((u) => toUnit(u.box, w, h, u.value.source, u.value.translation));
  const reply = replyFor(units, w, h, truncated, elapsed());
  if (failed.length > 0 && "result" in reply) reply.result.partial = { failed, total: segments.length };
  return reply;
}

/** Detects, reads and translates one image with a vision model. Failures come back as `{ error }`. */
export async function translateDirect(settings: DirectApiSettings, params: DirectTranslateParams): Promise<BridgeTranslateReply> {
  const now = params.now ?? (() => performance.now());
  const started = now();
  const elapsed = () => Math.round(now() - started);

  // The picture is decoded once and released when the task ends, fails or is cancelled.
  let image: DecodedImage;
  try {
    image = await params.codec.open(params.bytes);
  } catch (error) {
    return { error: imageFailure(error, settings) };
  }
  try {
    if (shouldTile(image.width, image.height)) return await translateStrip(settings, params, image, elapsed);
    return await translateWhole(settings, params, image, elapsed);
  } finally {
    image.close();
  }
}

/** "Test connection": a text-only request, so it costs almost nothing. */
export async function testDirect(settings: DirectApiSettings, deps: DirectDeps = {}): Promise<{ ok: true } | { error: DirectFailure }> {
  const answer = await callApi(settings, TEST_PROMPT, null, { ...deps, timeoutMs: deps.timeoutMs ?? 30_000 });
  return "error" in answer ? { error: answer.error } : { ok: true };
}
