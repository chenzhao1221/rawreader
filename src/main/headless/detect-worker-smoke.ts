import { DetectClient } from '../detect/client'
import type { WorkerLike } from '../detect/client'
import type { Logger } from '../log/log'

/** A worker handle that also exposes its pid and exit state. `utilityProcess.fork()` returns such an object. */
export interface SmokeWorker extends WorkerLike {
  readonly pid?: number | undefined
}

export interface DetectSmokeOptions {
  fork: () => SmokeWorker
  modelPath: string
  imageBytes: Uint8Array
  logger: Logger
  /** Per-detection timeout handed to the client. */
  timeoutMs?: number
  /** How long to wait for the worker to exit after `dispose()`. */
  exitWaitMs?: number
}

export interface DetectSmokeUnit {
  kind: 'bubble' | 'free'
  bubbleOnly: boolean
  drawBox: number[]
  ocrBox: number[]
  ocrPngBytes: number
}

export interface DetectSmokeReport {
  ok: boolean
  /** Why the run failed (error code and message from the worker, or a harness reason). */
  reason: string | null
  workerPid: number | null
  workerExited: boolean
  image: { width: number; height: number; tiled: boolean } | null
  unitCount: number
  bubbleOnlyCount: number
  units: DetectSmokeUnit[]
  timings: { decodeMs: number; inferMs: number; cropMs: number; totalMs: number } | null
}

const round = (b: { x1: number; y1: number; x2: number; y2: number }): number[] =>
  [b.x1, b.y1, b.x2, b.y2].map((n) => Math.round(n))

/**
 * Runs one detection through the real `DetectClient` and a forked worker, then
 * shuts the worker down and waits for its exit. Starts no llama-server and
 * opens no window. Never throws: failures are returned in the report.
 */
export async function runDetectWorkerSmoke(options: DetectSmokeOptions): Promise<DetectSmokeReport> {
  const { logger } = options
  const empty: DetectSmokeReport = {
    ok: false,
    reason: null,
    workerPid: null,
    workerExited: false,
    image: null,
    unitCount: 0,
    bubbleOnlyCount: 0,
    units: [],
    timings: null,
  }

  let worker: SmokeWorker | null = null
  let exited = false
  let onExit: (() => void) | null = null
  const client = new DetectClient({
    fork: () => {
      const child = options.fork()
      worker = child
      child.on('exit', () => {
        exited = true
        onExit?.()
      })
      return child
    },
    modelPath: options.modelPath,
    logger,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })

  const started = Date.now()
  let report: DetectSmokeReport = empty
  try {
    const outcome = await client.detect({ bytes: options.imageBytes, ocrPadding: 8, readingDirection: 'ltr' })
    if (!outcome.ok) {
      report = { ...empty, reason: `${outcome.error.code}: ${outcome.error.message}` }
    } else {
      const result = outcome.result
      const units = result.units.map((unit) => ({
        kind: unit.kind,
        bubbleOnly: unit.bubbleOnly,
        drawBox: round(unit.drawBox),
        ocrBox: round(unit.ocrBox),
        ocrPngBytes: unit.ocrPng?.byteLength ?? 0,
      }))
      report = {
        ...empty,
        ok: units.length > 0,
        reason: units.length > 0 ? null : 'The worker returned no units',
        image: { width: result.width, height: result.height, tiled: result.tiled },
        unitCount: units.length,
        bubbleOnlyCount: units.filter((u) => u.bubbleOnly).length,
        units,
        timings: { ...result.timings, totalMs: Date.now() - started },
      }
    }
  } catch (error) {
    report = { ...empty, reason: error instanceof Error ? error.message : String(error) }
  }

  const spawned = worker as SmokeWorker | null
  const workerPid = spawned?.pid ?? null
  await client.dispose()
  if (spawned && !exited) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.exitWaitMs ?? 5000)
      onExit = () => {
        clearTimeout(timer)
        resolve()
      }
      if (exited) onExit()
    })
  }
  logger.info(`detect-worker smoke: ok=${report.ok} units=${report.unitCount} workerPid=${workerPid ?? '-'} exited=${exited}`)
  return { ...report, workerPid, workerExited: spawned === null ? true : exited }
}
