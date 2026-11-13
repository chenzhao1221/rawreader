import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DownloadSource } from './manifest'

/** A download URL and the name of the place it comes from (for logs and the UI). */
export interface UrlSource<S extends string = DownloadSource> {
  source: S
  url: string
}

/**
 * Minimal `fetch` the downloader needs. Production passes Electron `net.fetch` (system proxy, redirects);
 * tests pass the global `fetch` aimed at a local HTTP server, or a hand-written stub.
 */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; method?: string }) => Promise<Response>

export type DownloadErrorCode =
  | 'HTTP_ERROR'
  | 'NETWORK'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'RANGE_MISMATCH'
  | 'DISK'
  /** The source works but is too slow, and another source is left to try. */
  | 'SLOW'
  | 'ABORTED'
  | 'ALL_SOURCES_FAILED'

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    /** HTTP status for `HTTP_ERROR`. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface FileSpec {
  fileName: string
  size: number
  sha256: string
}

export type DownloadPhase = 'downloading' | 'verifying'

export interface DownloadFileOptions<S extends string = DownloadSource> {
  spec: FileSpec
  /** Tried in order. Each gets `attemptsPerSource` tries before the next one is used. */
  sources: readonly UrlSource<S>[]
  destPath: string
  fetch: FetchLike
  signal: AbortSignal
  attemptsPerSource?: number
  /** Delay before retry number `n` (1-based) on the same source. */
  retryDelayMs?: (retry: number) => number
  /** Drop an attempt on a source that still has a fallback when it stays below this speed. Default 1 MiB/s. */
  slowBytesPerSecond?: number
  /** Warm-up time before the speed is measured, and the length of the measurement window. Default 20 s. */
  slowWindowMs?: number
  /** Clock for the speed measurement (injectable for tests). Default `Date.now`. */
  now?: () => number
  onProgress?: (receivedBytes: number) => void
  onPhase?: (phase: DownloadPhase) => void
  /** Called when an attempt starts. */
  onAttempt?: (source: S, attempt: number) => void
  onRetry?: (source: S, attempt: number, error: DownloadError) => void
}

export interface DownloadFileResult<S extends string = DownloadSource> {
  source: S
  /** Byte offset the successful attempt resumed from (0 for a fresh download). */
  resumedFrom: number
}

