// Test helper: a fake ImageCodec built from three plain functions, with counters for `open` and `close`.
import type { CropRect, DecodedImage, ImageCodec } from "@/lib/direct/image";

export interface CodecParts {
  measure: (bytes: Uint8Array) => Promise<{ width: number; height: number }>;
  encodeJpeg: (bytes: Uint8Array, width: number, height: number, quality: number) => Promise<Uint8Array>;
  cropEncodeJpeg: (bytes: Uint8Array, rect: CropRect, width: number, height: number, quality: number) => Promise<Uint8Array>;
}

export type CountingCodec = ImageCodec & { opened: number; closed: number };

/**
 * `open` runs `measure` once (that is the decode) and hands back a picture whose encodes go to the given functions with
 * the original bytes, so the tests keep asserting on the arguments they always did. `opened` and `closed` count the calls.
 */
export function codecFrom(parts: CodecParts): CountingCodec {
  const codec: CountingCodec = {
    opened: 0,
    closed: 0,
    ...parts,
    async open(bytes) {
      codec.opened += 1;
      const size = await parts.measure(bytes);
      let closed = false;
      const image: DecodedImage = {
        width: size.width,
        height: size.height,
        encodeJpeg: (width, height, quality) => parts.encodeJpeg(bytes, width, height, quality),
        cropEncodeJpeg: (rect, width, height, quality) => parts.cropEncodeJpeg(bytes, rect, width, height, quality),
        close() {
          if (closed) return;
          closed = true;
          codec.closed += 1;
        },
      };
      return image;
    },
  };
  return codec;
}
