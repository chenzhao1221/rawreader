// RawReader extension: gets the bytes of a page image in three steps, in the order of how much of the page's own
// session each one uses. The steps run in the content script, so a site that sits behind a Cloudflare challenge or
// checks cookies still hands the image over:
//
//   1. canvas      draw the <img> that is already loaded in the page (no request at all; a cross-origin image
//                  without CORS taints the canvas and this step fails)
//   2. page-fetch  fetch(url, { credentials: "include" }) from the page, so the request carries the page's cookies
//                  (cf_clearance and the like) and its Referer
//   3. background  the service worker downloads it (Referer set by a declarativeNetRequest session rule)
//
// Idea from the Manga-Translator-Extension content script; the code here is written for this extension.
// Everything the browser provides comes in through ImageSourceDeps, so the order and the failure handling are
// unit-tested without a browser.
import { bytesToBase64 } from "./bridge/client";
import { sniffSendMime } from "./direct/image";

export type ImageStepName = "canvas" | "page-fetch" | "background";

/** An image above this many bytes is re-encoded as JPEG (at the same pixel size) before it goes into a message. */
export const MAX_IMAGE_MESSAGE_BYTES = 8 * 1024 * 1024;

/** The page fetch gives up on a response larger than this. */
export const MAX_PAGE_FETCH_BYTES = 40 * 1024 * 1024;

export const PAGE_FETCH_TIMEOUT_MS = 20_000;

/** JPEG qualities tried in turn when the encoded image is above the message limit. */
export const CANVAS_QUALITIES: readonly number[] = [0.95, 0.8, 0.6];

export interface ImageSourceDeps {
  /** Step 1. Draws the page element as a JPEG data URL. Throws when the canvas is tainted or the image is empty. */
  readElement?: ((quality: number) => string) | undefined;
  /** Step 2. The page's `fetch`. */
  fetchImpl?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Step 2. Re-encodes bytes the message cannot carry as they are (gif, avif, bmp or very large) as JPEG. */
  reencodeJpeg?: ((bytes: Uint8Array, quality: number) => Promise<Uint8Array>) | undefined;
  /** Step 3. Asks the background worker for the image; resolves a data URL and throws with the reason otherwise. */
  background?: ((url: string) => Promise<string>) | undefined;
  /** Called for every failed step. The reason holds no URL and no query string. */
  log?: ((step: ImageStepName, reason: string) => void) | undefined;
  timeoutMs?: number | undefined;
}

export interface ImageStepFailure {
  step: ImageStepName;
  reason: string;
}

/** Every step failed. `message` is the reason of the last step that ran. */
export class ImageUnavailableError extends Error {
  readonly failures: ImageStepFailure[];
  constructor(failures: ImageStepFailure[]) {
    super(failures[failures.length - 1]?.reason ?? "No way to get the image");
    this.name = "ImageUnavailableError";
    this.failures = failures;
  }
}

export interface ImageSourceResult {
  dataUrl: string;
  step: ImageStepName;
}

const reasonOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text || (error instanceof Error ? error.name : "unknown error");
};

/** Size of the bytes a data URL holds, estimated from its length. */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma < 0 ? dataUrl.length : dataUrl.length - comma - 1;
  return Math.floor((payload * 3) / 4);
}

/** Step 1. Tries the qualities in turn and keeps the first result that fits in a message. */
function fromElement(deps: ImageSourceDeps): string {
  if (!deps.readElement) throw new Error("no page element to read");
  let last = "";
  for (const quality of CANVAS_QUALITIES) {
    last = deps.readElement(quality);
    if (dataUrlByteLength(last) <= MAX_IMAGE_MESSAGE_BYTES) return last;
  }
  throw new Error(`the drawn image is still above ${MAX_IMAGE_MESSAGE_BYTES} bytes at the lowest quality`);
}

function isFetchable(url: string): boolean {
  return /^(https?|blob):/i.test(url);
}

