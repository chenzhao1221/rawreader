import { describe, expect, it } from "vitest";
import { BridgeMemo, responseToBboxes, responseToTranslation, sameBoxes, type BridgeCall } from "@/lib/bridge/memo";
import type { BridgeBox, BridgeTranslateReply, BridgeTranslateResponse, BridgeUnit } from "@/lib/bridge/protocol";

const box = (x1: number, y1: number, x2: number, y2: number, confidence = 0.9): BridgeBox => ({ x1, y1, x2, y2, confidence });

const unit = (drawBox: BridgeBox, over: Partial<BridgeUnit> = {}): BridgeUnit => ({
  kind: "bubble",
  bubbleOnly: false,
  drawBox,
  ocrBox: drawBox,
  ocrText: "src",
  translation: "dst",
  status: "ok",
  ...over,
});

const response = (units: BridgeUnit[]): BridgeTranslateResponse => ({
  v: 1,
  hash: "h",
  width: 100,
  height: 100,
  cached: false,
  units,
  timings: { detectMs: 5, ocrMs: 6, translateMs: 7 },
});

describe("responseToBboxes", () => {
  it("returns the draw box of each unit in order", () => {
    const r = response([unit(box(0, 0, 10, 10)), unit(box(20, 20, 30, 30), { ocrBox: box(22, 22, 28, 28) })]);
    expect(responseToBboxes(r).map((b) => [b.x1, b.x2])).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });
});

describe("responseToTranslation", () => {
  it("blanks every unit that did not end in status ok", () => {
    const r = response([
      unit(box(0, 0, 1, 1)),
      unit(box(0, 0, 1, 1), { status: "translate-failed", translation: "partial" }),
      unit(box(0, 0, 1, 1), { status: "echo", translation: "same" }),
      unit(box(0, 0, 1, 1), { status: "watermark", translation: "" }),
    ]);
    const out = responseToTranslation(r);
    expect(out.translations).toEqual(["dst", "", "", ""]);
    expect(out.sourceTexts).toEqual(["src", "src", "src", "src"]);
  });

  it("counts failed units as untranslated and not-ok-but-settled units as clean", () => {
    const failed = responseToTranslation(response([unit(box(0, 0, 1, 1)), unit(box(0, 0, 1, 1), { status: "ocr-failed" })]));
    expect(failed.diagnostics).toEqual({ expectedCount: 2, receivedCount: 1, untranslated: [1], clean: false });

    const settled = responseToTranslation(
      response([unit(box(0, 0, 1, 1), { status: "no-text", translation: "" }), unit(box(0, 0, 1, 1), { status: "skipped", translation: "" })]),
    );
    expect(settled.diagnostics).toEqual({ expectedCount: 2, receivedCount: 0, untranslated: [], clean: true });
  });

  it("carries timings and names the backend", () => {
    const out = responseToTranslation(response([]));
    expect(out.timing).toEqual({ ocr: 6, translate: 7 });
    expect(out.backend).toBe("rawreader");
    expect(out.translations).toEqual([]);
  });
});

describe("sameBoxes", () => {
  it("matches within one pixel and compares lengths", () => {
    expect(sameBoxes([box(0, 0, 10, 10)], [box(1, 0, 10, 9)])).toBe(true);
    expect(sameBoxes([box(0, 0, 10, 10)], [box(2, 0, 10, 10)])).toBe(false);
    expect(sameBoxes([box(0, 0, 10, 10)], [])).toBe(false);
    expect(sameBoxes([], [])).toBe(true);
  });
});

describe("BridgeMemo", () => {
  const twoUnits = response([unit(box(0, 0, 10, 10), { translation: "A" }), unit(box(20, 20, 30, 30), { translation: "B" })]);

  function setup(replies: BridgeTranslateReply[]): { memo: BridgeMemo; calls: Array<BridgeBox[] | undefined> } {
    const calls: Array<BridgeBox[] | undefined> = [];
    const call: BridgeCall = async (boxes) => {
      calls.push(boxes);
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    };
    return { memo: new BridgeMemo(call), calls };
  }

  it("answers detect and translate for unchanged boxes with one request", async () => {
    const { memo, calls } = setup([{ result: twoUnits }]);
    const boxes = await memo.detect();
    expect(Array.isArray(boxes)).toBe(true);
    const out = await memo.translate(boxes as Bbox[]);
    expect("translations" in out && out.translations).toEqual(["A", "B"]);
    expect(calls).toEqual([undefined]);
  });

  it("shares one in-flight request between concurrent detect calls", async () => {
    const { memo, calls } = setup([{ result: twoUnits }]);
    await Promise.all([memo.detect(), memo.detect()]);
    expect(calls.length).toBe(1);
  });

  it("sends a follow-up request with boxes when the user changed them", async () => {
    const edited = response([unit(box(0, 0, 50, 50), { translation: "C" })]);
    const { memo, calls } = setup([{ result: twoUnits }, { result: edited }]);
    await memo.detect();
    const out = await memo.translate([{ x1: 0, y1: 0, x2: 50, y2: 50, confidence: 2 } as Bbox]);
    expect("translations" in out && out.translations).toEqual(["C"]);
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual([box(0, 0, 50, 50, 1)]);
  });

  it("clamps confidence and fills it in for hand-drawn boxes", async () => {
    const { memo, calls } = setup([{ result: twoUnits }, { result: response([unit(box(0, 0, 5, 5)), unit(box(6, 6, 9, 9))]) }]);
    await memo.detect();
    await memo.translate([{ x1: 0, y1: 0, x2: 5, y2: 5 } as Bbox, { x1: 6, y1: 6, x2: 9, y2: 9, confidence: -3 } as Bbox]);
    expect(calls[1]!.map((b) => b.confidence)).toEqual([1, 0]);
  });

  it("rejects a follow-up whose unit count does not match the boxes sent", async () => {
    const { memo } = setup([{ result: twoUnits }, { result: response([unit(box(0, 0, 5, 5))]) }]);
    await memo.detect();
    const out = await memo.translate([{ x1: 0, y1: 0, x2: 5, y2: 5 } as Bbox, { x1: 6, y1: 6, x2: 9, y2: 9 } as Bbox]);
    expect(out).toHaveProperty("error");
  });

  it("returns a Chinese error text when the request fails, and retries on the next detect", async () => {
    const { memo, calls } = setup([{ error: { code: "unreachable", message: "x" } }, { result: twoUnits }]);
    const first = await memo.detect();
    expect(first).toHaveProperty("error");
    expect((first as { error: string }).error).toMatch(/[\u4e00-\u9fff]/);
    expect(Array.isArray(await memo.detect())).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("does not translate raw text and makes no request for an empty box list", async () => {
    const { memo, calls } = setup([{ result: twoUnits }]);
    expect(await memo.translate([], undefined)).toMatchObject({ translations: [] });
    expect(await memo.translate([{ x1: 0, y1: 0, x2: 1, y2: 1 } as Bbox], { rawText: "hi" })).toHaveProperty("error");
    expect(calls.length).toBe(0);
  });

  it("forgets the stored answer on reset", async () => {
    const { memo, calls } = setup([{ result: twoUnits }]);
    await memo.detect();
    memo.reset();
    await memo.detect();
    expect(calls.length).toBe(2);
  });
});
