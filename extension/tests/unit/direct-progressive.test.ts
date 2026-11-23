import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/bridge/client";
import { translateDirect } from "@/lib/direct/client";
import { codecFrom } from "./helpers/codec";
import type { DirectApiSettings } from "@/lib/direct/providers";
import { mergeIncremental, orderSegments, planSegments } from "@/lib/direct/tiles";

const settings: DirectApiSettings = {
  provider: "zhipu",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-progressive-test-key-1",
  model: "glm-4.6v-flash",
  maxTokens: 8192,
  disableThinking: true,
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answer = (items: unknown[]) => json({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: "stop" }] });
/** One bubble per answer, so every segment adds exactly one unit. `tag` names the text. */
const bubble = (tag: string, box: [number, number, number, number] = [100, 100, 900, 200]) => answer([{ box, translation: tag }]);

/** 800 x 10000 strip: four segments (tops 0, 2826, 5652, 6928) of 3072 px. */
const stripCodec = () => {
  const crops: number[] = [];
  const codec = codecFrom({
    measure: async () => ({ width: 800, height: 10000 }),
    encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
    cropEncodeJpeg: vi.fn(async (_bytes, rect) => {
      crops.push(rect.y);
      return new Uint8Array([0xff, 0xd8, 0xff, 9]);
    }),
  });
  return { codec, crops };
};
const base = { bytes: JPEG, targetLang: "zh" };

describe("segments are reported as they come back", () => {
  it("hands over the first segment before the second request has returned", async () => {
    const { codec } = stripCodec();
    let release2!: (r: Response) => void;
    const second = new Promise<Response>((resolve) => (release2 = resolve));
    const seen: string[] = [];
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(bubble("seg0"))
      .mockImplementationOnce(() => second)
      .mockImplementation(async () => bubble("later"));
    const run = translateDirect(settings, {
      ...base,
      codec,
      fetchImpl,
      onSegment: (info) => seen.push(`${info.index}:${info.units[0]!.translation}`),
    });
    // The first answer is out while the second request is still waiting.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(seen).toEqual(["0:seg0"]);
    release2(bubble("seg1"));
    const reply = await run;
    expect(seen).toHaveLength(4);
    expect("result" in reply && reply.result.units).toHaveLength(4);
  });

  it("counts the finished segments for the status line", async () => {
    const { codec } = stripCodec();
    const fetchImpl = vi.fn<FetchLike>(async () => bubble("x"));
    const progress: string[] = [];
    const done: number[] = [];
    await translateDirect(settings, {
      ...base,
      codec,
      fetchImpl,
      onProgress: (d, t) => progress.push(`${d}/${t}`),
      onSegment: (info) => done.push(info.done),
    });
    expect(progress).toEqual(["0/4"]);
    expect(done).toEqual([1, 2, 3, 4]);
  });
});

