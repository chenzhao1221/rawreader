import { join } from 'node:path'
import PQueue from 'p-queue'
import type { ModelRole } from '../config/model-path'
import type { Logger } from '../log/log'
import { DownloadError, downloadFile } from './download'
import type { FetchLike } from './download'
import { sourceUrlsFor } from './manifest'
import type { DownloadSource, ManifestEntry, Mirrors } from './manifest'

export type FileStatus = 'queued' | 'downloading' | 'verifying' | 'done' | 'paused' | 'cancelled' | 'error'

export interface FileDownloadState {
  role: ModelRole
  fileName: string
  status: FileStatus
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
  /** Source of the running or last attempt. */
  source: DownloadSource | null
  attempt: number
  errorCode: string | null
  errorMessage: string | null
}

export interface DownloadManagerOptions {
  fetch: FetchLike
  /** Folder the files are written to (read at start, so a changed models folder applies to new downloads). */
  getTargetDir: () => string
  getMirrors: () => Mirrors
  onChange: (states: FileDownloadState[]) => void
  /** Called after a file passed verification and was renamed into place. */
  onFileDone?: (entry: ManifestEntry, path: string) => void
  logger: Logger
  /** At most this many files download at once (R13.4). Default 2. */
  concurrency?: number
  attemptsPerSource?: number
  retryDelayMs?: (retry: number) => number
  now?: () => number
}

interface Job {
  entry: ManifestEntry
  state: FileDownloadState
  controller: AbortController
  lastSampleAt: number
  lastSampleBytes: number
}

const PROGRESS_EMIT_INTERVAL_MS = 250
const SPEED_WINDOW_MS = 500

/**
 * Runs model downloads: a queue of at most two files at a time, per-file state, pause / resume / cancel.
 * Pause and cancel abort the request and keep `<file>.part`, so resume continues where it stopped.
 * Never starts anything by itself; the caller decides (first-run panel button, settings).
 */
