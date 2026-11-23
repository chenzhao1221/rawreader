// RawReader extension: direct API mode. Browser implementation of ImageCodec for the background service worker
// (createImageBitmap and OffscreenCanvas exist there). Not unit-tested: it needs a real browser.
import type { CropRect, DecodedImage, ImageCodec } from "./image";

/** Called once for every time the picture bytes are decoded (createImageBitmap), with the time it took. */
export type DecodeProbe = (ms: number) => void;

async function decode(bytes: Uint8Array, probe?: DecodeProbe): Promise<ImageBitmap> {
  const t = performance.now();
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  probe?.(performance.now() - t);
  return bitmap;
}

/** Draws (a part of) a decoded picture at the given size on white and encodes it as JPEG. */
async function encodeBitmap(bitmap: ImageBitmap, source: CropRect | null, width: number, height: number, quality: number): Promise<Uint8Array> {
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
}

/** A codec that reports every decode to `probe` (the measurements count them). */
export function createBrowserCodec(probe?: DecodeProbe): ImageCodec {
  return {
    /** One decode; every crop and encode of the returned picture draws from the same bitmap. */
    async open(bytes): Promise<DecodedImage> {
      const bitmap = await decode(bytes, probe);
      let closed = false;
      const live = (): ImageBitmap => {
        if (closed) throw new Error("The picture was already released");
        return bitmap;
      };
      return {
        width: bitmap.width,
        height: bitmap.height,
        encodeJpeg: (width, height, quality) => encodeBitmap(live(), null, width, height, quality),
        cropEncodeJpeg: (rect, width, height, quality) => encodeBitmap(live(), rect, width, height, quality),
        close() {
          if (closed) return;
          closed = true;
          bitmap.close();
        },
      };
    },

    // The one-shot forms stay for callers that need a single operation (the page re-encodes an oversize image).
    async measure(bytes) {
      const bitmap = await decode(bytes, probe);
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    },

    async encodeJpeg(bytes, width, height, quality) {
      const bitmap = await decode(bytes, probe);
      try {
        return await encodeBitmap(bitmap, null, width, height, quality);
      } finally {
        bitmap.close();
      }
    },

    async cropEncodeJpeg(bytes, rect, width, height, quality) {
      const bitmap = await decode(bytes, probe);
      try {
        return await encodeBitmap(bitmap, rect, width, height, quality);
      } finally {
        bitmap.close();
      }
    },
  };
}

export const browserImageCodec: ImageCodec = createBrowserCodec();
