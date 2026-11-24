import { describe, expect, it } from "vitest";
import {
  HISTORY_BATCH_SIZE,
  addPending,
  mergePending,
  nextBatch,
  parsePending,
  pendingFromLegacy,
  removeSent,
  toBridgeItems,
  type PendingVisit,
} from "@/lib/history-sync";
import { postHistory, openHistoryInApp, describeBridgeError, type FetchLike } from "@/lib/bridge/client";

const T0 = 1_800_000_000_000;
const visit = (n: number, extra: Partial<PendingVisit> = {}): PendingVisit => ({
  url: `https://reader.example.com/c/${n}`,
  title: `Chapter ${n}`,
  series: "",
  chapter: "",
  visitedAt: T0 + n * 1000,
  ...extra,
});

describe("addPending", () => {
  it("adds a cleaned visit and keeps the queue oldest first", () => {
    let list: PendingVisit[] = [];
    list = addPending(list, { url: "https://reader.example.com/c/1?utm_source=x#top", title: "  A\n B  " }, T0);
    list = addPending(list, { url: "https://reader.example.com/c/2", series: "S", chapter: "2" }, T0 + 1000);
    expect(list).toEqual([
      { url: "https://reader.example.com/c/1", title: "A B", series: "", chapter: "", visitedAt: T0 },
      { url: "https://reader.example.com/c/2", title: "", series: "S", chapter: "2", visitedAt: T0 + 1000 },
    ]);
  });

  it("keeps one item per address with the newest time and does not lose the title", () => {
    let list = addPending([], { url: "https://example.com/a", title: "Title" }, T0);
    list = addPending(list, { url: "https://example.com/a" }, T0 + 5000);
    expect(list).toEqual([{ url: "https://example.com/a", title: "Title", series: "", chapter: "", visitedAt: T0 + 5000 }]);
  });

  it("ignores addresses that cannot be stored and returns the same list", () => {
    const list = [visit(1)];
    expect(addPending(list, { url: "chrome://settings" }, T0)).toBe(list);
    expect(addPending(list, { url: "javascript:alert(1)" }, T0)).toBe(list);
  });

  it("drops the oldest visits over the cap", () => {
    let list: PendingVisit[] = [];
    for (let i = 0; i < 5; i++) list = addPending(list, { url: `https://example.com/${i}` }, T0 + i, 3);
    expect(list.map((v) => v.url)).toEqual(["https://example.com/2", "https://example.com/3", "https://example.com/4"]);
  });
});

describe("parsePending / pendingFromLegacy", () => {
  it("drops items of the wrong shape or with an unusable address", () => {
    expect(parsePending(undefined)).toEqual([]);
    expect(parsePending([visit(1), { url: "x" }, null, { url: "ftp://example.com/", visitedAt: 1 }, { url: "https://example.com/a", visitedAt: "1" }])).toEqual([visit(1)]);
  });

  it("turns the legacy list into one visit per entry at its last visit", () => {
    const legacy = [
      { id: "1", url: "https://example.com/a?utm_medium=x", title: "A", site: "example.com", series: "S", chapter: "3", firstVisitedAt: 1, lastVisitedAt: 50, visits: 4 },
    ];
    expect(pendingFromLegacy(legacy)).toEqual([{ url: "https://example.com/a", title: "A", series: "S", chapter: "3", visitedAt: 50 }]);
  });
});

describe("mergePending", () => {
  it("unions by address, keeps the newest time and fills empty text from the other copy", () => {
    const a = [visit(1, { title: "", series: "S" }), visit(2)];
    const b = [visit(1, { title: "T", series: "", visitedAt: T0 + 99_000 })];
    expect(mergePending(a, b)).toEqual([visit(2), { ...visit(1), title: "T", series: "S", visitedAt: T0 + 99_000 }]);
  });
});

describe("batches and removal", () => {
  it("takes at most one request worth, oldest first", () => {
    const list = Array.from({ length: HISTORY_BATCH_SIZE + 5 }, (_, i) => visit(i));
    expect(nextBatch(list)).toHaveLength(HISTORY_BATCH_SIZE);
    expect(nextBatch(list)[0]).toBe(list[0]);
    expect(nextBatch(list, 2)).toEqual(list.slice(0, 2));
  });

  it("removes what was sent and keeps a visit that changed meanwhile", () => {
    const list = [visit(1), visit(2), visit(3)];
    const sent = [visit(1), visit(2)];
    const changed = [visit(1, { visitedAt: T0 + 77_000 }), visit(2), visit(3)];
    expect(removeSent(list, sent)).toEqual([visit(3)]);
    expect(removeSent(changed, sent)).toEqual([visit(1, { visitedAt: T0 + 77_000 }), visit(3)]);
  });

  it("leaves empty fields out of the bridge items", () => {
    expect(toBridgeItems([visit(1, { title: "" }), visit(2, { series: "S", chapter: "2" })])).toEqual([
      { url: "https://reader.example.com/c/1", visitedAt: T0 + 1000 },
      { url: "https://reader.example.com/c/2", title: "Chapter 2", series: "S", chapter: "2", visitedAt: T0 + 2000 },
    ]);
  });
});

describe("postHistory / openHistoryInApp", () => {
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("posts the items to /history with the protocol version and reports how many the app took", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return reply(200, { v: 1, accepted: 2 });
    };
    const items = toBridgeItems([visit(1), visit(2)]);
    expect(await postHistory({ port: 18793, fetchImpl }, items)).toEqual({ accepted: 2 });
    expect(seen).toEqual({ url: "http://127.0.0.1:18793/history", body: { v: 1, items } });
  });

  it("answers the app's error code, unreachable when nothing listens, and refuses a bad port", async () => {
    expect(await postHistory({ port: 18793, fetchImpl: async () => reply(404, { code: "not-found", message: "Not found" }) }, [])).toEqual({
      error: { code: "not-found", message: "Not found" },
    });
    const down: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await postHistory({ port: 18793, fetchImpl: down }, [])).toEqual({ error: { code: "unreachable", message: "Cannot reach the app" } });
    expect(await postHistory({ port: 80 }, [])).toMatchObject({ error: { code: "unreachable" } });
  });

  it("asks the app to show the history on /history/open", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return reply(200, { v: 1, ok: true });
    };
    expect(await openHistoryInApp({ port: 18794, fetchImpl })).toEqual({ ok: true });
    expect(seen).toBe("http://127.0.0.1:18794/history/open");
    expect(await openHistoryInApp({ port: 18794, fetchImpl: async () => reply(404, { code: "not-found", message: "x" }) })).toMatchObject({ error: { code: "not-found" } });
  });

  it("explains an app without history support and a closed app in Chinese", () => {
    expect(describeBridgeError({ code: "not-found", message: "" })).toContain("新版本");
    expect(describeBridgeError({ code: "unreachable", message: "" })).toBe("请先打开 RawReader。");
  });
});
