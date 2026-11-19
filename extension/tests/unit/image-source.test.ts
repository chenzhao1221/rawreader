import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_QUALITIES,
  ImageUnavailableError,
  MAX_IMAGE_MESSAGE_BYTES,
  acquireImageDataUrl,
  dataUrlByteLength,
  type ImageSourceDeps,
  type ImageStepName,
} from "@/lib/image-source";
import { dataUrlToBytes } from "@/lib/bridge/client";

const IMAGE = "https://img.example.test/chapter/001.jpg?token=secret";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);

const respond = (body: Uint8Array | string, init: ResponseInit & { type?: string } = {}) =>
  new Response(body as BodyInit, { status: 200, headers: { "content-type": init.type ?? "image/jpeg" }, ...init });

/** Records the failed steps the way the content script logs them. */
function harness(deps: ImageSourceDeps) {
  const logged: Array<[ImageStepName, string]> = [];
  const log = vi.fn((step: ImageStepName, reason: string) => void logged.push([step, reason]));
  return { deps: { ...deps, log }, logged };
}

describe("acquireImageDataUrl: step 1 (canvas)", () => {
  it("uses the drawn element and makes no request", async () => {
    const fetchImpl = vi.fn();
    const background = vi.fn();
    const { deps, logged } = harness({ readElement: () => "data:image/jpeg;base64,AAAA", fetchImpl, background });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got).toEqual({ dataUrl: "data:image/jpeg;base64,AAAA", step: "canvas" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(background).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("lowers the JPEG quality until the result fits in a message", async () => {
    const big = `data:image/jpeg;base64,${"A".repeat(Math.ceil(((MAX_IMAGE_MESSAGE_BYTES + 1000) * 4) / 3))}`;
    const readElement = vi.fn((quality: number) => (quality > 0.9 ? big : "data:image/jpeg;base64,AAAA"));
    const { deps } = harness({ readElement });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got.step).toBe("canvas");
    expect(readElement.mock.calls.map((c) => c[0])).toEqual([CANVAS_QUALITIES[0], CANVAS_QUALITIES[1]]);
  });

  it("moves on when the canvas is tainted", async () => {
    const readElement = () => {
      throw new DOMException("The canvas has been tainted by cross-origin data.", "SecurityError");
    };
    const fetchImpl = vi.fn(async () => respond(JPEG));
    const { deps, logged } = harness({ readElement, fetchImpl });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got.step).toBe("page-fetch");
    expect(logged).toEqual([["canvas", expect.stringContaining("tainted")]]);
  });
});

describe("acquireImageDataUrl: step 2 (page fetch)", () => {
  const tainted = () => {
    throw new Error("tainted");
  };

  it("fetches with the page's cookies and answers the bytes as a data URL", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => respond(PNG, { type: "image/png" }));
    const { deps } = harness({ readElement: tainted, fetchImpl });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got.step).toBe("page-fetch");
    expect(got.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(Array.from(dataUrlToBytes(got.dataUrl)!)).toEqual(Array.from(PNG));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(IMAGE);
    expect(fetchImpl.mock.calls[0]![1]?.credentials).toBe("include");
  });

  it("names the type from the bytes, not from the header", async () => {
    const fetchImpl = async () => respond(JPEG, { type: "application/octet-stream" });
    const { deps } = harness({ readElement: tainted, fetchImpl });
    expect((await acquireImageDataUrl(IMAGE, deps)).dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("retries without credentials when the credentialed request is refused by CORS", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.credentials === "include") throw new TypeError("Failed to fetch");
      return respond(JPEG);
    });
    const { deps } = harness({ readElement: tainted, fetchImpl });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got.step).toBe("page-fetch");
    expect(fetchImpl.mock.calls.map((c) => c[1]?.credentials)).toEqual(["include", "omit"]);
  });

  it("does not retry after a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    });
    const background = vi.fn(async () => "data:image/jpeg;base64,BBBB");
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, background });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(got.step).toBe("background");
    expect(logged[1]).toEqual(["page-fetch", "timed out"]);
  });

  it("rejects an HTML challenge page that answers 200", async () => {
    const fetchImpl = async () => respond("<html>Just a moment...</html>", { type: "text/html; charset=utf-8" });
    const background = vi.fn(async () => "data:image/jpeg;base64,BBBB");
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, background });
    await acquireImageDataUrl(IMAGE, deps);
    expect(logged[1]).toEqual(["page-fetch", "the response is not an image (text/html)"]);
    expect(background).toHaveBeenCalledTimes(1);
  });

  it("rejects an error status and reports it", async () => {
    const fetchImpl = async () => new Response("no", { status: 403, statusText: "Forbidden" });
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, background: async () => "data:image/jpeg;base64,BBBB" });
    await acquireImageDataUrl(IMAGE, deps);
    expect(logged[1]).toEqual(["page-fetch", "HTTP 403 Forbidden"]);
  });

  it("re-encodes a format the backends do not take (gif) as JPEG", async () => {
    const reencodeJpeg = vi.fn(async () => JPEG);
    const fetchImpl = async () => respond(GIF, { type: "image/gif" });
    const { deps } = harness({ readElement: tainted, fetchImpl, reencodeJpeg });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got.step).toBe("page-fetch");
    expect(got.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(reencodeJpeg).toHaveBeenCalledTimes(1);
  });

  it("re-encodes an image above the message limit with falling quality", async () => {
    const big = new Uint8Array(MAX_IMAGE_MESSAGE_BYTES + 10);
    big.set(JPEG);
    const reencodeJpeg = vi.fn(async (_bytes: Uint8Array, quality: number) => (quality > 0.9 ? big : JPEG));
    const fetchImpl = async () => respond(big);
    const { deps } = harness({ readElement: tainted, fetchImpl, reencodeJpeg });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(got.step).toBe("page-fetch");
    expect(reencodeJpeg.mock.calls.map((c) => c[1])).toEqual([CANVAS_QUALITIES[0], CANVAS_QUALITIES[1]]);
    expect(dataUrlByteLength(got.dataUrl)).toBeLessThan(100);
  });

  it("fails the step when the bytes cannot be decoded", async () => {
    const reencodeJpeg = async () => {
      throw new Error("The source image could not be decoded.");
    };
    const fetchImpl = async () => respond(GIF, { type: "image/gif" });
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, reencodeJpeg });
    await expect(acquireImageDataUrl(IMAGE, deps)).rejects.toBeInstanceOf(ImageUnavailableError);
    expect(logged[1]![1]).toContain("could not be decoded");
  });

  it("skips an address the page cannot fetch", async () => {
    const fetchImpl = vi.fn();
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, background: async () => "data:image/jpeg;base64,BBBB" });
    await acquireImageDataUrl("ftp://img.example.test/a.jpg", deps);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged[1]![0]).toBe("page-fetch");
  });
});

