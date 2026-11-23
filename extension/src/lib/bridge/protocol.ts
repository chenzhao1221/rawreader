// Wire types of the RawReader app bridge (protocol version 1). They mirror src/main/bridge/protocol.ts in the
// desktop app; the app validates every request with zod, so these are plain types here.
import type { BgPerf } from "../perf/timeline";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 18793;

/** Ports the app tries in order (first free one wins). Must equal BRIDGE_PORTS in src/shared/bridge.ts of the app. */
export const BRIDGE_PORTS: readonly number[] = [18793, 18794, 18795, 18796, 18797];

export interface BridgeBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
}

export type BridgeUnitStatus =
  | "ok"
  | "no-text"
  | "ocr-failed"
  | "translate-failed"
  | "echo"
  | "skipped"
  | "watermark";

export interface BridgeUnit {
  kind: "bubble" | "free";
  bubbleOnly: boolean;
  drawBox: BridgeBox;
  ocrBox: BridgeBox;
  ocrText: string;
  translation: string;
  status: BridgeUnitStatus;
}

export interface BridgeTranslateResponse {
  v: 1;
  hash: string;
  width: number;
  height: number;
  cached: boolean;
  units: BridgeUnit[];
  timings: { detectMs: number; ocrMs: number; translateMs: number };
  /** Extension-side note for the user (direct API mode only), for example that the answer was cut short. */
  notice?: string;
  /** Direct API on a long strip: some segments did not come back. The units of the other segments are all here. */
  partial?: { failed: SegmentFailure[]; total: number };
}

/** One segment of a long strip that could not be translated (after its one retry). Zero-based. */
export interface SegmentFailure {
  segment: number;
  code: string;
  message: string;
}

export interface BridgePingResponse {
  v: 1;
  app: string;
  version: string;
  ready: boolean;
  engine: "local" | "openai" | "gemini";
  reason?: { code: string; message: string };
}

/** What the extension sends as series context. A subset of LMT's SeriesContext. */
export interface BridgeContext {
  seriesName?: string;
  summary?: string;
  dictionary?: string;
}

export interface BridgeRequest {
  v: 1;
  /** Base64 of the image file bytes. */
  image: string;
  priority?: number;
  context?: BridgeContext;
  boxes?: BridgeBox[];
}

export interface BridgeFailure {
  code: string;
  message: string;
}

/** Messages the content script and the options page send to the background worker. */
export interface BridgeTranslateMessage {
  type: "BRIDGE_TRANSLATE";
  data: {
    /** data: URL, or an http(s) image URL the background may fetch. */
    src: string;
    referer?: string;
    boxes?: BridgeBox[];
    context?: BridgeContext;
    priority?: number;
  };
}

export type BridgeTranslateReply =
  | { result: BridgeTranslateResponse; perf?: BgPerf }
  | { error: BridgeFailure; perf?: BgPerf };

// ── Task port (page ↔ background) ──
// A translation task runs over one long-lived port, so the background can report the stages and hand over each
// segment of a long strip as soon as it is read. A page that disconnects cancels the task.

export const TASK_PORT_NAME = "rawreader-task";

/** Where the reader is looking, as fractions (0..1) of the picture height. */
export interface BridgeFocus {
  /** Where the user right-clicked. */
  point?: number;
  /** The part of the picture that is on screen. */
  view?: { top: number; bottom: number };
}

export interface BridgeTaskStart {
  src: string;
  referer?: string;
  boxes?: BridgeBox[];
  context?: BridgeContext;
  priority?: number;
  focus?: BridgeFocus;
  /** Only these segments (zero-based): a retry of the ones that failed. */
  onlySegments?: number[];
}

/** Page to background on the task port. */
export type TaskPortRequest = { type: "start"; data: BridgeTaskStart };

/** Background to page on the task port. */
export type TaskEvent =
  /** `queued`: waiting for a request slot. `translating`: the first request is on its way. */
  | { type: "stage"; stage: "queued" }
  | { type: "stage"; stage: "translating"; done?: number; total?: number }
  /** The strip was measured: how many segments there are. */
  | { type: "plan"; width: number; height: number; segments: number }
  /** One segment was read. `units` are in pixels of the whole picture. `done` counts the segments finished so far. */
  | { type: "segment"; index: number; total: number; done: number; units: BridgeUnit[]; truncated?: boolean }
  | { type: "segment-failed"; index: number; total: number; code: string; message: string }
  | { type: "done"; reply: BridgeTranslateReply }
  | { type: "error"; reply: BridgeTranslateReply };

export interface BridgePingMessage {
  type: "BRIDGE_PING";
}

export type BridgePingReply =
  | { ok: true; ready: boolean; app: string; version: string; engine: string; reason?: BridgeFailure }
  | { ok: false; error: BridgeFailure };
