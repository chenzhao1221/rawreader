import { describe, expect, it } from "vitest";
import { SerialQueue, isSafeHistoryUrl, normalizeHistoryUrl, parseHistory } from "@/lib/reading-history";
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

describe("parseHistory (the legacy list)", () => {
  it("parses what storage gives back and drops entries of the wrong shape", () => {
    expect(parseHistory(undefined)).toEqual([]);
    expect(parseHistory("x")).toEqual([]);
    const out = parseHistory([{ id: "a", url: "https://example.com/a", lastVisitedAt: 5 }, { id: 3 }, null, { url: "x" }]);
    expect(out).toEqual([{ id: "a", url: "https://example.com/a", title: "", site: "", series: "", chapter: "", firstVisitedAt: 5, lastVisitedAt: 5, visits: 1 }]);
  });
});

describe("SerialQueue (all writes go through one queue)", () => {
  it("keeps both changes when two writes arrive at the same time", async () => {
    let stored: string[] = [];
    const queue = new SerialQueue();
    const slowAdd = (url: string) =>
      queue.run(async () => {
        const read = stored; // read
        await new Promise((resolve) => setTimeout(resolve, 5)); // another tab's write would land here without the queue
        stored = [...read, url];
      });
    await Promise.all([slowAdd("https://example.com/one"), slowAdd("https://example.com/two")]);
    expect([...stored].sort()).toEqual(["https://example.com/one", "https://example.com/two"]);
  });

  it("without the queue the same two writes would lose one (the reason for the queue)", async () => {
    let stored: string[] = [];
    const racy = async (url: string) => {
      const read = stored;
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = [...read, url];
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