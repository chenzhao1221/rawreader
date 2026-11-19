import { describe, expect, it } from "vitest";
import {
  bridgeUrl,
  bytesToBase64,
  contextToBridge,
  dataUrlToBytes,
  describeBridgeError,
  isValidPort,
  pingBridge,
  pingPort,
  probeBridge,
  translateViaBridge,
  type FetchLike,
} from "@/lib/bridge/client";
import { BRIDGE_PORTS, type BridgeTranslateResponse } from "@/lib/bridge/protocol";
const OK_BODY: BridgeTranslateResponse = {
  v: 1,
  hash: "h",
  width: 10,
  height: 10,
  cached: false,
  units: [],
  timings: { detectMs: 1, ocrMs: 2, translateMs: 3 },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("isValidPort / bridgeUrl", () => {
  it("accepts unprivileged integer ports only", () => {
    expect(isValidPort(18793)).toBe(true);
    expect(isValidPort(1023)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(18793.5)).toBe(false);
    expect(isValidPort("18793")).toBe(false);
  });

  it("always targets the loopback IPv4 address", () => {
    expect(bridgeUrl(18793, "/ping")).toBe("http://127.0.0.1:18793/ping");
    expect(bridgeUrl(2000, "/translate")).toBe("http://127.0.0.1:2000/translate");
  });
});

describe("byte helpers", () => {
  it("round-trips bytes through base64 data URLs, including large buffers", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const url = `data:image/png;base64,${bytesToBase64(bytes)}`;
    expect(dataUrlToBytes(url)).toEqual(bytes);
  });

  it("decodes percent-encoded data URLs and rejects other schemes", () => {
    expect(Array.from(dataUrlToBytes("data:text/plain,hi%20there") ?? [])).toEqual(Array.from(new TextEncoder().encode("hi there")));
    expect(dataUrlToBytes("https://example.com/a.png")).toBeNull();
  });
});

describe("contextToBridge", () => {
  it("keeps only the non-empty fields", () => {
    expect(contextToBridge({ seriesName: "S", summary: "  ", dictionary: "a=b" })).toEqual({ seriesName: "S", dictionary: "a=b" });
  });

  it("returns undefined when nothing is left", () => {
    expect(contextToBridge(undefined)).toBeUndefined();
    expect(contextToBridge({ seriesName: " ", summary: "" })).toBeUndefined();
  });
});

describe("describeBridgeError", () => {
  it("gives every known code its own Chinese text and falls back with the code", () => {
    const codes = ["forbidden-origin", "too-large", "unsupported-image", "unreachable", "timeout"];
    const texts = codes.map((code) => describeBridgeError({ code, message: "" }));
    expect(new Set(texts).size).toBe(codes.length);
    for (const text of texts) expect(text).toMatch(/[\u4e00-\u9fff]/);
    expect(describeBridgeError({ code: "unreachable", message: "" })).toBe("请先打开 RawReader。");
    expect(describeBridgeError({ code: "weird", message: "" })).toContain("weird");
  });

  it("names the download failure and never blames RawReader for it", () => {
    const text = describeBridgeError({ code: "image-unavailable", message: "HTTP 403 Forbidden" });
    expect(text).toBe("图片下载失败：HTTP 403 Forbidden");
    expect(text).not.toContain("RawReader");
    expect(describeBridgeError({ code: "internal-error", message: "boom" })).toContain("boom");
  });
});

const PING_BODY = { v: 1, app: "App", version: "1.2.3", ready: true, engine: "local" };
const down: FetchLike = async () => {
  throw new TypeError("fetch failed");
};
const portOf = (url: string): number => Number(new URL(url).port);

describe("BRIDGE_PORTS", () => {
  it("is the fixed range 18793-18797", () => {
    expect([...BRIDGE_PORTS]).toEqual([18793, 18794, 18795, 18796, 18797]);
  });
});

