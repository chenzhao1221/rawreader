// RawReader extension: direct API mode. Browser implementation of ImageCodec for the background service worker
// (createImageBitmap and OffscreenCanvas exist there). Not unit-tested: it needs a real browser.
import type { CropRect, ImageCodec } from "./image";

/** Called once for every time the picture bytes are decoded (createImageBitmap), with the time it took. */
export type DecodeProbe = (ms: number) => void;

async function decode(bytes: Uint8Array, probe?: DecodeProbe): Promise<ImageBitmap> {
  const t = performance.now();
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  probe?.(performance.now() - t);
  return bitmap;
}

async function encode(
  bytes: Uint8Array,
  source: CropRect | null,
  width: number,
  height: number,
  quality: number,
  probe?: DecodeProbe,
): Promise<Uint8Array> {
  const bitmap = await decode(bytes, probe);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas in this context");
    // JPEG has no alpha: a transparent PNG would turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    if (source) {
      ctx.drawImage(bitmap, source.x, source.y, source.w, source.h, 0, 0, width, height);
    } else {
      ctx.drawImage(bitmap, 0, 0, width, height);
    }
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** A codec that reports every decode to `probe` (the measurements count them). */
export function createBrowserCodec(probe?: DecodeProbe): ImageCodec {
  return {
    async measure(bytes) {
      const bitmap = await decode(bytes, probe);
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    },

    encodeJpeg: (bytes, width, height, quality) => encode(bytes, null, width, height, quality, probe),

    cropEncodeJpeg: (bytes, rect, width, height, quality) => encode(bytes, rect, width, height, quality, probe),
  };
}

export const browserImageCodec: ImageCodec = createBrowserCodec();
