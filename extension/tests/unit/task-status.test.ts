import { describe, expect, it } from "vitest";
import { canRetry, isTerminal, reduceStatus, statusText, type TaskStatus, type TaskStatusEvent } from "@/lib/task-status";

const run = (events: TaskStatusEvent[], from: TaskStatus | null = null): TaskStatus | null => events.reduce(reduceStatus, from);

describe("reduceStatus: phases only move forward", () => {
  it("goes fetching, queued, translating, done", () => {
    const states: string[] = [];
    let s: TaskStatus | null = null;
    for (const e of [
      { taskId: "a", type: "start" },
      { taskId: "a", type: "queued" },
      { taskId: "a", type: "translating" },
      { taskId: "a", type: "done" },
    ] as TaskStatusEvent[]) {
      s = reduceStatus(s, e);
      states.push(s!.phase);
    }
    expect(states).toEqual(["fetching", "queued", "translating", "done"]);
  });

  it("starts in the page queue, then fetches, then waits for a slot, then translates", () => {
    const s = run([
      { taskId: "a", type: "start", phase: "queued" },
      { taskId: "a", type: "fetching" },
      { taskId: "a", type: "queued" },
      { taskId: "a", type: "translating", done: 0, total: 4 },
    ]);
    expect(s).toMatchObject({ phase: "translating", total: 4, done: 0 });
  });

  it("ignores a late earlier phase", () => {
    const s = run([
      { taskId: "a", type: "start" },
      { taskId: "a", type: "translating" },
      { taskId: "a", type: "queued" },
      { taskId: "a", type: "fetching" },
    ]);
    expect(s!.phase).toBe("translating");
  });

  it("never goes back to fetching once the picture was fetched", () => {
    const s = run([
      { taskId: "a", type: "start", phase: "queued" },
      { taskId: "a", type: "fetching" },
      { taskId: "a", type: "queued" },
      { taskId: "a", type: "fetching" },
    ]);
    expect(s!.phase).toBe("queued");
  });

  it("counts finished segments and never counts backwards", () => {
    const s = run([
      { taskId: "a", type: "start" },
      { taskId: "a", type: "translating", done: 0, total: 4 },
      { taskId: "a", type: "progress", done: 2, total: 4 },
      { taskId: "a", type: "progress", done: 1, total: 4 },
    ]);
    expect(s).toMatchObject({ done: 2, total: 4 });
    expect(statusText(s!)).toBe("翻译中 2/4");
  });

  it("keeps a finished task finished", () => {
    const done = run([{ taskId: "a", type: "start" }, { taskId: "a", type: "done" }]);
    expect(run([{ taskId: "a", type: "translating" }, { taskId: "a", type: "queued" }], done)).toBe(done);
  });
});

describe("reduceStatus: tasks stay apart", () => {
  it("does not let another task's event change this one", () => {
    const a = run([{ taskId: "a", type: "start" }, { taskId: "a", type: "translating" }]);
    expect(reduceStatus(a, { taskId: "b", type: "failed", error: "x" })).toBe(a);
    expect(reduceStatus(a, { taskId: "b", type: "done" })).toBe(a);
    expect(reduceStatus(a, { taskId: "b", type: "progress", done: 3, total: 4 })).toBe(a);
  });

  it("ignores events when there is no task yet", () => {
    expect(reduceStatus(null, { taskId: "a", type: "translating" })).toBeNull();
  });
});

describe("failures and retry", () => {
  it("shows the failed segment numbers from 1 with the reason, and offers a retry", () => {
    const s = run([
      { taskId: "a", type: "start" },
      { taskId: "a", type: "translating", total: 4 },
      { taskId: "a", type: "partial", failed: [1], error: "服务器出错了" },
    ])!;
    expect(s.phase).toBe("partial");
    expect(statusText(s)).toBe("第 2 段失败：服务器出错了");
    expect(canRetry(s)).toBe(true);
    expect(isTerminal(s.phase)).toBe(true);
  });

  it("shows the reason of a total failure with a retry", () => {
    const s = run([{ taskId: "a", type: "start" }, { taskId: "a", type: "failed", error: "没有可用的翻译方式" }])!;
    expect(statusText(s)).toBe("没有可用的翻译方式");
    expect(canRetry(s)).toBe(true);
  });

  it("goes back to queued on retry and can end again", () => {
    const failed = run([
      { taskId: "a", type: "start" },
      { taskId: "a", type: "translating", total: 4 },
      { taskId: "a", type: "partial", failed: [1], error: "x" },
    ]);
    const retried = reduceStatus(failed, { taskId: "a", type: "retry" })!;
    expect(retried.phase).toBe("queued");
    expect(retried.failed).toBeUndefined();
    expect(run([{ taskId: "a", type: "translating", done: 0, total: 1 }, { taskId: "a", type: "done" }], retried)!.phase).toBe("done");
  });

  it("does not retry a task that is still running or done", () => {
    const running = run([{ taskId: "a", type: "start" }, { taskId: "a", type: "translating" }]);
    expect(reduceStatus(running, { taskId: "a", type: "retry" })).toBe(running);
    expect(canRetry(running!)).toBe(false);
  });
});

describe("statusText", () => {
  it("names the real stages", () => {
    expect(statusText({ taskId: "a", phase: "fetching", fetched: true })).toBe("正在取图");
    expect(statusText({ taskId: "a", phase: "queued", fetched: false })).toBe("排队中");
    expect(statusText({ taskId: "a", phase: "translating", fetched: true })).toBe("翻译中");
    expect(statusText({ taskId: "a", phase: "done", fetched: true })).toBe("完成");
  });
});
