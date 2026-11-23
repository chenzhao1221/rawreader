import {
  TASK_PORT_NAME,
  type BridgeBox,
  type BridgeTaskStart,
  type BridgeTranslateReply,
  type BridgeTranslateResponse,
  type BridgeUnit,
  type SegmentFailure,
  type TaskEvent,
} from "./protocol";
import { describeBridgeError } from "./client";
import { isCleanResult } from "../series-context";
import { mergeIncremental, type SegmentUnit } from "../direct/tiles";

/** Extra things one bridge round trip can be given: a listener for the task's events, or a list of segments to redo. */
export interface CallHooks {
  onEvent?: ((event: TaskEvent) => void) | undefined;
  /** Zero-based segments of a long strip: only these are requested (a retry of the failed ones). */
  onlySegments?: number[] | undefined;
}

/** One bridge round trip for the image this memo belongs to. `boxes` is set when the user edited or drew boxes. */
export type BridgeCall = (boxes?: BridgeBox[], hooks?: CallHooks) => Promise<BridgeTranslateReply>;

/** LMT's translation response shape, as `requestTextTranslation` returns it. */
export interface TranslationReply {
  translations: string[];
  sourceTexts: string[];
  context: undefined;
  gateSkip: undefined;
  gate: undefined;
  diagnostics: TranslationDiagnostics;
  timing: { ocr?: number; translate?: number };
  backend: string;
  /** Long strip: segments that did not come back. The page is shown with what there is and is not cached. */
  failedSegments?: SegmentFailure[];
}

/** What has been read so far, for drawing a partly translated picture. Units are in reading order of the strip. */
export interface PartialSnapshot {
  response: BridgeTranslateResponse;
  /** Every segment has been answered (after a retry that fixed the last failed one). */
  complete: boolean;
  failed: SegmentFailure[];
}

/** Statuses that count as a finished page: text was read and translated, or there was nothing to translate. */
const SETTLED = new Set(["ok", "no-text", "skipped", "watermark"]);

const toBbox = (box: BridgeBox): Bbox => ({
  x1: box.x1,
  y1: box.y1,
  x2: box.x2,
  y2: box.y2,
  confidence: box.confidence,
});

const toBridgeBox = (box: Bbox): BridgeBox => ({
  x1: box.x1,
  y1: box.y1,
  x2: box.x2,
  y2: box.y2,
  confidence: typeof box.confidence === "number" ? Math.max(0, Math.min(1, box.confidence)) : 1,
});

/** The boxes the overlay draws and edits: the bubble (draw) box of every unit, in reading order. */
export function responseToBboxes(response: BridgeTranslateResponse): Bbox[] {
  return response.units.map((unit) => toBbox(unit.drawBox));
}

/**
 * Translations aligned to the boxes. Units that did not end in status `ok` become empty strings, so LMT neither
 * cleans nor paints them (the same path its script gate uses for skipped boxes).
 */
export function responseToTranslation(response: BridgeTranslateResponse): TranslationReply {
  const translations = response.units.map((unit) => (unit.status === "ok" ? unit.translation : ""));
  const sourceTexts = response.units.map((unit) => unit.ocrText);
  const untranslated = response.units.flatMap((unit, i) => (SETTLED.has(unit.status) ? [] : [i]));
  const failed = response.partial?.failed ?? [];
  return {
    translations,
    sourceTexts,
    context: undefined,
    gateSkip: undefined,
    gate: undefined,
    diagnostics: {
      expectedCount: response.units.length,
      receivedCount: translations.filter((text) => text.length > 0).length,
      untranslated,
      // A page with a missing segment is not a clean page, whatever the segments that did come back say.
      clean: untranslated.length === 0 && failed.length === 0,
    },
    timing: { ocr: response.timings.ocrMs, translate: response.timings.translateMs },
    backend: "rawreader",
    ...(failed.length > 0 ? { failedSegments: failed } : {}),
  };
}

/**
 * True when the answer may be written to the page cache and feed the series context: the page is clean and no
 * segment is missing. A partly translated page must never be stored as the finished page.
 */
export function shouldWritePageCache(reply: Pick<TranslationReply, "diagnostics" | "failedSegments">): boolean {
  return isCleanResult(reply.diagnostics) && !(reply.failedSegments && reply.failedSegments.length > 0);
}

/** True when two box lists are the same regions (to a pixel), so the stored answer still applies. */
export function sameBoxes(a: readonly Bbox[], b: readonly Bbox[], tolerance = 1): boolean {
  if (a.length !== b.length) return false;
  return a.every((box, i) => {
    const other = b[i] as Bbox;
    return (
      Math.abs(box.x1 - other.x1) <= tolerance &&
      Math.abs(box.y1 - other.y1) <= tolerance &&
      Math.abs(box.x2 - other.x2) <= tolerance &&
      Math.abs(box.y2 - other.y2) <= tolerance
    );
  });
}

