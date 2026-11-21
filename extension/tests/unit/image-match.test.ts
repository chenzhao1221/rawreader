import { describe, expect, it } from "vitest";
import { findImageForSrcUrl, matchRank, normalizeImageUrl, parseSrcset, type ImageLike } from "@/lib/image-match";

const PAGE = "https://reader.example.test/series/1/chapter/2";

function img(init: { src?: string; currentSrc?: string; attrs?: Record<string, string>; tagName?: string }): ImageLike & { id: string } {
  const attrs = init.attrs ?? {};
  const all: Record<string, string> = { ...(init.src ? { src: init.src } : {}), ...attrs };
  return {
    id: Math.random().toString(36).slice(2),
    tagName: init.tagName ?? "IMG",
    src: init.src,
    currentSrc: init.currentSrc,
    getAttribute: (name) => all[name] ?? null,
  };
}

describe("normalizeImageUrl", () => {
  it("resolves relative URLs against the page and drops the fragment", () => {
    expect(normalizeImageUrl("/pages/1.jpg#top", PAGE)).toBe("https://reader.example.test/pages/1.jpg");
    expect(normalizeImageUrl("//cdn.example.test/a.png", PAGE)).toBe("https://cdn.example.test/a.png");
  });
  it("keeps the query string, so two sizes of one image stay different", () => {
    expect(normalizeImageUrl("https://cdn.example.test/a.jpg?w=100", PAGE)).not.toBe(normalizeImageUrl("https://cdn.example.test/a.jpg?w=200", PAGE));
  });
  it("keeps data and blob URLs as they are", () => {
    expect(normalizeImageUrl("data:image/png;base64,AAAA", PAGE)).toBe("data:image/png;base64,AAAA");
    expect(normalizeImageUrl("blob:https://reader.example.test/abc", PAGE)).toBe("blob:https://reader.example.test/abc");
  });
  it("returns null for empty input", () => {
    expect(normalizeImageUrl("  ", PAGE)).toBeNull();
    expect(normalizeImageUrl(null, PAGE)).toBeNull();
  });
});

describe("parseSrcset", () => {
  it("drops descriptors", () => {
    expect(parseSrcset("a.jpg 1x, b.jpg 2x")).toEqual(["a.jpg", "b.jpg"]);
    expect(parseSrcset("a.jpg 480w,b.jpg 800w")).toEqual(["a.jpg", "b.jpg"]);
  });
  it("handles a single URL and empty values", () => {
    expect(parseSrcset("a.jpg")).toEqual(["a.jpg"]);
    expect(parseSrcset("")).toEqual([]);
    expect(parseSrcset(null)).toEqual([]);
  });
});

describe("matchRank", () => {
  const url = "https://cdn.example.test/p/1.jpg";
  it("ranks the shown URL first", () => {
    expect(matchRank(img({ src: url }), url, PAGE)).toBe(0);
    expect(matchRank(img({ src: "/placeholder.gif", currentSrc: url }), url, PAGE)).toBe(0);
  });
  it("matches a relative src against an absolute menu URL", () => {
    expect(matchRank(img({ src: "/p/1.jpg" }), "https://reader.example.test/p/1.jpg", PAGE)).toBe(0);
  });
  it("matches lazy-load attributes", () => {
    for (const name of ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"]) {
      expect(matchRank(img({ src: "data:image/gif;base64,R0lGOD", attrs: { [name]: url } }), url, PAGE)).toBe(1);
    }
  });
  it("matches srcset and data-srcset entries", () => {
    expect(matchRank(img({ attrs: { srcset: `${url} 1x, https://cdn.example.test/p/1@2x.jpg 2x` } }), url, PAGE)).toBe(2);
    expect(matchRank(img({ attrs: { "data-srcset": `${url} 800w` } }), url, PAGE)).toBe(2);
  });
  it("returns the best rank when several attributes match", () => {
    expect(matchRank(img({ src: url, attrs: { "data-src": url, srcset: url } }), url, PAGE)).toBe(0);
  });
  it("returns null when nothing matches", () => {
    expect(matchRank(img({ src: "https://cdn.example.test/p/2.jpg" }), url, PAGE)).toBeNull();
    expect(matchRank(img({ src: url }), "", PAGE)).toBeNull();
  });
});

describe("findImageForSrcUrl", () => {
  const url = "https://cdn.example.test/p/1.jpg";

  it("finds the image by its shown URL", () => {
    const a = img({ src: "https://cdn.example.test/p/0.jpg" });
    const b = img({ src: url });
    expect(findImageForSrcUrl([a, b], url, PAGE)).toBe(b);
  });

  it("finds a lazy-load image whose real URL is still in data-src", () => {
    const a = img({ src: "data:image/gif;base64,R0lGOD", attrs: { "data-src": "https://cdn.example.test/p/0.jpg" } });
    const b = img({ src: "data:image/gif;base64,R0lGOD", attrs: { "data-src": url } });
    expect(findImageForSrcUrl([a, b], url, PAGE)).toBe(b);
  });

  it("prefers an image that shows the URL over one that only lists it in a lazy attribute", () => {
    const lazy = img({ src: "/blank.gif", attrs: { "data-src": url } });
    const shown = img({ src: url });
    expect(findImageForSrcUrl([lazy, shown], url, PAGE)).toBe(shown);
  });

  it("uses the right-clicked element when two images share the URL", () => {
    const first = img({ src: url });
    const second = img({ src: url });
    expect(findImageForSrcUrl([first, second], url, PAGE, second)).toBe(second);
    expect(findImageForSrcUrl([first, second], url, PAGE)).toBe(first);
  });

  it("ignores the right-clicked element when it shows another image", () => {
    const other = img({ src: "https://cdn.example.test/p/9.jpg" });
    const wanted = img({ src: url });
    expect(findImageForSrcUrl([other, wanted], url, PAGE, other)).toBe(wanted);
  });

  it("falls back to the right-clicked <img> when no URL matches", () => {
    const clicked = img({ src: "https://cdn.example.test/p/rewritten.jpg" });
    expect(findImageForSrcUrl([clicked], url, PAGE, clicked)).toBe(clicked);
  });

  it("does not fall back to a right-clicked element that is not an <img>", () => {
    const clicked = img({ src: "https://cdn.example.test/p/rewritten.jpg", tagName: "DIV" });
    expect(findImageForSrcUrl([clicked], url, PAGE, clicked)).toBeNull();
  });

  it("returns null when nothing matches and nothing was right-clicked", () => {
    expect(findImageForSrcUrl([img({ src: "https://cdn.example.test/p/2.jpg" })], url, PAGE)).toBeNull();
    expect(findImageForSrcUrl([], url, PAGE)).toBeNull();
  });
});
