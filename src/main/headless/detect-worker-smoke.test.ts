import { describe, expect, it } from 'vitest'
import { silentLogger } from '../log/log'
import { runDetectWorkerSmoke } from './detect-worker-smoke'
import type { SmokeWorker } from './detect-worker-smoke'

type Listener = (value: never) => void

/** In-memory stand-in for a utility process. `respond` builds the reply to each request. */
function fakeWorker(respond: (request: { id: number; type: string }) => unknown): SmokeWorker & { killed: boolean } {
  const listeners: Record<string, Listener[]> = { message: [], exit: [] }
  const worker = {
    pid: 4242,
    killed: false,
    postMessage(message: unknown) {
      const reply = respond(message as { id: number; type: string })
      queueMicrotask(() => listeners['message']?.forEach((l) => (l as (m: unknown) => void)(reply)))
    },
    on(event: string, listener: Listener) {
      listeners[event]?.push(listener)
      return worker
    },
    kill() {
      worker.killed = true
      queueMicrotask(() => listeners['exit']?.forEach((l) => (l as (c: number) => void)(0)))
      return true
    },
  }
  return worker as unknown as SmokeWorker & { killed: boolean }
}

const box = { x1: 10, y1: 20, x2: 110, y2: 120, confidence: 0.9 }

describe('runDetectWorkerSmoke', () => {
  it('reports units, the worker pid and a clean exit', async () => {
    const worker = fakeWorker((request) => {
      if (request.type === 'init') return { id: request.id, ok: true, result: null }
      return {
        id: request.id,
        ok: true,
        result: {
          width: 800,
          height: 1100,
          tiled: false,
          tileCount: 1,
          units: [
            { kind: 'bubble', bubbleOnly: true, drawBox: box, ocrBox: box, ocrPng: new Uint8Array(5) },
            { kind: 'free', bubbleOnly: false, drawBox: box, ocrBox: box, ocrPng: null },
          ],
          timings: { decodeMs: 1, inferMs: 2, cropMs: 3 },
        },
      }
    })
    const report = await runDetectWorkerSmoke({ fork: () => worker, modelPath: 'model.onnx', imageBytes: new Uint8Array(3), logger: silentLogger })
    expect(report.ok).toBe(true)
    expect(report.unitCount).toBe(2)
    expect(report.bubbleOnlyCount).toBe(1)
    expect(report.units[0]).toMatchObject({ kind: 'bubble', drawBox: [10, 20, 110, 120], ocrPngBytes: 5 })
    expect(report.workerPid).toBe(4242)
    expect(report.workerExited).toBe(true)
    expect(worker.killed).toBe(true)
  })

  it('returns the worker error as the reason and still cleans up', async () => {
    const worker = fakeWorker((request) =>
      request.type === 'init'
        ? { id: request.id, ok: false, error: { code: 'INIT_FAILED', message: 'cannot load onnxruntime-node' } }
        : { id: request.id, ok: true, result: null },
    )
    const report = await runDetectWorkerSmoke({ fork: () => worker, modelPath: 'm.onnx', imageBytes: new Uint8Array(3), logger: silentLogger })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('cannot load onnxruntime-node')
    expect(worker.killed).toBe(true)
    expect(report.workerExited).toBe(true)
  })
})
