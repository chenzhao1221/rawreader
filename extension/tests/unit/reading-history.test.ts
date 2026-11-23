import { beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_MAX_ENTRIES,
  SerialQueue,
  groupHistory,
  isSafeHistoryUrl,
  normalizeHistoryUrl,
  parseHistory,
  removeHistoryEntry,
  searchHistory,
  touchHistory,
  type HistoryEntry,
} from "@/lib/reading-history";

let counter = 0;
const makeId = () => `id-${++counter}`;
beforeEach(() => {
  counter = 0;
});
const MIN = 60_000;
const T0 = new Date(2026, 10, 23, 12, 0, 0).getTime();

const touch = (list: HistoryEntry[], url: string, now: number, extra: { title?: string; series?: string; chapter?: string } = {}) =>
  touchHistory(list, { url, title: extra.title ?? "", series: extra.series, chapter: extra.chapter }, { now, makeId });

describe("normalizeHistoryUrl", () => {
  it("drops the fragment and tracking parameters but keeps the others", () => {
    expect(normalizeHistoryUrl("https://reader.example.com/read?chapter=12&page=3&utm_source=x&utm_medium=y&fbclid=abc&gclid=def#frag")).toBe(
      "https://reader.example.com/read?chapter=12&page=3",
    );
    expect(normalizeHistoryUrl("https://reader.example.com/read?UTM_Campaign=a")).toBe("https://reader.example.com/read");
  });
  it("accepts only http and https", () => {
    expect(normalizeHistoryUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(normalizeHistoryUrl("ftp://example.com/a")).toBeNull();
    expect(normalizeHistoryUrl("chrome://settings")).toBeNull();
    expect(normalizeHistoryUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHistoryUrl("not a url")).toBeNull();
  });
  it("refuses an address longer than 2048 characters", () => {
    expect(normalizeHistoryUrl(`https://example.com/${"a".repeat(2100)}`)).toBeNull();
  });
  it("tells safe addresses to open from unsafe ones", () => {
    expect(isSafeHistoryUrl("https://example.com/x")).toBe(true);
    expect(isSafeHistoryUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHistoryUrl("file:///etc/hosts")).toBe(false);
  });
});

describe("touchHistory: the same address", () => {
  it("makes a new entry with the fields of the plan", () => {
    const list = touch([], "https://www.example.com/read/1#top", T0, { title: "  Sample   Title ", series: "Series A", chapter: "1" });
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: "id-1",
      url: "https://www.example.com/read/1",
      title: "Sample Title",
      site: "www.example.com",
      series: "Series A",
      chapter: "1",
      firstVisitedAt: T0,
      lastVisitedAt: T0,
      visits: 1,
    });
  });

  it("counts a visit, updates the title and moves the entry to the front", () => {
    let list = touch([], "https://example.com/a", T0, { title: "A" });
    list = touch(list, "https://example.com/b", T0 + 1000, { title: "B" });
    list = touch(list, "https://example.com/a#x", T0 + 60_000, { title: "A (new)" });
    expect(list.map((e) => e.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(list[0]).toMatchObject({ title: "A (new)", visits: 2, firstVisitedAt: T0, lastVisitedAt: T0 + 60_000 });
  });

  it("ignores the same address touched again within five seconds", () => {
    const list = touch([], "https://example.com/a", T0);
    expect(touch(list, "https://example.com/a", T0 + 4_000)).toBe(list);
    expect(touch(list, "https://example.com/a", T0 + 5_000)).not.toBe(list);
  });

  it("ignores an address that cannot be stored", () => {
    const list = touch([], "https://example.com/a", T0);
    expect(touch(list, "chrome://extensions", T0 + 1)).toBe(list);
  });
});

describe("touchHistory: pages of one chapter", () => {
  const page = (n: number) => `https://reader.example.com/series-a/ch-3/${n}`;

  it("merges reads of the same site, series and chapter within 30 minutes into one entry at the newest page", () => {
    let list = touch([], page(1), T0, { series: "Series A", chapter: "3", title: "p1" });
    list = touch(list, page(2), T0 + 5 * MIN, { series: "Series A", chapter: "3", title: "p2" });
    list = touch(list, page(7), T0 + 20 * MIN, { series: "Series A", chapter: "3", title: "p7" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ url: page(7), title: "p7", visits: 3, firstVisitedAt: T0, lastVisitedAt: T0 + 20 * MIN });
  });

  it("measures the 30 minutes from the last read, so a long read keeps merging", () => {
    let list = touch([], page(1), T0, { series: "Series A", chapter: "3" });
    for (let i = 2; i <= 6; i++) list = touch(list, page(i), T0 + (i - 1) * 20 * MIN, { series: "Series A", chapter: "3" });
    expect(list).toHaveLength(1);
  });

  it("starts a new entry after 30 minutes, for another chapter, or for another site", () => {
    let list = touch([], page(1), T0, { series: "Series A", chapter: "3" });
    list = touch(list, page(2), T0 + 31 * MIN, { series: "Series A", chapter: "3" });
    expect(list).toHaveLength(2);
    list = touch(list, "https://reader.example.com/series-a/ch-4/1", T0 + 32 * MIN, { series: "Series A", chapter: "4" });
    expect(list).toHaveLength(3);
    list = touch(list, "https://other.example.org/series-a/ch-4/1", T0 + 33 * MIN, { series: "Series A", chapter: "4" });
    expect(list).toHaveLength(4);
  });

  it("does not merge when no site rule gave a series and chapter, only the address decides", () => {
    let list = touch([], page(1), T0);
    list = touch(list, page(2), T0 + MIN);
    list = touch(list, page(3), T0 + 2 * MIN, { series: "Series A" });
    expect(list).toHaveLength(3);
  });
});

describe("touchHistory: the limit", () => {
  it("keeps the newest 1000 and drops the oldest by last visit", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 3; i++) list = touch(list, `https://example.com/page/${i}`, T0 + i * 10_000);
    expect(list).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(list[0]!.url).toBe(`https://example.com/page/${HISTORY_MAX_ENTRIES + 2}`);
    expect(list.some((e) => e.url.endsWith("/page/0"))).toBe(false);
    expect(list.some((e) => e.url.endsWith("/page/2"))).toBe(false);
    expect(list.some((e) => e.url.endsWith("/page/3"))).toBe(true);
  });

  it("a revisit of an old entry keeps it and drops a different old one", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) list = touchHistory(list, { url: `https://example.com/p/${i}` }, { now: T0 + i * 10_000, makeId, max: 5 });
    list = touchHistory(list, { url: "https://example.com/p/0" }, { now: T0 + 100_000, makeId, max: 5 });
    list = touchHistory(list, { url: "https://example.com/p/new" }, { now: T0 + 110_000, makeId, max: 5 });
    expect(list.map((e) => e.url.split("/").pop())).toEqual(["new", "0", "4", "3", "2"]);
  });
});

