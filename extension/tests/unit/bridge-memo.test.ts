import { describe, expect, it } from "vitest";
import {
  BridgeMemo,
  responseToBboxes,
  responseToTranslation,
  runBridgeTask,
  sameBoxes,
  shouldWritePageCache,
  type BridgeCall,
  type TranslationReply,
} from "@/lib/bridge/memo";
import type { BridgeBox, BridgeTranslateReply, BridgeTranslateResponse, BridgeUnit, TaskEvent } from "@/lib/bridge/protocol";

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

  it("answers a reordered box list from the stored answer, with the translations in the new order", async () => {
    const { memo, calls } = setup([{ result: twoUnits }]);
    await memo.detect();
    const out = await memo.translate([
      { x1: 20, y1: 20, x2: 30, y2: 30, confidence: 1 } as Bbox,
      { x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 } as Bbox,
    ]);
    expect("translations" in out && out.translations).toEqual(["B", "A"]);
    expect(calls.length).toBe(1);
  });

  it("still sends a request when a box moved or the count changed", async () => {
    const { memo, calls } = setup([{ result: twoUnits }, { result: response([unit(box(0, 0, 10, 10)), unit(box(30, 30, 40, 40))]) }]);
    await memo.detect();
    await memo.translate([{ x1: 0, y1: 0, x2: 10, y2: 10 } as Bbox, { x1: 30, y1: 30, x2: 40, y2: 40 } as Bbox]);
    expect(calls.length).toBe(2);
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

describe("BridgeMemo with a long strip arriving in pieces", () => {
  const seg = (index: number, y: number, text: string, done: number): TaskEvent => ({
    type: "segment",
    index,
    total: 3,
    done,
    units: [unit(box(0, y, 100, y + 50), { translation: text })],
  });
  const plan: TaskEvent = { type: "plan", width: 100, height: 9000, segments: 3 };

  /** A call that plays `events` through the hook, then answers with `reply` (or with the memo's own state). */
  function setupStrip(script: (hooks: Parameters<BridgeCall>[1]) => TaskEvent[], reply: (calls: number) => BridgeTranslateReply) {
    let calls = 0;
    const seenHooks: Array<Parameters<BridgeCall>[1]> = [];
    const call: BridgeCall = async (_boxes, hooks) => {
      calls += 1;
      seenHooks.push(hooks);
      for (const event of script(hooks)) hooks?.onEvent?.(event);
      return reply(calls);
    };
    const memo = new BridgeMemo(call);
    return { memo, seenHooks, get calls() { return calls; } };
  }

  it("tells listeners about each segment as it arrives, in strip order whatever the arrival order", async () => {
    const snapshots: string[][] = [];
    const s = setupStrip(
      () => [plan, seg(2, 6000, "C", 1), seg(0, 100, "A", 2), seg(1, 3000, "B", 3)],
      () => ({ result: { ...response([]), width: 100, height: 9000 } }),
    );
    s.memo.subscribe((snap) => snapshots.push(snap.response.units.map((u) => u.translation)));
    const boxes = await s.memo.detect();
    expect(snapshots).toEqual([["C"], ["A", "C"], ["A", "B", "C"]]);
    expect(Array.isArray(boxes) && boxes.length).toBe(3);
  });

  it("keeps one copy of a bubble two segments both reported, whichever arrived first", async () => {
    const dup = (index: number, text: string): TaskEvent => ({
      type: "segment", index, total: 2, done: 1, units: [unit(box(0, 2000, 100, 2500), { translation: text })],
    });
    for (const order of [[0, 1], [1, 0]] as const) {
      const s = setupStrip(() => [{ type: "plan", width: 100, height: 5000, segments: 2 }, ...order.map((i) => dup(i, `from ${i}`))], () => ({ result: response([]) }));
      await s.memo.detect();
      const out = await s.memo.translate((await s.memo.detect()) as Bbox[]);
      expect("translations" in out && out.translations).toEqual([`from ${order[0]}`]);
    }
  });

  it("remembers a failed segment, keeps the others and reports the page as not clean", async () => {
    const failed: TaskEvent = { type: "segment-failed", index: 1, total: 3, code: "direct-server", message: "HTTP 500" };
    const s = setupStrip(
      () => [plan, seg(0, 100, "A", 1), failed, seg(2, 6000, "C", 2)],
      () => ({ result: response([]) }),
    );
    const boxes = (await s.memo.detect()) as Bbox[];
    expect(boxes).toHaveLength(2);
    expect(s.memo.failedSegments.map((f) => f.segment)).toEqual([1]);
    const out = await s.memo.translate(boxes);
    if (!("translations" in out)) throw new Error("expected translations");
    expect(out.translations).toEqual(["A", "C"]);
    expect(out.failedSegments?.map((f) => f.segment)).toEqual([1]);
    expect(out.diagnostics.clean).toBe(false);
    expect(shouldWritePageCache(out)).toBe(false);
  });

  it("retries only the failed segments and merges the answer into what is shown", async () => {
    const failed: TaskEvent = { type: "segment-failed", index: 1, total: 3, code: "direct-server", message: "HTTP 500" };
    const s = setupStrip(
      (hooks) => (hooks?.onlySegments ? [seg(1, 3000, "B", 1)] : [plan, seg(0, 100, "A", 1), failed, seg(2, 6000, "C", 2)]),
      () => ({ result: response([]) }),
    );
    const snapshots: boolean[] = [];
    s.memo.subscribe((snap) => snapshots.push(snap.complete));
    await s.memo.detect();
    const out = await s.memo.retryFailed();
    expect(out.failed).toEqual([]);
    expect(s.calls).toBe(2);
    expect(s.seenHooks[1]?.onlySegments).toEqual([1]);
    expect(snapshots[snapshots.length - 1]).toBe(true);
    const all = await s.memo.translate((await s.memo.detect()) as Bbox[]);
    expect("translations" in all && all.translations).toEqual(["A", "B", "C"]);
    expect("failedSegments" in all && all.failedSegments).toBeFalsy();
    expect(shouldWritePageCache(all as TranslationReply)).toBe(true);
  });

  it("keeps the failure when the retry fails again", async () => {
    const failed: TaskEvent = { type: "segment-failed", index: 1, total: 3, code: "direct-server", message: "HTTP 500" };
    const s = setupStrip(
      (hooks) => (hooks?.onlySegments ? [failed] : [plan, seg(0, 100, "A", 1), failed, seg(2, 6000, "C", 2)]),
      (n) => (n === 1 ? { result: response([]) } : { error: { code: "direct-server", message: "HTTP 500" } }),
    );
    await s.memo.detect();
    const out = await s.memo.retryFailed();
    expect(out.failed.map((f) => f.segment)).toEqual([1]);
    expect(out.error).toMatch(/[\u4e00-\u9fff]/);
    const all = await s.memo.translate((await s.memo.detect()) as Bbox[]);
    expect("translations" in all && all.translations).toEqual(["A", "C"]);
  });
});

describe("shouldWritePageCache", () => {
  const clean = { diagnostics: { expectedCount: 1, receivedCount: 1, untranslated: [], clean: true } as TranslationDiagnostics };
  it("is true for a clean page with no missing segment", () => {
    expect(shouldWritePageCache(clean)).toBe(true);
  });
  it("is false when a segment is missing, even if the rest is clean", () => {
    expect(shouldWritePageCache({ ...clean, failedSegments: [{ segment: 1, code: "x", message: "y" }] })).toBe(false);
  });
  it("is false for a page with echoed or untranslated boxes", () => {
    expect(shouldWritePageCache({ diagnostics: { ...clean.diagnostics, untranslated: [0], clean: false } })).toBe(false);
  });
});

describe("runBridgeTask", () => {
  /** A fake port: `reply` plays the background worker's side. */
  function fakePort(play: (send: (m: unknown) => void, start: unknown) => void) {
    let onMessage: (m: unknown) => void = () => {};
    let onDisconnect: () => void = () => {};
    const port = {
      posted: [] as unknown[],
      disconnected: false,
      postMessage(m: unknown) {
        port.posted.push(m);
        play((x) => onMessage(x), m);
      },
      disconnect() {
        port.disconnected = true;
      },
      onMessage: { addListener: (l: (m: unknown) => void) => (onMessage = l) },
      onDisconnect: { addListener: (l: () => void) => (onDisconnect = l) },
      closeFromOtherSide: () => onDisconnect(),
    };
    return port;
  }

  it("sends the start message, passes every event on and resolves with the final reply", async () => {
    const events: string[] = [];
    const port = fakePort((send) => {
      send({ type: "stage", stage: "queued" });
      send({ type: "stage", stage: "translating", done: 0, total: 2 });
      send({ type: "done", reply: { result: response([]) } });
    });
    const reply = await runBridgeTask(() => port, { src: "data:x" }, { onEvent: (e) => events.push(e.type) });
    expect(port.posted).toEqual([{ type: "start", data: { src: "data:x" } }]);
    expect(events).toEqual(["stage", "stage", "done"]);
    expect("result" in reply).toBe(true);
    expect(port.disconnected).toBe(true);
  });

  it("answers with the error of an error event", async () => {
    const port = fakePort((send) => send({ type: "error", reply: { error: { code: "direct-auth", message: "no" } } }));
    expect(await runBridgeTask(() => port, { src: "x" })).toEqual({ error: { code: "direct-auth", message: "no" } });
  });

  it("closing the port by the other side, with no answer, is an error", async () => {
    const port = fakePort(() => {});
    const run = runBridgeTask(() => port, { src: "x" });
    port.closeFromOtherSide();
    expect(await run).toMatchObject({ error: { code: "unreachable" } });
  });

  it("aborting the signal disconnects the port and cancels", async () => {
    const port = fakePort(() => {});
    const controller = new AbortController();
    const run = runBridgeTask(() => port, { src: "x" }, { signal: controller.signal });
    controller.abort();
    expect(await run).toMatchObject({ error: { code: "timeout" } });
    expect(port.disconnected).toBe(true);
  });

  it("does not even connect when the signal is already aborted", async () => {
    const port = fakePort(() => {});
    const controller = new AbortController();
    controller.abort();
    expect(await runBridgeTask(() => port, { src: "x" }, { signal: controller.signal })).toMatchObject({ error: { code: "timeout" } });
    expect(port.posted).toEqual([]);
  });
});