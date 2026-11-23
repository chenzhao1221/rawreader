import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/bridge/client";
import { translateDirect } from "@/lib/direct/client";
import type { ImageCodec } from "@/lib/direct/image";
import type { DirectApiSettings } from "@/lib/direct/providers";
import {
  iou,
  mergeSegmentUnits,
  planSegments,
  segmentBoxToWhole,
  segmentOwning,
  shouldTile,
  wholeBoxToSegment,
} from "@/lib/direct/tiles";

const settings: DirectApiSettings = {
  provider: "zhipu",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-tile-test-key-1234",
  model: "glm-4.6v-flash",
  maxTokens: 8192,
  disableThinking: true,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answer = (content: string) => json({ choices: [{ message: { content }, finish_reason: "stop" }] });

describe("shouldTile", () => {
  it("cuts only images taller than twice their width", () => {
    expect(shouldTile(800, 1600)).toBe(false);
    expect(shouldTile(800, 1601)).toBe(true);
    expect(shouldTile(0, 100)).toBe(false);
  });
});

describe("planSegments", () => {
  it("keeps the original resolution and overlaps neighbours by about 8%", () => {
    const segs = planSegments(1000, 5000, 3072);
    expect(segs.map((s) => s.top)).toEqual([0, 1928]);
    expect(segs.map((s) => s.height)).toEqual([3072, 3072]);
    expect(segs[0]!.sendWidth).toBe(1000);
    expect(segs[0]!.sendHeight).toBe(3072);
    // Overlap between the first segment's bottom (3072) and the second segment's top (1928).
    expect(segs[0]!.top + segs[0]!.height - segs[1]!.top).toBeGreaterThanOrEqual(Math.round(0.08 * 3072));
  });

  it("keeps every segment's longest side within the limit, scaling wide strips down", () => {
    const segs = planSegments(4000, 12000, 3072);
    for (const s of segs) {
      expect(Math.max(s.sendWidth, s.sendHeight)).toBeLessThanOrEqual(3072);
      expect(s.sendWidth).toBe(3072);
    }
    expect(segs[0]!.top).toBe(0);
    expect(segs[segs.length - 1]!.top + segs[segs.length - 1]!.height).toBe(12000);
  });

  it("covers the whole height with no gap", () => {
    const segs = planSegments(900, 20000, 3072);
    let covered = 0;
    for (const s of segs) {
      expect(s.top).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, s.top + s.height);
    }
    expect(covered).toBe(20000);
  });
});

describe("box mapping", () => {
  const seg = { index: 1, top: 1928, height: 3072, sendWidth: 1000, sendHeight: 3072 };

  it("maps a segment box back to fractions of the whole image", () => {
    const whole = segmentBoxToWhole({ x1: 0, y1: 0.5, x2: 1, y2: 0.6 }, seg, 5000);
    expect(whole.y1).toBeCloseTo((1928 + 1536) / 5000, 6);
    expect(whole.y2).toBeCloseTo((1928 + 1843.2) / 5000, 6);
    expect(whole.x2).toBe(1);
  });

  it("maps a whole-image region into a segment and back again", () => {
    const region = { x1: 0.1, y1: 0.4, x2: 0.9, y2: 0.5 };
    const inSeg = wholeBoxToSegment(region, seg, 5000);
    const back = segmentBoxToWhole(inSeg, seg, 5000);
    expect(back.y1).toBeCloseTo(region.y1, 6);
    expect(back.y2).toBeCloseTo(region.y2, 6);
  });

  it("assigns a region to the segment that holds its centre", () => {
    const segs = planSegments(1000, 5000, 3072);
    expect(segmentOwning({ x1: 0, y1: 0.1, x2: 1, y2: 0.2 }, segs, 5000)).toBe(0);
    expect(segmentOwning({ x1: 0, y1: 0.8, x2: 1, y2: 0.9 }, segs, 5000)).toBe(1);
  });
});

