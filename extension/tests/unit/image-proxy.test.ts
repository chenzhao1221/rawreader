import { describe, expect, it, vi } from "vitest";
import {
  ImageDownloadError,
  ImageFetchError,
  PROXY_RULE_ID_BASE,
  proxyFetch,
  refererRule,
  type SessionRuleApi,
} from "@/lib/image-proxy";

const IMAGE = "https://img.example.test/chapter/001.jpg?token=secret";
const PAGE = "https://reader.example.test/series/chapter-1";

/** Session rules kept the way Chrome keeps them: updateSessionRules removes by id, then adds. */
function fakeDnr() {
  const rules = new Map<number, ReturnType<typeof refererRule>>();
  const dnr: SessionRuleApi = {
    updateSessionRules: vi.fn(async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: unknown[] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules as ReturnType<typeof refererRule>[]) rules.set(rule.id, rule);
    }),
  };
  return { dnr, rules };
}

/** Answers like a hotlink-protected host: 200 only when a session rule sets the Referer for this URL. */
function hotlinkFetch(rules: Map<number, ReturnType<typeof refererRule>>) {
  return async (url: string): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rule = [...rules.values()].find((r) => url.startsWith(r.condition.urlFilter));
    if (!rule) return new Response("denied", { status: 403, statusText: "Forbidden" });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
}

describe("refererRule", () => {
  it("sets Referer for the image URL without its query string", () => {
    const rule = refererRule(PROXY_RULE_ID_BASE, IMAGE, PAGE);
    expect(rule.id).toBe(PROXY_RULE_ID_BASE);
    expect(rule.action.requestHeaders).toEqual([{ header: "Referer", operation: "set", value: PAGE }]);
    expect(rule.condition.urlFilter).toBe("https://img.example.test/chapter/001.jpg");
  });
});

describe("proxyFetch", () => {
  it("sends the page Referer with the image request", async () => {
    const { dnr, rules } = fakeDnr();
    const bytes = await proxyFetch(IMAGE, PAGE, { dnr, fetchImpl: hotlinkFetch(rules) });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(rules.size).toBe(0);
  });

  it("keeps every parallel fetch's Referer rule in place", async () => {
    const { dnr, rules } = fakeDnr();
    const urls = [1, 2, 3, 4].map((n) => `https://img.example.test/chapter/00${n}.jpg`);
    const results = await Promise.all(urls.map((url) => proxyFetch(url, PAGE, { dnr, fetchImpl: hotlinkFetch(rules) })));
    expect(results).toHaveLength(4);
    expect(rules.size).toBe(0);
  });

  it("uses a different rule id for each fetch that is in flight at the same time", async () => {
    const { dnr } = fakeDnr();
    const ids = new Set<number>();
    const fetchImpl = async () => {
      const added = vi.mocked(dnr.updateSessionRules).mock.calls.flatMap(([o]) => (o.addRules ?? []) as { id: number }[]);
      for (const rule of added) ids.add(rule.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(new Uint8Array(1), { status: 200 });
    };
    await Promise.all([1, 2].map((n) => proxyFetch(`https://img.example.test/${n}.jpg`, PAGE, { dnr, fetchImpl })));
    expect(ids.size).toBe(2);
  });

  it("does not touch session rules when there is no Referer", async () => {
    const { dnr } = fakeDnr();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(1), { status: 200 }));
    await proxyFetch(IMAGE, undefined, { dnr, fetchImpl });
    expect(dnr.updateSessionRules).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(IMAGE);
  });

  it("throws ImageFetchError with the HTTP status and no URL", async () => {
    const { dnr } = fakeDnr();
    const fetchImpl = async () => new Response("denied", { status: 403, statusText: "Forbidden" });
    const error = await proxyFetch(IMAGE, PAGE, { dnr, fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageFetchError);
    expect((error as ImageFetchError).status).toBe(403);
    expect((error as Error).message).toBe("HTTP 403 Forbidden");
    expect((error as Error).message).not.toContain("example.test");
  });

  it("removes its rule and frees the id when the fetch fails", async () => {
    const { dnr, rules } = fakeDnr();
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(proxyFetch(IMAGE, PAGE, { dnr, fetchImpl })).rejects.toThrow("Failed to fetch");
    expect(rules.size).toBe(0);
    // The id is free again, so the next fetch gets the first id of the range.
    const ids: number[] = [];
    const ok = async () => {
      ids.push(...((vi.mocked(dnr.updateSessionRules).mock.lastCall?.[0].addRules ?? []) as { id: number }[]).map((r) => r.id));
      return new Response(new Uint8Array(1), { status: 200 });
    };
    await proxyFetch(IMAGE, PAGE, { dnr, fetchImpl: ok });
    expect(ids).toEqual([PROXY_RULE_ID_BASE]);
  });

  it("still fetches when the rule cannot be set", async () => {
    const dnr: SessionRuleApi = { updateSessionRules: vi.fn(async () => Promise.reject(new Error("quota"))) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(1), { status: 200 }));
    await proxyFetch(IMAGE, PAGE, { dnr, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("ImageDownloadError", () => {
  it("keeps the message of the failure it wraps", () => {
    expect(new ImageDownloadError(new Error("HTTP 404 Not Found")).message).toBe("HTTP 404 Not Found");
    expect(new ImageDownloadError("plain").message).toBe("plain");
  });
});
