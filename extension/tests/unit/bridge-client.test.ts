import { describe, expect, it } from "vitest";
import {
  bridgeUrl,
  bytesToBase64,
  contextToBridge,
  dataUrlToBytes,
  describeBridgeError,
  isValidPort,
  normalizeCode,
  pingBridge,
  translateViaBridge,
  type FetchLike,
} from "@/lib/bridge/client";
import type { BridgeTranslateResponse } from "@/lib/bridge/protocol";

const CODE = "ABCD1234EFGH5678";
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

describe("normalizeCode", () => {
  it("accepts grouped, lower-case and spaced input", () => {
    expect(normalizeCode("abcd-1234-efgh-5678")).toBe(CODE);
    expect(normalizeCode(" ABCD 1234 EFGH 5678 ")).toBe(CODE);
  });

  it("folds look-alike characters the way Crockford base32 does", () => {
    expect(normalizeCode("OOOO-IIII-LLLL-0000")).toBe("0000111111110000");
  });

  it("rejects wrong length and characters outside the alphabet", () => {
    expect(normalizeCode("ABCD")).toBeNull();
    expect(normalizeCode("ABCD1234EFGH567U")).toBeNull();
    expect(normalizeCode("")).toBeNull();
  });
});

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
    const codes = ["unauthorized", "rate-limited", "unknown-extension", "too-large", "unsupported-image", "unreachable", "timeout", "not-configured"];
    const texts = codes.map((code) => describeBridgeError({ code, message: "" }));
    expect(new Set(texts).size).toBe(codes.length);
    for (const text of texts) expect(text).toMatch(/[\u4e00-\u9fff]/);
    expect(describeBridgeError({ code: "weird", message: "" })).toContain("weird");
  });
});

describe("pingBridge", () => {
  it("does not send anything when port or code is missing", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => (calls++, json({}));
    expect(await pingBridge({ port: 18793, code: "short", fetchImpl })).toEqual({
      ok: false,
      error: { code: "not-configured", message: "Port or pairing code missing" },
    });
    expect(await pingBridge({ port: 80, code: CODE, fetchImpl })).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });

  it("sends the normalised code as a bearer token and maps the reply", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization") };
      return json({ v: 1, app: "App", version: "1.2.3", ready: true, engine: "local" });
    };
    const reply = await pingBridge({ port: 18793, code: "abcd-1234-efgh-5678", fetchImpl });
    expect(seen).toEqual({ url: "http://127.0.0.1:18793/ping", auth: `Bearer ${CODE}` });
    expect(reply).toEqual({ ok: true, ready: true, app: "App", version: "1.2.3", engine: "local" });
  });

  it("passes on the not-ready reason", async () => {
    const reason = { code: "MODEL_MISSING", message: "no model" };
    const fetchImpl: FetchLike = async () => json({ v: 1, app: "A", version: "1", ready: false, engine: "local", reason });
    expect(await pingBridge({ port: 18793, code: CODE, fetchImpl })).toMatchObject({ ok: true, ready: false, reason });
  });

  it("maps an HTTP error body, a non-JSON error and a network error", async () => {
    const unauthorized: FetchLike = async () => json({ code: "unauthorized", message: "bad code" }, 401);
    expect(await pingBridge({ port: 18793, code: CODE, fetchImpl: unauthorized })).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "bad code" },
    });
    const html: FetchLike = async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" });
    expect(await pingBridge({ port: 18793, code: CODE, fetchImpl: html })).toMatchObject({ ok: false, error: { code: "http-502" } });
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await pingBridge({ port: 18793, code: CODE, fetchImpl: down })).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });

  it("reports an aborted or timed-out request as timeout", async () => {
    const aborted: FetchLike = async () => {
      throw new DOMException("t", "TimeoutError");
    };
    expect(await pingBridge({ port: 18793, code: CODE, fetchImpl: aborted })).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});

describe("translateViaBridge", () => {
  it("posts a v1 request with base64 image, clamped priority, context and boxes", async () => {
    let seen: { url: string; method?: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = {
        url,
        ...(init?.method ? { method: init.method } : {}),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization"),
      };
      return json(OK_BODY);
    };
    const boxes = [{ x1: 1, y1: 2, x2: 3, y2: 4, confidence: 0.5 }];
    const reply = await translateViaBridge(
      { port: 18793, code: CODE, fetchImpl },
      { bytes: new Uint8Array([1, 2, 3]), priority: 9_999_999.4, context: { seriesName: "S" }, boxes },
    );
    expect(reply).toEqual({ result: OK_BODY });
    expect(seen).toMatchObject({ url: "http://127.0.0.1:18793/translate", method: "POST", auth: `Bearer ${CODE}` });
    expect(seen!.body).toEqual({ v: 1, image: "AQID", priority: 1_000_000, context: { seriesName: "S" }, boxes });
  });

  it("leaves optional fields out of a plain request", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(OK_BODY);
    };
    await translateViaBridge({ port: 18793, code: CODE, fetchImpl }, { bytes: new Uint8Array([0]) });
    expect(Object.keys(body).sort()).toEqual(["image", "v"]);
  });

  it("returns an error object instead of throwing", async () => {
    const tooLarge: FetchLike = async () => json({ code: "too-large", message: "x" }, 413);
    expect(await translateViaBridge({ port: 18793, code: CODE, fetchImpl: tooLarge }, { bytes: new Uint8Array() })).toEqual({
      error: { code: "too-large", message: "x" },
    });
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await translateViaBridge({ port: 18793, code: CODE, fetchImpl: down }, { bytes: new Uint8Array() })).toMatchObject({
      error: { code: "unreachable" },
    });
    expect(await translateViaBridge({ port: 1, code: CODE }, { bytes: new Uint8Array() })).toMatchObject({ error: { code: "not-configured" } });
  });

  it("aborts the request when the caller's signal fires", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const pending = translateViaBridge({ port: 18793, code: CODE, fetchImpl }, { bytes: new Uint8Array(), signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: "timeout" } });
  });
});
