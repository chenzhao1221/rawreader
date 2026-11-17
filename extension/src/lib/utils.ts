// Portions ported from libre-manga-translator src/lib/utils.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
// RawReader changes: model download, Cache Storage and ONNX provider code are gone. OPEN_SETUP_TAB now opens the options page.

export function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  )
    return "image/avif";
  return "image/jpeg";
}

export async function fetchAsImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const mime = sniffMime(bytes);
  const blob = new Blob([arrayBuffer], { type: mime });
  return createImageBitmap(blob);
}

export function arrayBufferToBase64DataUrl(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const mime = sniffMime(bytes);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function fetchAsBase64(url: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  const mimeType = blob.type || "image/jpeg";
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}


/** Opens the options page (the old setup wizard no longer exists). */
export async function openSetupTab(_modelId?: string, _clean?: boolean) {
  await browser.runtime.sendMessage({ type: "OPEN_SETUP_TAB" });
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && /abort/i.test(msg);
}

/**
 * Cooperative time-slicing. Yields event loop to pending UI tasks (e.g. extension popup clicks).
 * Uses native `scheduler.yield()` when available (Chromium 115+), falling back to `setTimeout(0)`.
 */
export async function yieldToMain(): Promise<void> {
  if (typeof (globalThis as any).scheduler?.yield === "function") {
    return (globalThis as any).scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface RunLock {
  <T>(task: () => Promise<T>): Promise<T>;
  getDeadLetterCount(): number;
  reset(): void;
}

/**
 * Shared global tail across all ONNX Runtime locks in the same JS context.
 * ONNX Runtime Web's WASM backend is non-reentrant across sessions in the
 * same thread ("Session already started"), so all ORT subsystems share one
 * underlying execution chain while keeping per-subsystem dead-letter counters.
 */
let sharedOrtTail: Promise<unknown> = Promise.resolve();

/**
 * FIFO promise serializer with dead-letter isolation.
 * Prevents concurrent inference runs on non-reentrant ONNX sessions.
 * One task rejection never breaks or stalls subsequent tasks in chain.
 */
export function createRunLock(subsystem = "core"): RunLock {
  let deadLetters = 0;

  const lock = function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    // ponytail: unbounded queue; upgrade to bounded semaphore if memory spikes under burst.
    const run = () => task();
    const result = sharedOrtTail.then(run, run);
    sharedOrtTail = result.catch((err) => {
      deadLetters++;
      console.error(`[dead-letter:${subsystem}] (#${deadLetters}) Task rejected:`, err);
    });
    return result;
  } as RunLock;

  lock.getDeadLetterCount = () => deadLetters;
  lock.reset = () => {
    sharedOrtTail = Promise.resolve();
    deadLetters = 0;
  };

  return lock;
}