export class DownloadManager {
  private readonly queue: PQueue
  private readonly jobs = new Map<ModelRole, Job>()
  private lastEmit = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly options: DownloadManagerOptions) {
    this.queue = new PQueue({ concurrency: options.concurrency ?? 2 })
    this.now = options.now ?? Date.now
  }

  states(): FileDownloadState[] {
    return [...this.jobs.values()].map((job) => ({ ...job.state }))
  }

  /** True while any file is queued or downloading. */
  isActive(): boolean {
    return [...this.jobs.values()].some((job) => job.state.status === 'queued' || job.state.status === 'downloading' || job.state.status === 'verifying')
  }

  /** Queues the given files. Files that are already queued or running are left alone. */
  start(entries: readonly ManifestEntry[]): void {
    for (const entry of entries) {
      const existing = this.jobs.get(entry.role)
      if (existing && (existing.state.status === 'queued' || existing.state.status === 'downloading' || existing.state.status === 'verifying')) continue
      this.enqueue(entry)
    }
    this.emit(true)
  }

  /** Aborts and keeps the partial file. Without a role, applies to every active file. */
  pause(role?: ModelRole): void {
    this.stop('paused', role)
  }

  /** Same as pause for the data on disk; the state tells the UI the user gave up on it. */
  cancel(role?: ModelRole): void {
    this.stop('cancelled', role)
  }

  /** Restarts paused, cancelled and failed files from their `.part`. */
  resume(role?: ModelRole): void {
    for (const job of this.jobs.values()) {
      if (role && job.entry.role !== role) continue
      if (job.state.status === 'paused' || job.state.status === 'cancelled' || job.state.status === 'error') this.enqueue(job.entry)
    }
    this.emit(true)
  }

  /** Stops everything for app quit. Partial files stay. */
  dispose(): void {
    for (const job of this.jobs.values()) job.controller.abort()
    this.queue.clear()
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }

  /** Resolves when the queue is empty and nothing is running. */
  whenIdle(): Promise<void> {
    return this.queue.onIdle()
  }

  // -------------------------------------------------------------------------

  private stop(status: 'paused' | 'cancelled', role?: ModelRole): void {
    for (const job of this.jobs.values()) {
      if (role && job.entry.role !== role) continue
      const s = job.state.status
      if (s !== 'queued' && s !== 'downloading' && s !== 'verifying') continue
      job.state.status = status
      job.state.bytesPerSecond = 0
      job.controller.abort()
    }
    this.emit(true)
  }

  private enqueue(entry: ManifestEntry): void {
    const job: Job = {
      entry,
      controller: new AbortController(),
      lastSampleAt: this.now(),
      lastSampleBytes: 0,
      state: {
        role: entry.role,
        fileName: entry.fileName,
        status: 'queued',
        receivedBytes: this.jobs.get(entry.role)?.state.receivedBytes ?? 0,
        totalBytes: entry.size,
        bytesPerSecond: 0,
        source: null,
        attempt: 0,
        errorCode: null,
        errorMessage: null,
      },
    }
    this.jobs.set(entry.role, job)
    void this.queue.add(() => this.run(job))
  }

  private async run(job: Job): Promise<void> {
    const { entry, state, controller } = job
    if (controller.signal.aborted) return
    state.status = 'downloading'
    this.emit(true)
    const destPath = join(this.options.getTargetDir(), entry.fileName)
    try {
      const result = await downloadFile({
        spec: entry,
        sources: sourceUrlsFor(entry, this.options.getMirrors()),
        destPath,
        fetch: this.options.fetch,
        signal: controller.signal,
        ...(this.options.attemptsPerSource !== undefined ? { attemptsPerSource: this.options.attemptsPerSource } : {}),
        ...(this.options.retryDelayMs ? { retryDelayMs: this.options.retryDelayMs } : {}),
        onAttempt: (source, attempt) => {
          state.source = source
          state.attempt = attempt
          this.emit(true)
        },
        onPhase: (phase) => {
          if (controller.signal.aborted) return
          state.status = phase
          this.emit(true)
        },
        onProgress: (received) => {
          state.receivedBytes = received
          this.sampleSpeed(job)
          this.emit(false)
        },
        onRetry: (source, attempt, error) => {
          this.options.logger.warn(`${entry.fileName}: ${source} attempt ${attempt} failed: ${error.code} ${error.message}`)
        },
      })
      state.status = 'done'
      state.receivedBytes = entry.size
      state.bytesPerSecond = 0
      state.source = result.source
      this.options.logger.info(`${entry.fileName}: downloaded from ${result.source} (resumed from ${result.resumedFrom} bytes)`)
      this.options.onFileDone?.(entry, destPath)
    } catch (error) {
      if (controller.signal.aborted) {
        // pause() / cancel() may have changed it while the request was running.
        const current = state.status as FileStatus
        if (current !== 'paused' && current !== 'cancelled') state.status = 'paused'
      } else {
        const failure = error instanceof DownloadError ? error : new DownloadError('NETWORK', error instanceof Error ? error.message : String(error))
        state.status = 'error'
        state.errorCode = failure.code
        state.errorMessage = failure.message
        this.options.logger.error(`${entry.fileName}: download failed: ${failure.code} ${failure.message}`)
      }
      state.bytesPerSecond = 0
    }
    this.emit(true)
  }

  private sampleSpeed(job: Job): void {
    const at = this.now()
    const elapsed = at - job.lastSampleAt
    if (elapsed < SPEED_WINDOW_MS) return
    const instant = ((job.state.receivedBytes - job.lastSampleBytes) * 1000) / elapsed
    job.state.bytesPerSecond = job.state.bytesPerSecond === 0 ? instant : job.state.bytesPerSecond * 0.6 + instant * 0.4
    job.lastSampleAt = at
    job.lastSampleBytes = job.state.receivedBytes
  }

  /** Status changes go out at once; byte-count updates are limited to a few per second. */
  private emit(force: boolean): void {
    const at = this.now()
    if (!force && at - this.lastEmit < PROGRESS_EMIT_INTERVAL_MS) {
      this.emitTimer ??= setTimeout(() => {
        this.emitTimer = null
        this.emit(true)
      }, PROGRESS_EMIT_INTERVAL_MS)
      return
    }
    this.lastEmit = at
    this.options.onChange(this.states())
  }
}
