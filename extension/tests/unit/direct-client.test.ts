import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/bridge/client";
import { testDirect, translateDirect } from "@/lib/direct/client";
import type { ImageCodec } from "@/lib/direct/image";
import type { DirectApiSettings } from "@/lib/direct/providers";

const KEY = "sk-direct-test-key-9876";
const settingsGemini: DirectApiSettings = {
  provider: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: KEY,
  model: "gemini-2.5-flash",
};
const settingsZhipu: DirectApiSettings = {
  provider: "zhipu",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: KEY,
  model: "glm-4v-flash",
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** 800 x 1200 image that needs no re-encoding. */
const codec: ImageCodec = {
  measure: async () => ({ width: 800, height: 1200 }),
  encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const openai = (content: string) => json({ choices: [{ message: { content } }] });
const geminiAnswer = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }] });

const base = { bytes: JPEG, codec, targetLang: "Chinese (Simplified)" };

describe("translateDirect: success", () => {
  it("sends one request and maps the answer to pixel boxes of the original image", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      openai(JSON.stringify({ items: [{ box: [100, 200, 500, 400], source: "こんにちは", translation: "你好" }] })),
    );
    const reply = await translateDirect(settingsZhipu, { ...base, fetchImpl, now: () => 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.width).toBe(800);
    expect(reply.result.height).toBe(1200);
    expect(reply.result.units).toHaveLength(1);
    const unit = reply.result.units[0]!;
    expect(unit.drawBox).toEqual({ x1: 80, y1: 240, x2: 400, y2: 480, confidence: 1 });
    expect(unit.translation).toBe("你好");
    expect(unit.ocrText).toBe("こんにちは");
    expect(unit.status).toBe("ok");
  });

  it("builds the OpenAI request with the image, the target language and the key header only", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openai('{"items":[]}'));
    await translateDirect(settingsZhipu, { ...base, fetchImpl, context: { seriesName: "Foo" } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(init?.credentials).toBe("omit");
    const body = JSON.parse(String(init?.body));
    const text = body.messages[0].content[0].text as string;
    expect(text).toContain("Chinese (Simplified)");
    expect(text).toContain("800x1200");
    expect(text).toContain("Series: Foo");
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(String(url)).not.toContain(KEY);
    expect(String(init?.body)).not.toContain(KEY);
  });

  it("uses the Gemini endpoint and answer shape", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => geminiAnswer('{"items":[{"box":[0,0,1000,500],"translation":"T"}]}'));
    const reply = await translateDirect(settingsGemini, { ...base, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units[0]!.drawBox).toEqual({ x1: 0, y1: 0, x2: 800, y2: 600, confidence: 1 });
  });

  it("downscales through the codec and still reports boxes in the original size", async () => {
    const bigCodec: ImageCodec = {
      measure: async () => ({ width: 4000, height: 8000 }),
      encodeJpeg: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 1])),
    };
    const fetchImpl = vi.fn<FetchLike>(async () => openai('{"items":[{"box":[0,0,500,250],"translation":"T"}]}'));
    const reply = await translateDirect(settingsZhipu, { ...base, codec: bigCodec, fetchImpl });
    expect(bigCodec.encodeJpeg).toHaveBeenCalledWith(JPEG, 1024, 2048, 0.85);
    const prompt = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).messages[0].content[0].text as string;
    expect(prompt).toContain("1024x2048");
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.width).toBe(4000);
    expect(reply.result.units[0]!.drawBox).toMatchObject({ x2: 2000, y2: 2000 });
  });

  it("sends the user's regions and keeps them as boxes", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openai('{"items":[{"box":[0,0,1,1],"translation":"甲"},{"box":[0,0,1,1],"translation":"乙"}]}'));
    const boxes = [
      { x1: 80, y1: 120, x2: 400, y2: 600, confidence: 0.9 },
      { x1: 400, y1: 600, x2: 800, y2: 1200, confidence: 1 },
    ];
    const reply = await translateDirect(settingsZhipu, { ...base, fetchImpl, boxes });
    const prompt = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).messages[0].content[0].text as string;
    expect(prompt).toContain("1. [100,100,500,500]");
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units.map((u) => u.drawBox)).toEqual([
      { x1: 80, y1: 120, x2: 400, y2: 600, confidence: 1 },
      { x1: 400, y1: 600, x2: 800, y2: 1200, confidence: 1 },
    ]);
    expect(reply.result.units.map((u) => u.translation)).toEqual(["甲", "乙"]);
  });
});

