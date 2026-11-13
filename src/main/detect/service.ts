import { performance } from 'node:perf_hooks'
import { Detector, cropToPng } from './detector'
import type { DetectOk } from './protocol'
import type { ReadingDirection } from './units'

export interface DetectJob {
  bytes: Uint8Array
  ocrPadding: number
  readingDirection: ReadingDirection
  maxBoxImageCoverage: number
}

export type DetectOutcome = { ok: true; result: DetectOk } | { ok: false; error: { code: string; message: string } }

/** What the pipeline needs from detection. Implemented by the utility-process client and an in-process runner. */
export interface DetectService {
  detect(job: DetectJob): Promise<DetectOutcome>
  dispose(): Promise<void>
}

/**
 * Runs detection in the calling process. This is the code the utility-process
 * worker executes; it is also used by headless tests and the smoke run, where
 * no Electron is available. Jobs are serialised (detection concurrency is 1).
 */
export class InProcessDetectService implements DetectService {
  private detector: Promise<Detector> | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly modelPath: string) {}

  private load(): Promise<Detector> {
    this.detector ??= Detector.create(this.modelPath)
    return this.detector
  }

  detect(job: DetectJob): Promise<DetectOutcome> {
    const run = async (): Promise<DetectOutcome> => {
      try {
        const detector = await this.load()
        const { image, result } = await detector.detect(job.bytes, {
          readingDirection: job.readingDirection,
          maxBoxImageCoverage: job.maxBoxImageCoverage,
        })
        const cropStart = performance.now()
        const units = await Promise.all(
          result.units.map(async (unit) => ({
            kind: unit.kind,
            bubbleOnly: unit.bubbleOnly,
            drawBox: unit.drawBox,
            ocrBox: unit.ocrBox,
            ocrPng: await cropToPng(image, unit.ocrBox, job.ocrPadding),
          })),
        )
        return {
          ok: true,
          result: {
            width: result.width,
            height: result.height,
            tiled: result.tiled,
            tileCount: result.tileCount,
            units,
            timings: { ...result.timings, cropMs: performance.now() - cropStart },
          },
        }
      } catch (error) {
        return { ok: false, error: { code: 'DETECT_FAILED', message: error instanceof Error ? error.message : String(error) } }
      }
    }
    const next = this.chain.then(run, run)
    this.chain = next
    return next
  }

  async dispose(): Promise<void> {
    const detector = this.detector
    this.detector = null
    if (detector) await (await detector).dispose().catch(() => {})
  }
}
