// RawReader extension: timing marks for one translation task, and the local ring log they are saved in.
// Only times, sizes and task numbers are recorded: no address, title, picture, source text or translation.
// Pure logic (the clock is injected), so it runs in plain Node tests.

/** `local:` key of the ring log. Newest record last. */
export const PERF_LOG_KEY = "local:perf-log";
export const PERF_LOG_MAX = 200;

declare const __BUILD_ID__: string | undefined;

/** Build label injected by wxt.config.ts (short git hash, or RAWREADER_BUILD_LABEL). */
export function buildId(): string {
  return typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
}

export type TaskOrigin = "manual" | "auto" | "page";

/** What the background worker measures for one task. Every time is milliseconds. */
export interface BgPerf {
  backend: "direct" | "rawreader";
  /** True for the first task this worker process has handled. */
  cold: boolean;
  /** How long the worker had been running when the task arrived. */
  workerAgeMs: number;
  provider?: string;
  model?: string;
  /** Waiting for the request slot (the whole wait for the app path; the sum over all segments for direct). */
  gateWaitMs: number;
  /** Getting the picture bytes (decoding a data URL, or downloading). */
  imageMs: number;
  decodeCount: number;
  decodeMs: number;
  width?: number;
  height?: number;
  segments?: number;
  /** Per segment: cropping and encoding the JPEG. */
  encodes: { segment: number; ms: number }[];
  /** Per request: send until the whole answer text was read, and the parse time. */
  roundTrips: { segment: number; ms: number; parseMs: number; attempt: number; ok: boolean }[];
  /** From the app (rawreader backend only). */
  app?: { detectMs: number; ocrMs: number; translateMs: number };
  /** Whole task inside the worker. */
  totalMs: number;
  /** Milliseconds from task start (in the worker) at which each segment's answer arrived, in arrival order. */
  segmentArrivals?: { segment: number; atMs: number }[];
  failedSegments?: number[];
}

export interface PerfRecord {
  v: 1;
  taskId: string;
  /** Wall-clock time the record was written. */
  at: number;
  build: string;
  version: string;
  origin: TaskOrigin;
  /** The first task of the worker process: "cold". */
  warm: "cold" | "warm";
  cache: "hit" | "miss";
  backend: string;
  provider?: string;
  model?: string;
  width?: number;
  height?: number;
  segments?: number;
  /** Which of the three image steps got the picture (canvas / page-fetch / background / none). */
  imageStep?: string;
  imageBytes?: number;
  /** Milliseconds since the task began (the menu click for a manual task, the queue entry otherwise). */
  marks: Record<string, number>;
  /** Click (or queue entry) until the first translated text was painted on the page. */
  firstVisibleMs: number | null;
  /** Click (or queue entry) until the last paint of the whole image. */
  doneMs: number | null;
  /** Page-side render costs of the last render. */
  inpaintMs?: number;
  drawMs?: number;
  /** Storing the page in the page cache while rendering (writes the cleaned picture too). */
  persistMs?: number;
  renders?: number;
  outcome: "done" | "partial" | "error" | "closed";
  error?: string;
  bg?: BgPerf;
}

export type Clock = () => number;

/** Marks on one task, on the page side. Times are relative to `startedAt` so they never mix process clocks. */
export class TaskTimeline {
  readonly marks: Record<string, number> = {};
  private readonly info: Record<string, unknown> = {};
  private readonly startedAt: number;

  /** `originOffsetMs`: how long ago the task really began (the menu click happened before the page heard of it). */
  constructor(
    readonly taskId: string,
    readonly origin: TaskOrigin,
    private readonly now: Clock = () => performance.now(),
    originOffsetMs = 0,
  ) {
    this.startedAt = now() - Math.max(0, originOffsetMs);
  }

  /** Milliseconds since the task began. */
  elapsed(): number {
    return this.now() - this.startedAt;
  }

  /** Records the time of a named event. The first mark of a name wins unless `overwrite` is set. */
  mark(name: string, overwrite = false): number {
    const at = this.elapsed();
    if (overwrite || !(name in this.marks)) this.marks[name] = at;
    return at;
  }

  /** Records an event that already happened, from a reading of the same clock. */
  markAt(name: string, clockValue: number): void {
    if (!(name in this.marks)) this.marks[name] = clockValue - this.startedAt;
  }

  has(name: string): boolean {
    return name in this.marks;
  }

  set(key: string, value: unknown): void {
    this.info[key] = value;
  }

  get<T>(key: string): T | undefined {
    return this.info[key] as T | undefined;
  }

