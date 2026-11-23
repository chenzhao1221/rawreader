import type { BridgeBox, BridgeTranslateReply, BridgeTranslateResponse } from "./protocol";
import { describeBridgeError } from "./client";

/** One bridge round trip for the image this memo belongs to. `boxes` is set when the user edited or drew boxes. */
export type BridgeCall = (boxes?: BridgeBox[]) => Promise<BridgeTranslateReply>;

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
      clean: untranslated.length === 0,
    },
    timing: { ocr: response.timings.ocrMs, translate: response.timings.translateMs },
    backend: "rawreader",
  };
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

/**
 * Per-image memo for bridge mode. LMT asks for boxes first and translations second; the app does both in one
 * request, so the first call keeps the whole answer and the second returns it without a request. A second call
 * with different boxes (the user edited or drew regions) goes out again with `boxes`.
 */
export class BridgeMemo {
  private full: BridgeTranslateResponse | null = null;
  private inflight: Promise<BridgeTranslateReply> | null = null;

  constructor(private readonly call: BridgeCall) {}

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

    const edited = await this.call(bboxes.map(toBridgeBox));
    if ("error" in edited) return { error: describeBridgeError(edited.error) };
    if (edited.result.units.length !== bboxes.length) return { error: "RawReader 返回的区域数量不一致。" };
    return responseToTranslation(edited.result);
  }

  /** The note of the last detection answer, if any. Stays set until the memo is reset. */
  get notice(): string | null {
    return this.full?.notice ?? null;
  }

  /** Forget the stored answer (the overlay was closed or the page was reset). */
  reset(): void {
    this.full = null;
    this.inflight = null;
  }

  private async fullRun(): Promise<BridgeTranslateReply> {
    if (this.full) return { result: this.full };
    this.inflight ??= this.call().then((reply) => {
      if ("result" in reply) this.full = reply.result;
      this.inflight = null;
      return reply;
    });
    return this.inflight;
  }
}
