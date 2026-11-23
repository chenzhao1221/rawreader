import { describe, expect, it, vi } from "vitest";
import { codecFrom } from "./helpers/codec";
import {
  ENCODE_ATTEMPTS,
  ImageTooLargeError,
  MAX_SEND_BYTES,
  fitWithin,
  prepareImage,
  sniffSendMime,
} from "@/lib/direct/image";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("sniffSendMime", () => {
  it("recognises JPEG, PNG and WebP by their first bytes and nothing else", () => {
    expect(sniffSendMime(JPEG)).toBe("image/jpeg");
    expect(sniffSendMime(PNG)).toBe("image/png");
    expect(sniffSendMime(WEBP)).toBe("image/webp");
    expect(sniffSendMime(GIF)).toBeNull();
    expect(sniffSendMime(new Uint8Array(2))).toBeNull();
  });
});

describe("fitWithin", () => {
  it("never enlarges and keeps the aspect ratio", () => {
    expect(fitWithin(800, 1200, 2048)).toEqual({ width: 800, height: 1200 });
    expect(fitWithin(4000, 8000, 2048)).toEqual({ width: 1024, height: 2048 });
    expect(fitWithin(8000, 100, 2048)).toEqual({ width: 2048, height: 26 });
  });
});

const fakeCodec = (size: { width: number; height: number }, encodedSizes: number[]) => {
  let call = 0;
  return codecFrom({
    measure: async () => size,
    encodeJpeg: vi.fn(async () => new Uint8Array(encodedSizes[Math.min(call++, encodedSizes.length - 1)]!)),
    cropEncodeJpeg: async () => new Uint8Array(0),
  });
};

describe("prepareImage", () => {
  it("keeps the original bytes when a supported image is small enough", async () => {
    const codec = fakeCodec({ width: 800, height: 1200 }, [10]);
    const out = await prepareImage(JPEG, codec);
    expect(out).toMatchObject({ mime: "image/jpeg", reencoded: false, width: 800, height: 1200, originalWidth: 800, originalHeight: 1200 });
    expect(out.bytes).toBe(JPEG);
    expect(codec.encodeJpeg).not.toHaveBeenCalled();
  });

  it("re-encodes a format the API may not accept", async () => {
    const codec = fakeCodec({ width: 500, height: 500 }, [100]);
    const out = await prepareImage(GIF, codec);
    expect(out).toMatchObject({ mime: "image/jpeg", reencoded: true, width: 500, height: 500 });
    expect(codec.encodeJpeg).toHaveBeenCalledWith(GIF, 500, 500, ENCODE_ATTEMPTS[0]!.quality);
  });

  it("scales a large image down and reports both sizes", async () => {
    const codec = fakeCodec({ width: 3000, height: 4096 }, [100]);
    const out = await prepareImage(PNG, codec);
    expect(out).toMatchObject({ reencoded: true, width: 2250, height: 3072, originalWidth: 3000, originalHeight: 4096 });
  });

  it("re-encodes an oversized file and steps down until it fits", async () => {
    const codec = fakeCodec({ width: 1000, height: 1000 }, [MAX_SEND_BYTES + 1, MAX_SEND_BYTES + 1, 1000]);
    const big = new Uint8Array(MAX_SEND_BYTES + 5);
    big.set(JPEG);
    const out = await prepareImage(big, codec);
    expect(codec.encodeJpeg).toHaveBeenCalledTimes(3);
    expect(out.reencoded).toBe(true);
    // The third attempt is the first one with a smaller scale.
    expect(out.width).toBe(Math.round(1000 * ENCODE_ATTEMPTS[2]!.scale));
  });

  it("fails with ImageTooLargeError when no attempt fits", async () => {
    const codec = fakeCodec({ width: 1000, height: 1000 }, [MAX_SEND_BYTES + 1]);
    await expect(prepareImage(GIF, codec)).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(codec.encodeJpeg).toHaveBeenCalledTimes(ENCODE_ATTEMPTS.length);
  });
});
