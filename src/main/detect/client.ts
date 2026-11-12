import type { Logger } from '../log/log'
import { DetectResponseSchema } from './protocol'
import type { DetectRequest, DetectResponse } from './protocol'
import type { DetectJob, DetectOutcome, DetectService } from './service'

/** The slice of Electron's `UtilityProcess` this client uses. Lets tests pass a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface DetectClientOptions {
  /** Starts the utility process (`utilityProcess.fork(workerPath)` in production). */
  fork: () => WorkerLike
  modelPath: string
  logger: Logger
  /** A detection that takes longer than this fails; the worker is restarted. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

/** Omit that keeps the members of a union apart. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

interface Pending {
  resolve: (response: DetectResponse) => void
  timer: NodeJS.Timeout
}

/**
 * Main-process side of the detection utility process. Starts it lazily,
 * sends validated requests, matches responses by id and restarts the worker
 * after a crash. Detection concurrency is 1, enforced by the worker itself.
 */
export class DetectClient implements DetectService {
  private worker: WorkerLike | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private disposed = false

  constructor(private readonly options: DetectClientOptions) {}

  async detect(job: DetectJob): Promise<DetectOutcome> {
    if (this.disposed) return { ok: false, error: { code: 'DISPOSED', message: 'Detection service was shut down' } }
    try {
      await this.ensureWorker()
    } catch (error) {
      return { ok: false, error: { code: 'WORKER_START_FAILED', message: error instanceof Error ? error.message : String(error) } }
    }
    const response = await this.request({
      type: 'detect',
      bytes: job.bytes,
      ocrPadding: job.ocrPadding,
      readingDirection: job.readingDirection,
    })
    return response.ok ? { ok: true, result: response.result as NonNullable<typeof response.result> } : { ok: false, error: response.error }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    this.ready = null
    this.failAll('DISPOSED', 'Detection service was shut down')
    if (worker) worker.kill()
  }

  private ensureWorker(): Promise<void> {
    if (this.ready) return this.ready
    const worker = this.options.fork()
    this.worker = worker
    worker.on('message', (message) => this.onMessage(message))
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.options.logger.warn(`Detection worker exited (code ${code}); it restarts on the next image`)
      this.worker = null
      this.ready = null
      this.failAll('WORKER_EXITED', `Detection worker exited with code ${code}`)
    })
    this.ready = this.request({ type: 'init', modelPath: this.options.modelPath }).then((response) => {
      if (!response.ok) {
        this.ready = null
        throw new Error(response.error.message)
      }
    })
    return this.ready
  }

  private request(body: WithoutId<DetectRequest>): Promise<DetectResponse> {
    const worker = this.worker
    if (!worker) return Promise.resolve({ id: -1, ok: false, error: { code: 'WORKER_EXITED', message: 'No detection worker' } })
    const id = this.nextId++
    return new Promise<DetectResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.options.logger.error('Detection timed out; restarting the worker')
        resolve({ id, ok: false, error: { code: 'TIMEOUT', message: 'Detection timed out' } })
        if (this.worker === worker) {
          this.worker = null
          this.ready = null
          worker.kill()
        }
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      worker.postMessage({ ...body, id })
    })
  }

  private onMessage(message: unknown): void {
    const parsed = DetectResponseSchema.safeParse(message)
    if (!parsed.success) {
      this.options.logger.warn('Ignoring a malformed message from the detection worker')
      return
    }
    const entry = this.pending.get(parsed.data.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(parsed.data.id)
    entry.resolve(parsed.data)
  }

  private failAll(code: string, message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ id, ok: false, error: { code, message } })
    }
    this.pending.clear()
  }
}