export const DEFAULT_ATTEMPTS_PER_SOURCE = 3
export const DEFAULT_SLOW_BYTES_PER_SECOND = 1024 * 1024
export const DEFAULT_SLOW_WINDOW_MS = 20_000
const defaultRetryDelay = (retry: number): number => Math.min(1000 * 2 ** (retry - 1), 8000)

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/** Streams a file through sha256. Aborts with `ABORTED`. */
export function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    const onAbort = (): void => {
      stream.destroy()
      reject(new DownloadError('ABORTED', 'Hashing was aborted'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

/** `Content-Range: bytes 100-999/1000` -> 100, else null. */
export function parseContentRangeStart(header: string | null): number | null {
  const match = header?.match(/^\s*bytes\s+(\d+)-\d+\/(?:\d+|\*)\s*$/i)
  return match ? Number(match[1]) : null
}

function isRetryable(error: DownloadError): boolean {
  // A slow source will not get faster on the same URL: go to the next source at once.
  if (error.code === 'SLOW') return false
  if (error.code !== 'HTTP_ERROR') return true
  const status = error.status ?? 0
  // A missing or forbidden file will not appear on a retry; go to the next source at once.
  // 416 is retried because the partial file was discarded and the next attempt starts from zero.
  return status >= 500 || status === 408 || status === 416 || status === 429
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

interface SlowCheck {
  bytesPerSecond: number
  windowMs: number
  now: () => number
}

async function writeBody(
  response: Response,
  partPath: string,
  mode: 'append' | 'truncate',
  startOffset: number,
  controller: AbortController,
  externalSignal: AbortSignal,
  onProgress?: (receivedBytes: number) => void,
  slow?: SlowCheck,
): Promise<void> {
  if (!response.body) throw new DownloadError('NETWORK', 'The response has no body')
  const file = await open(partPath, mode === 'append' ? 'a' : 'w')
  const reader = response.body.getReader()
  let received = startOffset
  // The first window doubles as the warm-up: nothing is judged before `windowMs` has passed.
  let windowStart = slow ? slow.now() : 0
  let windowBytes = startOffset
  try {
    for (;;) {
      if (externalSignal.aborted) throw new DownloadError('ABORTED', 'Download was aborted')
      const { done, value } = await reader.read()
      if (done) break
      await file.write(value)
      received += value.byteLength
      onProgress?.(received)
      // A user pause / cancel wins over the speed check.
      if (externalSignal.aborted) throw new DownloadError('ABORTED', 'Download was aborted')
      if (slow) {
        const at = slow.now()
        const elapsed = at - windowStart
        if (elapsed >= slow.windowMs) {
          const rate = ((received - windowBytes) * 1000) / elapsed
          if (rate < slow.bytesPerSecond) {
            // Tear the request down; the `.part` file stays so the next source resumes from it.
            controller.abort()
            throw new DownloadError('SLOW', `Speed stayed at ${Math.round(rate / 1024)} KB/s`)
          }
          windowStart = at
          windowBytes = received
        }
      }
    }
  } catch (error) {
    if (externalSignal.aborted) throw new DownloadError('ABORTED', 'Download was aborted')
    if (error instanceof DownloadError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOSPC' || code === 'EPERM' || code === 'EACCES' || code === 'EIO') {
      throw new DownloadError('DISK', `Cannot write ${partPath}: ${(error as Error).message}`)
    }
    throw new DownloadError('NETWORK', error instanceof Error ? error.message : String(error))
  } finally {
    await reader.cancel().catch(() => {})
    await file.close().catch(() => {})
  }
}

/** One attempt on one URL. Resumes from the `.part` file when there is one. */
async function attemptDownload<S extends string>(
  options: DownloadFileOptions<S>,
  source: UrlSource<S>,
  /** True when another source follows this one, so a slow attempt may be dropped. */
  hasFallback: boolean,
): Promise<DownloadFileResult<S>> {
  const { spec, destPath, signal: externalSignal } = options
  const partPath = `${destPath}.part`
  await mkdir(dirname(destPath), { recursive: true })

  // Own controller per attempt, so a slow attempt can be dropped without touching the caller's signal.
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (externalSignal.aborted) controller.abort()
  else externalSignal.addEventListener('abort', forwardAbort, { once: true })
  const signal = controller.signal

  const slow: SlowCheck | undefined = hasFallback
    ? {
        bytesPerSecond: options.slowBytesPerSecond ?? DEFAULT_SLOW_BYTES_PER_SECOND,
        windowMs: options.slowWindowMs ?? DEFAULT_SLOW_WINDOW_MS,
        now: options.now ?? Date.now,
      }
    : undefined

  try {
    let have = await sizeOf(partPath)
    if (have > spec.size) {
      await rm(partPath, { force: true })
      have = 0
    }
    const resumedFrom = have

    if (have < spec.size) {
      options.onPhase?.('downloading')
      options.onProgress?.(have)
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
      let response: Response
      try {
        response = await options.fetch(source.url, { headers, signal })
      } catch (error) {
        if (externalSignal.aborted) throw new DownloadError('ABORTED', 'Download was aborted')
        throw new DownloadError('NETWORK', error instanceof Error ? error.message : String(error))
      }

      if (response.status === 206) {
        const start = parseContentRangeStart(response.headers.get('content-range'))
        if (start !== have) {
          await response.body?.cancel().catch(() => {})
          await rm(partPath, { force: true })
          throw new DownloadError('RANGE_MISMATCH', `Server resumed at ${start ?? 'unknown'}, expected ${have}`)
        }
        await writeBody(response, partPath, 'append', have, controller, externalSignal, options.onProgress, slow)
      } else if (response.status === 200) {
        // Fresh download, or the server ignored the Range header: start over so the bytes line up.
        await writeBody(response, partPath, 'truncate', 0, controller, externalSignal, options.onProgress, slow)
      } else if (response.status === 416) {
        await response.body?.cancel().catch(() => {})
        // The requested offset is outside the file. The partial data cannot be trusted; restart on the next attempt.
        await rm(partPath, { force: true })
        throw new DownloadError('HTTP_ERROR', 'Range not satisfiable (416); the partial file was discarded', 416)
      } else {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError('HTTP_ERROR', `HTTP ${response.status}`, response.status)
      }
    }

    options.onPhase?.('verifying')
    const finalSize = await sizeOf(partPath)
    if (finalSize !== spec.size) {
      // Too short: keep the partial file so the next attempt resumes. Too long: it cannot be repaired.
      if (finalSize > spec.size) await rm(partPath, { force: true })
      throw new DownloadError('SIZE_MISMATCH', `Expected ${spec.size} bytes, have ${finalSize}`)
    }
    const digest = await hashFile(partPath, signal)
    if (digest !== spec.sha256) {
      await rm(partPath, { force: true })
      throw new DownloadError('HASH_MISMATCH', `sha256 mismatch for ${spec.fileName}`)
    }
    await rename(partPath, destPath)
    return { source: source.source, resumedFrom }
  } finally {
    externalSignal.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Downloads one file with resume, verification and fallback (design section 10):
 * - `Range: bytes=<part size>-`; 206 appends, 200 restarts, 416 discards the partial and retries;
 * - size and sha256 are checked against the manifest before the atomic rename of `<file>.part`;
 * - up to `attemptsPerSource` tries per source, then the next source (ModelScope after Hugging Face);
 * - a source that stays below `slowBytesPerSecond` after the warm-up is dropped at once when another
 *   source is left (`SLOW`); the `.part` file is kept, so the next source continues it with `Range`.
 * `signal` aborts at any point and keeps the `.part` file (used for pause and cancel).
 */
export async function downloadFile<S extends string = DownloadSource>(options: DownloadFileOptions<S>): Promise<DownloadFileResult<S>> {
  const attempts = options.attemptsPerSource ?? DEFAULT_ATTEMPTS_PER_SOURCE
  const delay = options.retryDelayMs ?? defaultRetryDelay
  let last: DownloadError | null = null

  for (let i = 0; i < options.sources.length; i++) {
    const source = options.sources[i]
    if (!source) continue
    const hasFallback = i < options.sources.length - 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (options.signal.aborted) throw new DownloadError('ABORTED', 'Download was aborted')
      options.onAttempt?.(source.source, attempt)
      try {
        return await attemptDownload(options, source, hasFallback)
      } catch (error) {
        if (options.signal.aborted) throw new DownloadError('ABORTED', 'Download was aborted')
        const failure =
          error instanceof DownloadError
            ? error
            : new DownloadError('DISK', error instanceof Error ? error.message : String(error))
        last = failure
        options.onRetry?.(source.source, attempt, failure)
        if (!isRetryable(failure)) break
        if (attempt < attempts) await sleep(delay(attempt), options.signal)
      }
    }
  }
  throw new DownloadError(
    'ALL_SOURCES_FAILED',
    `Every download source failed${last ? `; last error: ${last.code} ${last.message}` : ''}`,
  )
}