describe("translateDirect: degradation", () => {
  it("shows a plain-text answer as one unit instead of failing", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openai("这是一段没有 JSON 的译文"));
    const reply = await translateDirect(settingsZhipu, { ...base, fetchImpl });
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units).toHaveLength(1);
    expect(reply.result.units[0]!.translation).toBe("这是一段没有 JSON 的译文");
    expect(reply.result.units[0]!.status).toBe("ok");
    expect(reply.result.units[0]!.drawBox.x2).toBeGreaterThan(reply.result.units[0]!.drawBox.x1);
  });

  it("keeps the items that came without a box", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openai('{"items":[{"translation":"A"},{"translation":"B"}]}'));
    const reply = await translateDirect(settingsZhipu, { ...base, fetchImpl });
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units.map((u) => u.translation)).toEqual(["A", "B"]);
  });

  it("returns no units when the model finds no text", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openai('{"items":[]}'));
    const reply = await translateDirect(settingsZhipu, { ...base, fetchImpl });
    expect(reply).toMatchObject({ result: { units: [] } });
  });
});

describe("translateDirect: failures", () => {
  const failure = async (fetchImpl: FetchLike, extra = {}) => {
    const reply = await translateDirect(settingsZhipu, { ...base, fetchImpl, ...extra });
    if (!("error" in reply)) throw new Error("expected an error");
    return reply.error;
  };

  it.each([
    [401, "direct-auth"],
    [429, "direct-rate-limit"],
    [404, "direct-not-found"],
    [400, "direct-bad-request"],
    [500, "direct-server"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const error = await failure(async () => json({ error: { message: "nope" } }, status));
    expect(error.code).toBe(code);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  it("never puts the API key into an error message, even when the service echoes it", async () => {
    const error = await failure(async () => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401));
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("***");
  });

  it("reports a network failure and a timeout", async () => {
    expect((await failure(async () => { throw new TypeError("Failed to fetch"); })).code).toBe("direct-network");
    expect((await failure(async () => { throw new DOMException("t", "TimeoutError"); })).code).toBe("direct-timeout");
  });

  it("reports a cancelled request as a plain cancel", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(async () => { throw new DOMException("a", "AbortError"); }, { signal: controller.signal });
    expect(error).toEqual({ code: "timeout", message: "Cancelled" });
  });

  it("reports an empty answer and an unreadable body", async () => {
    expect((await failure(async () => openai("  "))).code).toBe("direct-empty-response");
    expect((await failure(async () => new Response("<html>oops</html>", { status: 200 }))).code).toBe("direct-empty-response");
  });

  it("reports settings problems without calling the network", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const reply = await translateDirect({ ...settingsZhipu, apiKey: "" }, { ...base, fetchImpl });
    expect(reply).toMatchObject({ error: { code: "direct-config" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an image that cannot be decoded or stays too large", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const broken: ImageCodec = { measure: async () => { throw new Error("decode failed"); }, encodeJpeg: async () => JPEG };
    expect(await translateDirect(settingsZhipu, { ...base, codec: broken, fetchImpl })).toMatchObject({ error: { code: "direct-image" } });
    const huge: ImageCodec = { measure: async () => ({ width: 5000, height: 5000 }), encodeJpeg: async () => new Uint8Array(4_000_000) };
    expect(await translateDirect(settingsZhipu, { ...base, codec: huge, fetchImpl })).toMatchObject({ error: { code: "direct-image-too-large" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("testDirect", () => {
  it("sends a text-only request and reports success", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => openai("ok"));
    expect(await testDirect(settingsZhipu, { fetchImpl })).toEqual({ ok: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.messages[0].content).toHaveLength(1);
  });

  it("reports the failure code", async () => {
    const result = await testDirect(settingsZhipu, { fetchImpl: async () => json({}, 401) });
    expect(result).toMatchObject({ error: { code: "direct-auth" } });
  });
});