describe("acquireImageDataUrl: step 3 (background) and the final error", () => {
  const tainted = () => {
    throw new Error("tainted");
  };

  it("asks the background worker last, with the original address", async () => {
    const order: string[] = [];
    const readElement = () => {
      order.push("canvas");
      throw new Error("tainted");
    };
    const fetchImpl = async () => {
      order.push("page-fetch");
      return new Response("no", { status: 403, statusText: "Forbidden" });
    };
    const background = vi.fn(async (_url: string) => {
      order.push("background");
      return "data:image/jpeg;base64,CCCC";
    });
    const { deps } = harness({ readElement, fetchImpl, background });
    const got = await acquireImageDataUrl(IMAGE, deps);
    expect(order).toEqual(["canvas", "page-fetch", "background"]);
    expect(got).toEqual({ dataUrl: "data:image/jpeg;base64,CCCC", step: "background" });
    expect(background).toHaveBeenCalledWith(IMAGE);
  });

  it("throws image-unavailable material with the last step's reason when all three fail", async () => {
    const fetchImpl = async () => new Response("no", { status: 403, statusText: "Forbidden" });
    const background = async () => {
      throw new Error("HTTP 503 Service Unavailable");
    };
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, background });
    const error = (await acquireImageDataUrl(IMAGE, deps).catch((e: unknown) => e)) as ImageUnavailableError;
    expect(error).toBeInstanceOf(ImageUnavailableError);
    expect(error.message).toBe("HTTP 503 Service Unavailable");
    expect(error.failures.map((f) => f.step)).toEqual(["canvas", "page-fetch", "background"]);
    expect(logged.map(([step]) => step)).toEqual(["canvas", "page-fetch", "background"]);
  });

  it("keeps URLs and query strings out of the reasons it records", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    const background = async () => {
      throw new Error("HTTP 404 Not Found");
    };
    const { deps, logged } = harness({ readElement: tainted, fetchImpl, background });
    await acquireImageDataUrl(IMAGE, deps).catch(() => {});
    for (const [, reason] of logged) {
      expect(reason).not.toContain("token=secret");
      expect(reason).not.toContain("img.example.test");
    }
  });

  it("fails cleanly when a step has no implementation", async () => {
    const error = (await acquireImageDataUrl(IMAGE, {}).catch((e: unknown) => e)) as ImageUnavailableError;
    expect(error).toBeInstanceOf(ImageUnavailableError);
    expect(error.failures).toHaveLength(3);
  });
});

describe("dataUrlByteLength", () => {
  it("estimates the decoded size", () => {
    expect(dataUrlByteLength("data:image/jpeg;base64,AAAA")).toBe(3);
    expect(dataUrlByteLength("data:image/jpeg;base64,")).toBe(0);
  });
});