describe("searchHistory", () => {
  const list = [
    touch([], "https://www.example.com/read/1", T0, { title: "Alpha Chapter One", series: "Alpha" }),
    touch([], "https://manga.example.org/b/2", T0, { title: "Beta Part Two", series: "Beta Quest" }),
  ].flat();

  it("matches title, address, site and series without regard to case", () => {
    expect(searchHistory(list, "alpha chapter").map((e) => e.title)).toEqual(["Alpha Chapter One"]);
    expect(searchHistory(list, "MANGA.EXAMPLE").map((e) => e.site)).toEqual(["manga.example.org"]);
    expect(searchHistory(list, "/b/2")).toHaveLength(1);
    expect(searchHistory(list, "quest")).toHaveLength(1);
    expect(searchHistory(list, "example")).toHaveLength(2);
  });
  it("needs every word to match, and an empty query shows everything", () => {
    expect(searchHistory(list, "alpha beta")).toHaveLength(0);
    expect(searchHistory(list, "  ")).toHaveLength(2);
    expect(searchHistory(list, "nothing")).toHaveLength(0);
  });
});

describe("remove, clear, group and parse", () => {
  it("removes one entry by id and leaves the others", () => {
    let list = touch([], "https://example.com/a", T0);
    list = touch(list, "https://example.com/b", T0 + 1000);
    const gone = list[1]!.id;
    expect(removeHistoryEntry(list, gone).map((e) => e.url)).toEqual(["https://example.com/b"]);
    expect(removeHistoryEntry(list, "missing")).toHaveLength(2);
  });

  it("groups into today, yesterday and earlier by local day", () => {
    const now = new Date(2026, 10, 23, 15, 0, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime();
    let list: HistoryEntry[] = [];
    list = touch(list, "https://example.com/old", at(10, 9));
    list = touch(list, "https://example.com/yesterday-late", at(22, 23));
    list = touch(list, "https://example.com/today-early", at(23, 0));
    list = touch(list, "https://example.com/today", at(23, 14));
    const groups = groupHistory(list, now);
    expect(groups.map((g) => g.name)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0]!.entries.map((e) => e.url.split("/").pop())).toEqual(["today", "today-early"]);
    expect(groups[1]!.entries.map((e) => e.url.split("/").pop())).toEqual(["yesterday-late"]);
    expect(groups[2]!.entries.map((e) => e.url.split("/").pop())).toEqual(["old"]);
  });

  it("leaves out empty groups", () => {
    expect(groupHistory([], T0)).toEqual([]);
  });

  it("parses what storage gives back and drops entries of the wrong shape", () => {
    expect(parseHistory(undefined)).toEqual([]);
    expect(parseHistory("x")).toEqual([]);
    const out = parseHistory([{ id: "a", url: "https://example.com/a", lastVisitedAt: 5 }, { id: 3 }, null, { url: "x" }]);
    expect(out).toEqual([{ id: "a", url: "https://example.com/a", title: "", site: "", series: "", chapter: "", firstVisitedAt: 5, lastVisitedAt: 5, visits: 1 }]);
  });
});

describe("SerialQueue (all writes go through one queue)", () => {
  it("keeps both entries when two writes arrive at the same time", async () => {
    let stored: HistoryEntry[] = [];
    const queue = new SerialQueue();
    const slowTouch = (url: string) =>
      queue.run(async () => {
        const read = stored; // read
        await new Promise((resolve) => setTimeout(resolve, 5)); // another tab's write would land here without the queue
        stored = touch(read, url, T0 + stored.length * 10_000);
      });
    await Promise.all([slowTouch("https://example.com/one"), slowTouch("https://example.com/two")]);
    expect(stored.map((e) => e.url).sort()).toEqual(["https://example.com/one", "https://example.com/two"]);
  });

  it("without the queue the same two writes would lose one (the reason for the queue)", async () => {
    let stored: HistoryEntry[] = [];
    const racy = async (url: string) => {
      const read = stored;
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = touch(read, url, T0);
    };
    await Promise.all([racy("https://example.com/one"), racy("https://example.com/two")]);
    expect(stored).toHaveLength(1);
  });

  it("keeps going after a task fails", async () => {
    const queue = new SerialQueue();
    await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run(async () => 7)).resolves.toBe(7);
  });
});
