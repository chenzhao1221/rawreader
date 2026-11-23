import { describe, expect, it } from "vitest";
import { appendPerfRecord, BgTimeline, PERF_LOG_MAX, TaskTimeline, type PerfRecord } from "@/lib/perf/timeline";

const clock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("TaskTimeline", () => {
  it("measures from the task start and keeps the first mark of a name", () => {
    const c = clock();
    const tl = new TaskTimeline("t1", "manual", c.now);
    c.advance(120);
    tl.mark("fetch-start");
    c.advance(30);
    tl.mark("fetch-start");
    tl.mark("fetch-end");
    expect(tl.marks["fetch-start"]).toBe(120);
    expect(tl.marks["fetch-end"]).toBe(150);
  });

  it("starts earlier than the page heard of the task when an origin offset is given (the menu click)", () => {
    const c = clock();
    const tl = new TaskTimeline("t1", "manual", c.now, 40);
    c.advance(10);
    expect(tl.elapsed()).toBe(50);
    tl.markAt("enqueue", 1000);
    expect(tl.marks["enqueue"]).toBe(40);
  });

  it("builds a record with the first and last paint and no text fields", () => {
    const c = clock();
    const tl = new TaskTimeline("t1", "manual", c.now);
    c.advance(1800);
    tl.mark("first-paint");
    c.advance(4000);
    tl.mark("final-paint");
    tl.set("image-step", "canvas");
    tl.set("width", 800);
    tl.add("inpaint-ms", 30);
    tl.add("inpaint-ms", 12.34);
    const bg = new BgTimeline({ backend: "direct", cold: true, workerAgeMs: 900 }, c.now);
    const record = tl.toRecord({ version: "0.1.0", outcome: "done", bg: bg.finish(), build: "abc1234", at: 5 });
    expect(record).toMatchObject({
      v: 1,
      taskId: "t1",
      origin: "manual",
      build: "abc1234",
      warm: "cold",
      cache: "miss",
      backend: "direct",
      firstVisibleMs: 1800,
      doneMs: 5800,
      width: 800,
      imageStep: "canvas",
      inpaintMs: 42.3,
      outcome: "done",
    });
    const keys = Object.keys(record);
    for (const forbidden of ["url", "title", "text", "translation", "src"]) expect(keys).not.toContain(forbidden);
  });

  it("reports a cache hit and a missing paint as null", () => {
    const tl = new TaskTimeline("t2", "auto", clock().now);
    tl.set("cache-hit", true);
    const record = tl.toRecord({ version: "0.1.0", outcome: "closed" });
    expect(record.cache).toBe("hit");
    expect(record.firstVisibleMs).toBeNull();
    expect(record.doneMs).toBeNull();
  });
});

describe("BgTimeline", () => {
  it("counts decodes and keeps per-segment encode and round-trip times", () => {
    const c = clock();
    const bg = new BgTimeline({ backend: "direct", cold: false, workerAgeMs: 5000, provider: "custom", model: "m" }, c.now);
    bg.addDecode(20);
    bg.addDecode(30);
    bg.addEncode(1, 12.345);
    bg.addRoundTrip({ segment: 1, ms: 1500.04, parseMs: 1.26, attempt: 1, ok: true });
    bg.addGateWait(5);
    c.advance(2000);
    const perf = bg.finish();
    expect(perf).toMatchObject({ decodeCount: 2, decodeMs: 50, gateWaitMs: 5, totalMs: 2000, provider: "custom", cold: false });
    expect(perf.encodes).toEqual([{ segment: 1, ms: 12.3 }]);
    expect(perf.roundTrips[0]).toMatchObject({ ms: 1500, parseMs: 1.3 });
  });
});

describe("appendPerfRecord", () => {
  const rec = (n: number) => ({ v: 1, taskId: `t${n}` }) as PerfRecord;
  it("appends and keeps the newest PERF_LOG_MAX", () => {
    let log: PerfRecord[] = [];
    for (let i = 0; i < PERF_LOG_MAX + 5; i++) log = appendPerfRecord(log, rec(i));
    expect(log).toHaveLength(PERF_LOG_MAX);
    expect(log[0]!.taskId).toBe("t5");
    expect(log[log.length - 1]!.taskId).toBe(`t${PERF_LOG_MAX + 4}`);
  });
  it("starts a log from nothing", () => {
    expect(appendPerfRecord(null, rec(1))).toHaveLength(1);
    expect(appendPerfRecord(undefined, rec(1))).toHaveLength(1);
  });
});
