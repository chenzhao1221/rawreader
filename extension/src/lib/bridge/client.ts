import { describeDirectError } from "../direct/errors";
import type { BridgeHistoryItem } from "../history-sync";
import {
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeBox,
  type BridgeContext,
  type BridgeFailure,
  type BridgePingReply,
  type BridgePingResponse,
  type BridgeRequest,
  type BridgeTranslateReply,
  type BridgeTranslateResponse,
} from "./protocol";

/** The bridge only ever listens on this address. */
export const BRIDGE_HOST = "127.0.0.1";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BridgeConnection {
  port: number;
  fetchImpl?: FetchLike;
}

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function bridgeUrl(port: number, path: "/ping" | "/translate" | "/history" | "/history/open"): string {
  return `http://${BRIDGE_HOST}:${port}${path}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decodes a `data:` URL to bytes. Returns null for anything else. */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const isBase64 = (match[2] ?? "").split(";").includes("base64");
  const payload = match[3] ?? "";
  if (isBase64) {
    const binary = atob(payload);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

/** LMT series context to the three fields the app puts into its prompt. Empty parts are left out. */
export function contextToBridge(context: Partial<SeriesContext> | undefined): BridgeContext | undefined {
  if (!context) return undefined;
  const out: BridgeContext = {};
  if (context.seriesName?.trim()) out.seriesName = context.seriesName;
  if (context.summary?.trim()) out.summary = context.summary;
  if (context.dictionary?.trim()) out.dictionary = context.dictionary;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Simplified Chinese text for each stable error code of the bridge (the app sends English messages). */
export function describeBridgeError(failure: BridgeFailure): string {
  // Direct API mode (and "no backend") use the same failure shape with their own codes.
  const direct = describeDirectError(failure);
  if (direct) return direct;
  switch (failure.code) {
    case "not-found":
      return "这个版本的 RawReader 还不支持阅读历史，请换成新版本。";
    case "forbidden-origin":
    case "forbidden-host":
      return "RawReader 拒绝了这个插件。请使用 RawReader 自带的官方插件构建。";
    case "too-large":
      return "图片太大，RawReader 没有接收。";
    case "unsupported-image":
      return "RawReader 不支持这张图片的格式。";
    case "SERVER_NOT_READY":
      return "RawReader 的识别或翻译服务还没准备好，请稍后再试。";
    case "API_KEY_MISSING":
      return "RawReader 里还没有设置翻译所需的密钥。";
    case "MODEL_MISSING":
      return "RawReader 缺少模型文件，请先在应用里下载模型。";
    case "unreachable":
      return "请先打开 RawReader。";
    case "timeout":
      return "RawReader 没有及时回应。";
    case "image-unavailable":
      return `图片下载失败：${failure.message || "未知原因"}`;
    case "internal-error":
      return `插件内部错误：${failure.message || "未知原因"}（详情见扩展的 service worker 控制台）`;
    default:
      return `RawReader 返回了错误（${failure.code}）。`;
  }
}

async function readFailure(res: Response): Promise<BridgeFailure> {
  try {
    const body = (await res.json()) as Partial<BridgeFailure>;
    if (typeof body.code === "string") return { code: body.code, message: String(body.message ?? "") };
  } catch {
    // Not JSON.
  }
  return { code: `http-${res.status}`, message: res.statusText };
}

function networkFailure(error: unknown): BridgeFailure {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return { code: "timeout", message: "The request was aborted" };
  return { code: "unreachable", message: "Cannot reach the app" };
}

export type ProbeResult =
  | { ok: true; port: number; ping: BridgePingResponse }
  | { ok: false; error: BridgeFailure };

export interface ProbeOptions {
  /** Port that worked last time; it is tried first. */
  cachedPort?: number | null | undefined;
  /** Ports to try after the cached one. Defaults to the app's fixed range. */
  ports?: readonly number[] | undefined;
  fetchImpl?: FetchLike | undefined;
  /** Per port. Localhost refuses at once when nothing listens, so this only bounds a stuck listener. */
  timeoutMs?: number | undefined;
}

function isPingBody(body: unknown): body is BridgePingResponse {
  const b = body as Partial<BridgePingResponse> | null;
  return typeof b === "object" && b !== null && b.v === BRIDGE_PROTOCOL_VERSION && typeof b.app === "string" && typeof b.ready === "boolean";
}

/** `GET /ping` on one port. Returns the app's answer, or why there is none. */
export async function pingPort(port: number, fetchImpl?: FetchLike, timeoutMs = 1500): Promise<{ ok: true; ping: BridgePingResponse } | { ok: false; error: BridgeFailure }> {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(bridgeUrl(port, "/ping"), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: await readFailure(res) };
    const body: unknown = await res.json();
    if (!isPingBody(body)) return { ok: false, error: { code: "not-rawreader", message: "Not a RawReader answer" } };
    return { ok: true, ping: body };
  } catch (error) {
    return { ok: false, error: networkFailure(error) };
  }
}

/**
 * Finds the app: tries the cached port first, then the rest of the fixed range, and returns the first port that
 * answers `GET /ping` like RawReader. When none does, the error says why: a refusal by the app
 * (`forbidden-origin`) wins over `unreachable`, so a wrongly packaged extension is not reported as "app closed". Any other
 * failure (nothing listens, another service, a timeout) counts as `unreachable`.
 */
export async function probeBridge(options: ProbeOptions = {}): Promise<ProbeResult> {
  const candidates = [options.cachedPort, ...(options.ports ?? BRIDGE_PORTS)].filter(isValidPort);
  let refused: BridgeFailure | null = null;
  for (const port of new Set(candidates)) {
    const answer = await pingPort(port, options.fetchImpl, options.timeoutMs);
    if (answer.ok) return { ok: true, port, ping: answer.ping };
    if (answer.error.code === "forbidden-origin") refused ??= answer.error;
  }
  return { ok: false, error: refused ?? { code: "unreachable", message: "Cannot reach the app" } };
}

/** BRIDGE_PING answer for the popup, sidebar and options page. */
export async function pingBridge(options: ProbeOptions = {}): Promise<BridgePingReply & { port?: number }> {
  const found = await probeBridge(options);
  if (!found.ok) return found;
  const { ping } = found;
  return {
    ok: true,
    port: found.port,
    ready: ping.ready,
    app: ping.app,
    version: ping.version,
    engine: ping.engine,
    ...(ping.reason ? { reason: ping.reason } : {}),
  };
}
export interface TranslateParams {
  bytes: Uint8Array;
  boxes?: BridgeBox[] | undefined;
  context?: BridgeContext | undefined;
  priority?: number | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** `POST /translate`. Failures come back as `{ error }`, never as a throw. */
export async function translateViaBridge(connection: BridgeConnection, params: TranslateParams): Promise<BridgeTranslateReply> {
  if (!isValidPort(connection.port)) return { error: { code: "unreachable", message: "No port" } };
  const body: BridgeRequest = {
    v: BRIDGE_PROTOCOL_VERSION,
    image: bytesToBase64(params.bytes),
    ...(params.priority !== undefined ? { priority: Math.max(-1_000_000, Math.min(1_000_000, Math.round(params.priority))) } : {}),
    ...(params.context ? { context: params.context } : {}),
    ...(params.boxes ? { boxes: params.boxes } : {}),
  };
  const doFetch = connection.fetchImpl ?? ((url, init) => fetch(url, init));
  const signals = [AbortSignal.timeout(params.timeoutMs ?? 180_000)];
  if (params.signal) signals.push(params.signal);
  try {
    const res = await doFetch(bridgeUrl(connection.port, "/translate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) return { error: await readFailure(res) };
    return { result: (await res.json()) as BridgeTranslateResponse };
  } catch (error) {
    return { error: networkFailure(error) };
  }
}

/** `POST` of a small JSON body to a history route. Failures come back as `{ error }`, never as a throw. */
async function postJson<T>(connection: BridgeConnection, path: "/history" | "/history/open", body: unknown, timeoutMs: number): Promise<{ result: T } | { error: BridgeFailure }> {
  if (!isValidPort(connection.port)) return { error: { code: "unreachable", message: "No port" } };
  const doFetch = connection.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(bridgeUrl(connection.port, path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: await readFailure(res) };
    return { result: (await res.json()) as T };
  } catch (error) {
    return { error: networkFailure(error) };
  }
}

/** `POST /history`: hands visits to the app. Answers how many the app stored. */
export async function postHistory(connection: BridgeConnection, items: BridgeHistoryItem[], timeoutMs = 10_000): Promise<{ accepted: number } | { error: BridgeFailure }> {
  const reply = await postJson<{ accepted?: unknown }>(connection, "/history", { v: BRIDGE_PROTOCOL_VERSION, items }, timeoutMs);
  if ("error" in reply) return reply;
  return { accepted: typeof reply.result.accepted === "number" ? reply.result.accepted : 0 };
}

/** `POST /history/open`: the app shows its reading-history page. */
export async function openHistoryInApp(connection: BridgeConnection, timeoutMs = 5_000): Promise<{ ok: true } | { error: BridgeFailure }> {
  const reply = await postJson<unknown>(connection, "/history/open", { v: BRIDGE_PROTOCOL_VERSION }, timeoutMs);
  return "error" in reply ? reply : { ok: true };
}