/**
 * For each wanted box, the index of the stored box that covers the same region (to a pixel), or null when the two
 * lists are not the same regions in some order. The overlay sorts boxes into reading order, so the list it asks
 * about can be a reordering of the one the answer came with; that must not cost a second request.
 */
export function matchBoxOrder(stored: readonly Bbox[], wanted: readonly Bbox[], tolerance = 1): number[] | null {
  if (stored.length !== wanted.length) return null;
  const used = new Array<boolean>(stored.length).fill(false);
  const order: number[] = [];
  for (const box of wanted) {
    const found = stored.findIndex(
      (candidate, i) =>
        !used[i] &&
        Math.abs(candidate.x1 - box.x1) <= tolerance &&
        Math.abs(candidate.y1 - box.y1) <= tolerance &&
        Math.abs(candidate.x2 - box.x2) <= tolerance &&
        Math.abs(candidate.y2 - box.y2) <= tolerance,
    );
    if (found < 0) return null;
    used[found] = true;
    order.push(found);
  }
  return order;
}

// ── Task port client ──

/** The part of `browser.runtime.Port` the task client uses (so tests can pass a fake). */
export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

/**
 * Runs one translation task over a port to the background worker. Every event is passed to `onEvent`; the promise
 * answers with the final reply. Aborting the signal (or closing the page) disconnects the port, which cancels the task.
 */
export function runBridgeTask(
  connect: (info: { name: string }) => PortLike,
  start: BridgeTaskStart,
  options: { onEvent?: ((event: TaskEvent) => void) | undefined; signal?: AbortSignal | undefined } = {},
): Promise<BridgeTranslateReply> {
  return new Promise((resolve) => {
    let settled = false;
    const port = connect({ name: TASK_PORT_NAME });
    const settle = (reply: BridgeTranslateReply) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {
        // already closed
      }
      resolve(reply);
    };
    const onAbort = () => settle({ error: { code: "timeout", message: "Cancelled" } });
    port.onMessage.addListener((message) => {
      const event = message as TaskEvent;
      if (!event || typeof event !== "object") return;
      if (event.type === "done" || event.type === "error") {
        options.onEvent?.(event);
        settle(event.reply);
        return;
      }
      options.onEvent?.(event);
    });
    port.onDisconnect.addListener(() => settle({ error: { code: "unreachable", message: "No answer from the background worker" } }));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    port.postMessage({ type: "start", data: start });
  });
}

export interface MemoOptions {
  /** Every event of the task (stages, segments, failures), for the status line. */
  onEvent?: ((event: TaskEvent) => void) | undefined;
}

/**
 * Per-image memo for bridge mode. LMT asks for boxes first and translations second; the app does both in one
 * request, so the first call keeps the whole answer and the second returns it without a request. A second call
 * with different boxes (the user edited or drew regions) goes out again with `boxes`.
 *
 * On a long strip in direct mode the answer arrives in pieces: every segment that comes back is merged into what is
 * already shown (a bubble seen by two neighbouring segments stays once) and listeners are told. A segment that
 * failed is remembered, and `retryFailed` asks for just those again.
 */
export class BridgeMemo {
  private full: BridgeTranslateResponse | null = null;
  private inflight: Promise<BridgeTranslateReply> | null = null;
  private listeners = new Set<(snapshot: PartialSnapshot) => void>();
  // Pieces of a long strip, in the order they were accepted (so the one on screen wins a duplicate).
  private shown: SegmentUnit<BridgeUnit>[] = [];
  private size: { width: number; height: number } | null = null;
  private total = 0;
  private sawSegments = false;
  private failures = new Map<number, SegmentFailure>();

  constructor(
    private readonly call: BridgeCall,
    private readonly options: MemoOptions = {},
  ) {}