describe("duplicate removal", () => {
  it("computes intersection over union", () => {
    expect(iou({ x1: 0, y1: 0, x2: 1, y2: 1 }, { x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(1);
    expect(iou({ x1: 0, y1: 0, x2: 0.5, y2: 1 }, { x1: 0.5, y1: 0, x2: 1, y2: 1 })).toBe(0);
  });

  it("keeps one of two overlapping reads from neighbouring segments, but never merges one segment's own boxes", () => {
    const a = { x1: 0, y1: 0.4, x2: 1, y2: 0.5 };
    const b = { x1: 0, y1: 0.4005, x2: 1, y2: 0.5005 };
    const kept = mergeSegmentUnits([
      { segment: 0, box: a, value: "first" },
      { segment: 1, box: b, value: "again" },
      { segment: 1, box: { x1: 0, y1: 0.7, x2: 1, y2: 0.8 }, value: "own A" },
      { segment: 1, box: { x1: 0, y1: 0.71, x2: 1, y2: 0.81 }, value: "own B" },
      { segment: 2, box: { x1: 0, y1: 0.8, x2: 1, y2: 0.9 }, value: "far" },
    ]);
    expect(kept.map((k) => k.value)).toEqual(["first", "own A", "own B", "far"]);
  });
});

describe("translateDirect on a long strip", () => {
  // 1000 x 5000 strip: segments start at 0 and 1928 (3072 px each, overlapping by 1144 px).
  const strip: ImageCodec = {
    measure: async () => ({ width: 1000, height: 5000 }),
    encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
    cropEncodeJpeg: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 9])),
  };
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  it("sends one request per segment, maps the boxes back and drops the bubble both segments saw", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      // Segment 0 (rows 0-3072): a bubble at rows 2000-2500 and one at rows 1000-1200.
      .mockResolvedValueOnce(answer('{"items":[{"box":[0,651,1000,814],"translation":"Shared"},{"box":[0,325,1000,390],"translation":"Top"}]}'))
      // Segment 1 (rows 1928-5000): the shared bubble again, and a new one at rows 4000-4200.
      .mockResolvedValueOnce(answer('{"items":[{"box":[0,23,1000,186],"translation":"Shared again"},{"box":[0,675,1000,740],"translation":"Lower"}]}'));

    const reply = await translateDirect(settings, { bytes: JPEG, codec: strip, targetLang: "zh", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(strip.cropEncodeJpeg).toHaveBeenCalledWith(JPEG, { x: 0, y: 0, w: 1000, h: 3072 }, 1000, 3072, 0.9);
    expect(strip.cropEncodeJpeg).toHaveBeenCalledWith(JPEG, { x: 0, y: 1928, w: 1000, h: 3072 }, 1000, 3072, 0.9);
    if (!("result" in reply)) throw new Error("expected a result");
    expect(reply.result.width).toBe(1000);
    expect(reply.result.height).toBe(5000);
    expect(reply.result.units.map((u) => u.translation)).toEqual(["Shared", "Top", "Lower"]);
    // Shared bubble: rows 2000-2501 of the original image, from segment 0's read (segment 1's copy is dropped).
    const shared = reply.result.units[0]!.drawBox;
    expect(shared.y1).toBe(2000);
    expect(shared.y2).toBe(2501);
    // Lower bubble: rows 4002-4201 of the original image (segment 1 starts at row 1928).
    const lower = reply.result.units[2]!.drawBox;
    expect(lower.y1).toBe(4002);
    expect(lower.y2).toBe(4201);
  });

  it("retries a failed segment once and then succeeds", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json({ error: { message: "busy" } }, 500))
      .mockResolvedValueOnce(answer('{"items":[{"box":[0,0,1000,100],"translation":"A"}]}'))
      .mockResolvedValueOnce(answer('{"items":[]}'));
    const reply = await translateDirect(settings, { bytes: JPEG, codec: strip, targetLang: "zh", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(reply).toMatchObject({ result: { units: [{ translation: "A" }] } });
  });

  it("fails the whole image only when every segment fails twice", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: { message: "busy" } }, 500));
    const reply = await translateDirect(settings, { bytes: JPEG, codec: strip, targetLang: "zh", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(reply).toMatchObject({ error: { code: "direct-server" } });
  });

  it("stops at once on a failure that no other segment can fix (a refused key)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: { message: "bad key" } }, 401));
    const reply = await translateDirect(settings, { bytes: JPEG, codec: strip, targetLang: "zh", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reply).toMatchObject({ error: { code: "direct-auth" } });
  });
});