  /** Adds to a numeric note (for example the render time over several renders). */
  add(key: string, value: number): void {
    this.info[key] = ((this.info[key] as number | undefined) ?? 0) + value;
  }

  toRecord(base: { version: string; outcome: PerfRecord["outcome"]; error?: string; bg?: BgPerf; build?: string; at?: number }): PerfRecord {
    const first = this.marks["first-paint"];
    const done = this.marks["final-paint"];
    const bg = base.bg;
    const record: PerfRecord = {
      v: 1,
      taskId: this.taskId,
      at: base.at ?? Date.now(),
      build: base.build ?? buildId(),
      version: base.version,
      origin: this.origin,
      warm: bg ? (bg.cold ? "cold" : "warm") : "warm",
      cache: this.get<boolean>("cache-hit") ? "hit" : "miss",
      backend: bg?.backend ?? (this.get<string>("backend") ?? "unknown"),
      marks: { ...this.marks },
      firstVisibleMs: first === undefined ? null : round(first),
      doneMs: done === undefined ? null : round(done),
      outcome: base.outcome,
    };
    const put = <K extends keyof PerfRecord>(key: K, value: PerfRecord[K] | undefined) => {
      if (value !== undefined) record[key] = value;
    };
    put("provider", bg?.provider);
    put("model", bg?.model);
    put("width", bg?.width ?? this.get<number>("width"));
    put("height", bg?.height ?? this.get<number>("height"));
    put("segments", bg?.segments);
    put("imageStep", this.get<string>("image-step"));
    put("imageBytes", this.get<number>("image-bytes"));
    put("inpaintMs", roundOpt(this.get<number>("inpaint-ms")));
    put("drawMs", roundOpt(this.get<number>("draw-ms")));
    put("persistMs", roundOpt(this.get<number>("persist-ms")));
    put("renders", this.get<number>("renders"));
    put("error", base.error);
    put("bg", bg);
    for (const key of Object.keys(record.marks)) record.marks[key] = round(record.marks[key]!);
    return record;
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;
const roundOpt = (n: number | undefined): number | undefined => (n === undefined ? undefined : round(n));

/** Marks on one task, in the background worker. Relative to the moment the task reached the worker. */
export class BgTimeline {
  private readonly startedAt: number;
  readonly perf: BgPerf;

  constructor(
    base: { backend: BgPerf["backend"]; cold: boolean; workerAgeMs: number; provider?: string; model?: string },
    private readonly now: Clock = () => performance.now(),
  ) {
    this.startedAt = now();
    this.perf = {
      backend: base.backend,
      cold: base.cold,
      workerAgeMs: Math.round(base.workerAgeMs),
      gateWaitMs: 0,
      imageMs: 0,
      decodeCount: 0,
      decodeMs: 0,
      encodes: [],
      roundTrips: [],
      totalMs: 0,
      ...(base.provider ? { provider: base.provider } : {}),
      ...(base.model ? { model: base.model } : {}),
    };
  }

  elapsed(): number {
    return this.now() - this.startedAt;
  }

  /** Runs `fn` and returns its result; the time is passed to `record`. */
  async timed<T>(record: (ms: number) => void, fn: () => Promise<T>): Promise<T> {
    const t = this.now();
    try {
      return await fn();
    } finally {
      record(this.now() - t);
    }
  }

  addGateWait(ms: number): void {
    this.perf.gateWaitMs += ms;
  }

  addDecode(ms: number): void {
    this.perf.decodeCount += 1;
    this.perf.decodeMs += ms;
  }

  addEncode(segment: number, ms: number): void {
    this.perf.encodes.push({ segment, ms: round(ms) });
  }

  addRoundTrip(entry: { segment: number; ms: number; parseMs: number; attempt: number; ok: boolean }): void {
    this.perf.roundTrips.push({ ...entry, ms: round(entry.ms), parseMs: round(entry.parseMs) });
  }

  addSegmentArrival(segment: number): void {
    (this.perf.segmentArrivals ??= []).push({ segment, atMs: round(this.elapsed()) });
  }

  finish(): BgPerf {
    this.perf.totalMs = round(this.elapsed());
    this.perf.gateWaitMs = round(this.perf.gateWaitMs);
    this.perf.imageMs = round(this.perf.imageMs);
    this.perf.decodeMs = round(this.perf.decodeMs);
    return this.perf;
  }
}

/** Appends a record and keeps the newest `PERF_LOG_MAX`. */
export function appendPerfRecord(log: readonly PerfRecord[] | null | undefined, record: PerfRecord, max = PERF_LOG_MAX): PerfRecord[] {
  const next = [...(Array.isArray(log) ? log : []), record];
  return next.length > max ? next.slice(next.length - max) : next;
}
