// RawReader extension: direct API mode. Browser implementation of ImageCodec for the background service worker
// (createImageBitmap and OffscreenCanvas exist there). Not unit-tested: it needs a real browser.
import type { CropRect, ImageCodec } from "./image";

async function encode(
  bytes: Uint8Array,
  source: CropRect | null,
  width: number,
  height: number,
  quality: number,
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
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

export const browserImageCodec: ImageCodec = {
  async measure(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  },

  encodeJpeg: (bytes, width, height, quality) => encode(bytes, null, width, height, quality),

  cropEncodeJpeg: (bytes, rect, width, height, quality) => encode(bytes, rect, width, height, quality),
};
