// RawReader extension: direct API mode. Shrinks the image before it is sent. The decision logic is pure;
// decoding and encoding come in through `ImageCodec` (the browser one is in image-browser.ts).

/** Longest side sent to the model. Vision models downscale larger images themselves, so more only costs bytes. */
export const MAX_SEND_SIDE = 3072;

/** Largest file sent. Base64 adds a third, and some services reject request images above about 5 MB. */
export const MAX_SEND_BYTES = 3_500_000;

export type SendMime = "image/jpeg" | "image/png" | "image/webp";

/** MIME type from the first bytes, or null for a format that has to be re-encoded (gif, avif, bmp, unknown). */
export function sniffSendMime(bytes: Uint8Array): SendMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Size after scaling so the longest side is at most `maxSide`. Never enlarges. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Re-encode attempts in order: each one is smaller than the one before. */
export const ENCODE_ATTEMPTS: ReadonlyArray<{ scale: number; quality: number }> = [
  { scale: 1, quality: 0.9 },
  { scale: 1, quality: 0.7 },
  { scale: 0.75, quality: 0.7 },
  { scale: 0.5, quality: 0.6 },
  { scale: 0.35, quality: 0.5 },
];

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageCodec {
  /** Pixel size of the encoded image. Rejects when the bytes are not an image the browser can decode. */
  measure(bytes: Uint8Array): Promise<{ width: number; height: number }>;
  /** Decodes, draws at `width` x `height` on a white background and encodes as JPEG. */
  encodeJpeg(bytes: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array>;
  /**
   * Decodes, takes the rectangle (`x`, `y`, `w`, `h` in pixels of the decoded image), draws it at `width` x `height`
   * on a white background and encodes as JPEG. Used to cut long strips into segments.
   */
  cropEncodeJpeg(bytes: Uint8Array, rect: CropRect, width: number, height: number, quality: number): Promise<Uint8Array>;
}

export interface PreparedImage {
  mime: string;
  bytes: Uint8Array;
  /** Size of the original image; box fractions are scaled back to this. */
  originalWidth: number;
  originalHeight: number;
  /** Size of the image that is sent. */
  width: number;
  height: number;
  reencoded: boolean;
}

export class ImageTooLargeError extends Error {
  constructor() {
    super("The image is still above the size limit after compression");
    this.name = "ImageTooLargeError";
  }
}

export interface PrepareOptions {
  maxSide?: number;
  maxBytes?: number;
}

/**
 * Keeps the original bytes when they are a JPEG, PNG or WebP within the limits. Otherwise scales the image down
 * and re-encodes it as JPEG, trying smaller settings until it fits.
 */
export async function prepareImage(bytes: Uint8Array, codec: ImageCodec, options: PrepareOptions = {}): Promise<PreparedImage> {
  const maxSide = options.maxSide ?? MAX_SEND_SIDE;
  const maxBytes = options.maxBytes ?? MAX_SEND_BYTES;
  const { width: originalWidth, height: originalHeight } = await codec.measure(bytes);
  const mime = sniffSendMime(bytes);
  const fitted = fitWithin(originalWidth, originalHeight, maxSide);
  const unchanged = fitted.width === originalWidth && fitted.height === originalHeight;

  if (mime && unchanged && bytes.length <= maxBytes) {
    return { mime, bytes, originalWidth, originalHeight, width: originalWidth, height: originalHeight, reencoded: false };
  }

  for (const attempt of ENCODE_ATTEMPTS) {
    const width = Math.max(1, Math.round(fitted.width * attempt.scale));
    const height = Math.max(1, Math.round(fitted.height * attempt.scale));
    const encoded = await codec.encodeJpeg(bytes, width, height, attempt.quality);
    if (encoded.length <= maxBytes) {
      return { mime: "image/jpeg", bytes: encoded, originalWidth, originalHeight, width, height, reencoded: true };
    }
  }
  throw new ImageTooLargeError();
}