describe("the segment the reader is looking at goes first", () => {
  it("sends the segment around the click first, then the ones on screen, then the rest", async () => {
    const { codec, crops } = stripCodec();
    const fetchImpl = vi.fn<FetchLike>(async () => bubble("x"));
    // The click is at 65% of the height (6500 px): inside segment 2 (5652-8724). The screen shows 60%-72%.
    await translateDirect(settings, { ...base, codec, fetchImpl, focus: { point: 0.65, view: { top: 0.6, bottom: 0.72 } } });
    expect(crops[0]).toBe(5652);
    expect(crops).toEqual([5652, 6928, 2826, 0]);
  });

  it("without a focus the order stays top to bottom", async () => {
    const { codec, crops } = stripCodec();
    await translateDirect(settings, { ...base, codec, fetchImpl: vi.fn<FetchLike>(async () => bubble("x")) });
    expect(crops).toEqual([0, 2826, 5652, 6928]);
  });

  it("orders by the part on screen when there is no click", () => {
    const segments = planSegments(800, 10000, 3072);
    expect(orderSegments(segments, { view: { top: 0.8, bottom: 1 } }, 10000).map((s) => s.index)).toEqual([3, 2, 1, 0]);
    expect(orderSegments(segments, undefined, 10000).map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });
});

describe("a segment that fails does not take the others with it", () => {
  // Request 1 answers segment 0; requests 2 and 3 are segment 1 (first try and its retry) and fail; then 2 and 3 answer.
  const failing = () =>
    vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(bubble("seg0"))
      .mockResolvedValueOnce(json({ error: { message: "busy" } }, 500))
      .mockResolvedValueOnce(json({ error: { message: "busy" } }, 500))
      .mockResolvedValueOnce(bubble("seg2"))
      .mockResolvedValueOnce(bubble("seg3"));

  it("keeps the other segments and lists the failed one", async () => {
    const { codec } = stripCodec();
    const failed: number[] = [];
    const reply = await translateDirect(settings, { ...base, codec, fetchImpl: failing(), onSegmentFailed: (info) => failed.push(info.index) });
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units.map((u) => u.translation)).toEqual(["seg0", "seg2", "seg3"]);
    expect(reply.result.partial?.failed.map((f) => f.segment)).toEqual([1]);
    expect(reply.result.partial?.total).toBe(4);
    expect(failed).toEqual([1]);
  });

  it("retries only the failed segment: one request, and the new unit joins the rest", async () => {
    const { codec, crops } = stripCodec();
    await translateDirect(settings, { ...base, codec, fetchImpl: failing() });
    crops.length = 0;
    const retryFetch = vi.fn<FetchLike>(async () => bubble("seg1-again"));
    const reply = await translateDirect(settings, { ...base, codec, fetchImpl: retryFetch, onlySegments: [1] });
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(crops).toEqual([2826]);
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units.map((u) => u.translation)).toEqual(["seg1-again"]);
    expect(reply.result.partial).toBeUndefined();
  });

  it("answers with an error when the retried segment fails again", async () => {
    const { codec } = stripCodec();
    const reply = await translateDirect(settings, { ...base, codec, fetchImpl: vi.fn<FetchLike>(async () => json({}, 500)), onlySegments: [1] });
    expect(reply).toMatchObject({ error: { code: "direct-server" } });
  });

  it("stops without a retry when the task is cancelled", async () => {
    const { codec } = stripCodec();
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async () => {
      controller.abort();
      throw new DOMException("a", "AbortError");
    });
    const reply = await translateDirect(settings, { ...base, codec, fetchImpl, signal: controller.signal });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reply).toMatchObject({ error: { code: "timeout" } });
  });
});

describe("a bubble that two neighbouring segments both read is shown once", () => {
  // 1000 x 5000: segments at 0 and 1928, both 3072 tall. Rows 2000-2500 lie in both.
  const strip = () =>
    codecFrom({
      measure: async () => ({ width: 1000, height: 5000 }),
      encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
      cropEncodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
    });
  const shared0 = answer([{ box: [0, 651, 1000, 814], translation: "from segment 0" }]);
  const shared1 = answer([{ box: [0, 23, 1000, 186], translation: "from segment 1" }]);

  it.each([
    ["top first", undefined, "from segment 0"],
    ["bottom first", { point: 0.9 }, "from segment 1"],
  ])("keeps one copy (%s), the one that arrived first", async (_name, focus, expected) => {
    const fetchImpl = vi.fn<FetchLike>();
    if (focus) fetchImpl.mockResolvedValueOnce(shared1.clone()).mockResolvedValueOnce(shared0.clone());
    else fetchImpl.mockResolvedValueOnce(shared0.clone()).mockResolvedValueOnce(shared1.clone());
    const reply = await translateDirect(settings, { ...base, codec: strip(), fetchImpl, focus });
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.units).toHaveLength(1);
    expect(reply.result.units[0]!.translation).toBe(expected);
  });
});

describe("mergeIncremental", () => {
  const u = (segment: number, y1: number, y2: number) => ({ segment, box: { x1: 0, y1, x2: 1, y2 }, value: `${segment}:${y1}` });
  it("accepts new units and drops those that overlap one already shown from another segment", () => {
    const shown = [u(0, 0.4, 0.5)];
    const { kept, accepted } = mergeIncremental(shown, [u(1, 0.4005, 0.5005), u(1, 0.7, 0.8)]);
    expect(accepted.map((a) => a.value)).toEqual(["1:0.7"]);
    expect(kept.map((k) => k.value)).toEqual(["0:0.4", "1:0.7"]);
    expect(shown).toHaveLength(1);
  });
  it("never merges units of one segment", () => {
    const { accepted } = mergeIncremental([], [u(1, 0.7, 0.8), u(1, 0.71, 0.81)]);
    expect(accepted).toHaveLength(2);
  });
});