/** True when the Content-Type cannot be an image (an HTML challenge page, JSON error). Missing or generic is fine. */
function notImageType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return false;
  return type !== "application/octet-stream" && type !== "binary/octet-stream";
}

async function readBody(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_FETCH_BYTES) throw new Error("the image is too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_PAGE_FETCH_BYTES) throw new Error("the image is too large");
  return bytes;
}

async function toMessageDataUrl(bytes: Uint8Array, deps: ImageSourceDeps): Promise<string> {
  const mime = sniffSendMime(bytes);
  if (mime && bytes.length <= MAX_IMAGE_MESSAGE_BYTES) return `data:${mime};base64,${bytesToBase64(bytes)}`;
  if (!mime && bytes.length === 0) throw new Error("empty response");
  if (!deps.reencodeJpeg) throw new Error(mime ? "the image is too large" : "unsupported image format");
  for (const quality of CANVAS_QUALITIES) {
    let encoded: Uint8Array;
    try {
      encoded = await deps.reencodeJpeg(bytes, quality);
    } catch (error) {
      // Not decodable: an HTML page or some other file that is not an image.
      throw new Error(`the response is not an image the browser can decode (${reasonOf(error)})`);
    }
    if (encoded.length <= MAX_IMAGE_MESSAGE_BYTES) return `data:image/jpeg;base64,${bytesToBase64(encoded)}`;
  }
  throw new Error("the image is too large");
}

/** Step 2. Fetches from the page with its cookies; a CORS refusal with credentials is retried without them. */
async function fromPageFetch(url: string, deps: ImageSourceDeps): Promise<string> {
  const doFetch = deps.fetchImpl;
  if (!doFetch) throw new Error("fetch is not available");
  if (!isFetchable(url)) throw new Error("this kind of address cannot be fetched from the page");
  const timeoutMs = deps.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS;

  const request = (credentials: RequestCredentials) =>
    doFetch(url, {
      credentials,
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res: Response;
  try {
    res = await request("include");
  } catch (error) {
    // A cross-origin host that answers `Access-Control-Allow-Origin: *` refuses credentialed requests. Without
    // credentials it may still answer; a timeout is not worth a second wait.
    if ((error as { name?: string } | null)?.name === "TimeoutError") throw new Error("timed out");
    try {
      res = await request("omit");
    } catch {
      throw new Error(`${reasonOf(error)} (blocked by the page's CORS policy, or a network error)`);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.statusText ? `${res.status} ${res.statusText}` : res.status}`);
  const contentType = res.headers.get("content-type");
  if (notImageType(contentType)) throw new Error(`the response is not an image (${contentType?.split(";")[0]?.trim()})`);
  return toMessageDataUrl(await readBody(res), deps);
}

/**
 * Gets the image as a data URL. Each failed step is logged and the next one runs. When all steps fail it throws an
 * ImageUnavailableError whose message is the reason of the last step.
 */
export async function acquireImageDataUrl(url: string, deps: ImageSourceDeps): Promise<ImageSourceResult> {
  const failures: ImageStepFailure[] = [];
  const attempt = async (step: ImageStepName, run: () => string | Promise<string>): Promise<ImageSourceResult | null> => {
    try {
      return { dataUrl: await run(), step };
    } catch (error) {
      const reason = reasonOf(error);
      failures.push({ step, reason });
      deps.log?.(step, reason);
      return null;
    }
  };

  const viaCanvas = await attempt("canvas", () => fromElement(deps));
  if (viaCanvas) return viaCanvas;

  const viaPage = await attempt("page-fetch", () => fromPageFetch(url, deps));
  if (viaPage) return viaPage;

  const viaBackground = await attempt("background", () => {
    if (!deps.background) throw new Error("the background worker is not available");
    return deps.background(url);
  });
  if (viaBackground) return viaBackground;

  throw new ImageUnavailableError(failures);
}
