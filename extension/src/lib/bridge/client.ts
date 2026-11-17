import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
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
  /** Pairing code as the user typed it (grouped or not). */
  code: string;
  fetchImpl?: FetchLike;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Brings a typed pairing code to the form the app expects: upper case, no separators, look-alikes folded.
 * Returns null when it is not 16 Crockford characters.
 */
export function normalizeCode(input: string): string | null {
  const folded = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (folded.length !== 16) return null;
  for (const char of folded) if (!CROCKFORD.includes(char)) return null;
  return folded;
}

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function bridgeUrl(port: number, path: "/ping" | "/translate"): string {
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
  switch (failure.code) {
    case "unauthorized":
      return "配对码不正确，请在 RawReader 设置里重新复制。";
    case "rate-limited":
      return "配对码错误次数过多，请一分钟后再试。";
    case "unknown-extension":
      return "RawReader 已和另一个插件配对。请在应用里重新生成配对码。";
    case "forbidden-origin":
    case "forbidden-host":
      return "RawReader 拒绝了这次连接。";
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
      return "连不上 RawReader。请确认应用在运行，并已在设置里启用浏览器插件桥接。";
    case "timeout":
      return "RawReader 没有及时回应。";
    case "not-configured":
      return "还没有填写 RawReader 的端口和配对码，请打开插件设置。";
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

/** `GET /ping`: is the app there, paired, and ready to translate. */
export async function pingBridge(connection: BridgeConnection, timeoutMs = 3000): Promise<BridgePingReply> {
  const code = normalizeCode(connection.code);
  if (!isValidPort(connection.port) || code === null) {
    return { ok: false, error: { code: "not-configured", message: "Port or pairing code missing" } };
  }
  const doFetch = connection.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(bridgeUrl(connection.port, "/ping"), {
      headers: { Authorization: `Bearer ${code}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: await readFailure(res) };
    const body = (await res.json()) as BridgePingResponse;
    return {
      ok: true,
      ready: body.ready === true,
      app: body.app,
      version: body.version,
      engine: body.engine,
      ...(body.reason ? { reason: body.reason } : {}),
    };
  } catch (error) {
    return { ok: false, error: networkFailure(error) };
  }
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
  const code = normalizeCode(connection.code);
  if (!isValidPort(connection.port) || code === null) {
    return { error: { code: "not-configured", message: "Port or pairing code missing" } };
  }
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
      headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) return { error: await readFailure(res) };
    return { result: (await res.json()) as BridgeTranslateResponse };
  } catch (error) {
    return { error: networkFailure(error) };
  }
}