describe("pingPort", () => {
  it("sends a plain GET /ping without credentials and returns the app's answer", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const fetchImpl: FetchLike = async (url, init) => ((seen = { url, headers: new Headers(init?.headers) }), json(PING_BODY));
    expect(await pingPort(18793, fetchImpl)).toEqual({ ok: true, ping: PING_BODY });
    expect(seen!.url).toBe("http://127.0.0.1:18793/ping");
    expect(seen!.headers.get("authorization")).toBeNull();
  });

  it("rejects an answer that is not RawReader's", async () => {
    expect(await pingPort(18793, async () => json({ hello: "world" }))).toMatchObject({ ok: false, error: { code: "not-rawreader" } });
  });

  it("maps an HTTP error body, a non-JSON error, a network error and a timeout", async () => {
    expect(await pingPort(18793, async () => json({ code: "forbidden-origin", message: "no" }, 403))).toEqual({
      ok: false,
      error: { code: "forbidden-origin", message: "no" },
    });
    const html: FetchLike = async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" });
    expect(await pingPort(18793, html)).toMatchObject({ ok: false, error: { code: "http-502" } });
    expect(await pingPort(18793, down)).toMatchObject({ ok: false, error: { code: "unreachable" } });
    const timedOut: FetchLike = async () => {
      throw new DOMException("t", "TimeoutError");
    };
    expect(await pingPort(18793, timedOut)).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});

describe("probeBridge", () => {
  it("probes 18793 to 18797 in order and takes the first port that answers", async () => {
    const tried: number[] = [];
    const fetchImpl: FetchLike = async (url) => {
      tried.push(portOf(url));
      if (portOf(url) === 18795) return json(PING_BODY);
      throw new TypeError("refused");
    };
    expect(await probeBridge({ fetchImpl })).toEqual({ ok: true, port: 18795, ping: PING_BODY });
    expect(tried).toEqual([18793, 18794, 18795]);
  });

  it("tries the cached port first and does not probe further when it still answers", async () => {
    const tried: number[] = [];
    const fetchImpl: FetchLike = async (url) => (tried.push(portOf(url)), json(PING_BODY));
    expect(await probeBridge({ cachedPort: 18796, fetchImpl })).toMatchObject({ ok: true, port: 18796 });
    expect(tried).toEqual([18796]);
  });

  it("falls back to the whole range when the cached port is stale, without trying it twice", async () => {
    const tried: number[] = [];
    const fetchImpl: FetchLike = async (url) => {
      tried.push(portOf(url));
      if (portOf(url) === 18793) return json(PING_BODY);
      throw new TypeError("refused");
    };
    expect(await probeBridge({ cachedPort: 18797, fetchImpl })).toMatchObject({ ok: true, port: 18793 });
    expect(tried).toEqual([18797, 18793]);
  });

  it("ignores an invalid cached port", async () => {
    const tried: number[] = [];
    const fetchImpl: FetchLike = async (url) => (tried.push(portOf(url)), json(PING_BODY));
    await probeBridge({ cachedPort: 80, fetchImpl });
    expect(tried).toEqual([18793]);
  });

  it("reports unreachable (open RawReader first) when nothing listens on any port", async () => {
    const tried: number[] = [];
    const fetchImpl: FetchLike = async (url) => (tried.push(portOf(url)), down(url));
    expect(await probeBridge({ fetchImpl })).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(tried).toEqual([...BRIDGE_PORTS]);
  });

  it("skips another service on a port and keeps looking", async () => {
    const fetchImpl: FetchLike = async (url) => (portOf(url) === 18793 ? new Response("nope", { status: 404 }) : portOf(url) === 18794 ? json(PING_BODY) : down(url));
    expect(await probeBridge({ fetchImpl })).toMatchObject({ ok: true, port: 18794 });
  });

  it("reports a refusal by the app as forbidden-origin, not as unreachable", async () => {
    const fetchImpl: FetchLike = async (url) => (portOf(url) === 18793 ? json({ code: "forbidden-origin", message: "no" }, 403) : down(url));
    expect(await probeBridge({ fetchImpl })).toMatchObject({ ok: false, error: { code: "forbidden-origin" } });
  });
});

describe("pingBridge", () => {
  it("maps the found app to a popup reply and includes the port", async () => {
    const fetchImpl: FetchLike = async (url) => (portOf(url) === 18794 ? json(PING_BODY) : down(url));
    expect(await pingBridge({ fetchImpl })).toEqual({ ok: true, port: 18794, ready: true, app: "App", version: "1.2.3", engine: "local" });
  });

  it("passes on the not-ready reason", async () => {
    const reason = { code: "MODEL_MISSING", message: "no model" };
    const fetchImpl: FetchLike = async () => json({ ...PING_BODY, ready: false, reason });
    expect(await pingBridge({ fetchImpl })).toMatchObject({ ok: true, ready: false, reason });
  });

  it("returns the error when no app is found", async () => {
    expect(await pingBridge({ fetchImpl: down })).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });
});
describe("translateViaBridge", () => {
  it("posts a v1 request with base64 image, clamped priority, context and boxes", async () => {
    let seen: { url: string; method?: string; body: Record<string, unknown> } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = {
        url,
        ...(init?.method ? { method: init.method } : {}),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return json(OK_BODY);
    };
    const boxes = [{ x1: 1, y1: 2, x2: 3, y2: 4, confidence: 0.5 }];
    const reply = await translateViaBridge(
      { port: 18793, fetchImpl },
      { bytes: new Uint8Array([1, 2, 3]), priority: 9_999_999.4, context: { seriesName: "S" }, boxes },
    );
    expect(reply).toEqual({ result: OK_BODY });
    expect(seen).toMatchObject({ url: "http://127.0.0.1:18793/translate", method: "POST" });
    expect(seen!.body).toEqual({ v: 1, image: "AQID", priority: 1_000_000, context: { seriesName: "S" }, boxes });
  });

  it("leaves optional fields out of a plain request", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(OK_BODY);
    };
    await translateViaBridge({ port: 18793, fetchImpl }, { bytes: new Uint8Array([0]) });
    expect(Object.keys(body).sort()).toEqual(["image", "v"]);
  });

  it("returns an error object instead of throwing", async () => {
    const tooLarge: FetchLike = async () => json({ code: "too-large", message: "x" }, 413);
    expect(await translateViaBridge({ port: 18793, fetchImpl: tooLarge }, { bytes: new Uint8Array() })).toEqual({
      error: { code: "too-large", message: "x" },
    });
    expect(await translateViaBridge({ port: 18793, fetchImpl: down }, { bytes: new Uint8Array() })).toMatchObject({
      error: { code: "unreachable" },
    });
    expect(await translateViaBridge({ port: 1 }, { bytes: new Uint8Array() })).toMatchObject({ error: { code: "unreachable" } });
  });

  it("aborts the request when the caller's signal fires", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const pending = translateViaBridge({ port: 18793, fetchImpl }, { bytes: new Uint8Array(), signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: "timeout" } });
  });
});