  /** Called with the picture read so far each time another segment arrives. Returns the function that stops it. */
  subscribe(listener: (snapshot: PartialSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Segments that did not come back (after their own retry). Empty for a picture that is complete. */
  get failedSegments(): SegmentFailure[] {
    return [...this.failures.values()].sort((a, b) => a.segment - b.segment);
  }

  /** First stage: the regions. Runs the request once; later calls reuse its answer. */
  async detect(): Promise<Bbox[] | { error: string }> {
    const reply = await this.fullRun();
    if ("error" in reply) return { error: describeBridgeError(reply.error) };
    return responseToBboxes(reply.result);
  }

  /** Second stage: the translations for `bboxes`. */
  async translate(bboxes: Bbox[], opts?: { rawText?: string | undefined }): Promise<TranslationReply | { error: string }> {
    if (opts?.rawText !== undefined) {
      return { error: "RawReader 暂不支持直接翻译手动输入的文字。" };
    }
    if (bboxes.length === 0) {
      return responseToTranslation({
        v: 1, hash: "", width: 0, height: 0, cached: false, units: [], timings: { detectMs: 0, ocrMs: 0, translateMs: 0 },
      });
    }
    if (this.full) {
      const order = matchBoxOrder(responseToBboxes(this.full), bboxes);
      if (order) return responseToTranslation({ ...this.full, units: order.map((i) => this.full!.units[i]!) });
    }

    const edited = await this.call(bboxes.map(toBridgeBox), { onEvent: (event) => this.options.onEvent?.(event) });
    if ("error" in edited) return { error: describeBridgeError(edited.error) };
    if (edited.result.units.length !== bboxes.length) return { error: "RawReader 返回的区域数量不一致。" };
    return responseToTranslation(edited.result);
  }

  /**
   * Asks again for the segments that failed, and keeps everything that is already shown. Resolves with the segments
   * that are still missing (none when the picture is now complete). Listeners get the picture as it grows.
   */
  async retryFailed(): Promise<{ failed: SegmentFailure[]; error?: string }> {
    const only = this.failedSegments.map((f) => f.segment);
    if (only.length === 0 || !this.full) return { failed: [] };
    const reply = await this.call(undefined, { onlySegments: only, onEvent: (event) => this.handleEvent(event) });
    if ("error" in reply) {
      // Every retried segment failed again, or the failure was fatal (wrong key, cancelled).
      for (const segment of only) {
        if (!this.failures.has(segment)) this.failures.set(segment, { segment, code: reply.error.code, message: reply.error.message });
      }
      return { failed: this.failedSegments, error: describeBridgeError(reply.error) };
    }
    this.full = this.assemble(reply.result);
    this.notify(this.failures.size === 0);
    return { failed: this.failedSegments };
  }

  /** The note of the last detection answer, if any. Stays set until the memo is reset. */
  get notice(): string | null {
    return this.full?.notice ?? null;
  }

  /** Forget the stored answer (the overlay was closed or the page was reset). */
  reset(): void {
    this.full = null;
    this.inflight = null;
    this.shown = [];
    this.size = null;
    this.total = 0;
    this.sawSegments = false;
    this.failures.clear();
  }

  private async fullRun(): Promise<BridgeTranslateReply> {
    if (this.full) return { result: this.full };
    this.inflight ??= this.call(undefined, { onEvent: (event) => this.handleEvent(event) }).then((reply) => {
      this.inflight = null;
      if (!("result" in reply)) return reply;
      this.full = this.assemble(reply.result);
      return { ...reply, result: this.full };
    });
    return this.inflight;
  }

  private handleEvent(event: TaskEvent): void {
    if (event.type === "plan") {
      this.size = { width: event.width, height: event.height };
      this.total = event.segments;
    } else if (event.type === "segment") {
      this.sawSegments = true;
      this.failures.delete(event.index);
      const incoming = event.units.map((value) => ({ segment: event.index, box: { x1: value.drawBox.x1, y1: value.drawBox.y1, x2: value.drawBox.x2, y2: value.drawBox.y2 }, value }));
      // A second answer for the same segment replaces the first.
      this.shown = mergeIncremental(this.shown.filter((u) => u.segment !== event.index), incoming).kept;
      this.notify(false);
    } else if (event.type === "segment-failed") {
      this.failures.set(event.index, { segment: event.index, code: event.code, message: event.message });
    }
    this.options.onEvent?.(event);
  }

  /** The whole-picture answer from what was received: units top to bottom, with the failed segments listed. */
  private assemble(result: BridgeTranslateResponse): BridgeTranslateResponse {
    if (!this.sawSegments) return result;
    const failed = this.failedSegments;
    const { partial: _old, ...rest } = result;
    return {
      ...rest,
      units: this.orderedUnits(),
      ...(failed.length > 0 ? { partial: { failed, total: this.total || result.partial?.total || 0 } } : {}),
    };
  }

  private orderedUnits(): BridgeUnit[] {
    return [...this.shown].sort((a, b) => a.segment - b.segment).map((u) => u.value);
  }

  private notify(complete: boolean): void {
    if (this.listeners.size === 0) return;
    const response: BridgeTranslateResponse = {
      v: 1,
      hash: "",
      width: this.size?.width ?? 0,
      height: this.size?.height ?? 0,
      cached: false,
      units: this.orderedUnits(),
      timings: { detectMs: 0, ocrMs: 0, translateMs: 0 },
      ...(this.failures.size > 0 ? { partial: { failed: this.failedSegments, total: this.total } } : {}),
    };
    const snapshot: PartialSnapshot = { response, complete, failed: this.failedSegments };
    for (const listener of this.listeners) listener(snapshot);
  }
}
