// Wire types of the RawReader app bridge (protocol version 1). They mirror src/main/bridge/protocol.ts in the
// desktop app; the app validates every request with zod, so these are plain types here.

export const BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 18793;

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
  | { result: BridgeTranslateResponse }
  | { error: BridgeFailure };

export interface BridgePingMessage {
  type: "BRIDGE_PING";
  /** The options page may test values it has not saved yet. */
  data?: { port?: number; code?: string };
}

export type BridgePingReply =
  | { ok: true; ready: boolean; app: string; version: string; engine: string; reason?: BridgeFailure }
  | { ok: false; error: BridgeFailure };
