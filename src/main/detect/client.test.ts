import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../log/log'
import { DetectClient } from './client'
import type { WorkerLike } from './client'

function fakeWorker(handler: (message: Record<string, unknown>, emit: (m: unknown) => void) => void) {
  let onMessage: (m: unknown) => void = () => {}
  let onExit: (code: number) => void = () => {}
  const worker: WorkerLike = {
    postMessage: (message) => queueMicrotask(() => handler(message as Record<string, unknown>, (m) => onMessage(m))),
    on: ((event: string, listener: never) => {
      if (event === 'message') onMessage = listener
      else onExit = listener
    }) as never,
    kill: vi.fn(() => true),
  }
  return { worker, exit: (code: number) => onExit(code) }
}

const okResult = {
  width: 10,
  height: 20,
  tiled: false,
  tileCount: 1,
  units: [],
  timings: { decodeMs: 1, inferMs: 2, cropMs: 3 },
}

const job = { bytes: new Uint8Array([1]), ocrPadding: 8, readingDirection: 'ltr' as const, maxBoxImageCoverage: 0.85 }

describe('DetectClient', () => {
  it('initialises the worker once and returns detect results', async () => {
    const seen: string[] = []
    const fake = fakeWorker((message, emit) => {
      seen.push(String(message['type']))
      emit({ id: message['id'], ok: true, result: message['type'] === 'detect' ? okResult : null })
    })
    const fork = vi.fn(() => fake.worker)
    const client = new DetectClient({ fork, modelPath: 'model.onnx', logger: silentLogger })

    const a = await client.detect(job)
    const b = await client.detect(job)
    expect(a).toEqual({ ok: true, result: okResult })
    expect(b.ok).toBe(true)
    expect(fork).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['init', 'detect', 'detect'])
  })

  it('maps worker errors to outcomes', async () => {
    const fake = fakeWorker((message, emit) => {
      if (message['type'] === 'init') emit({ id: message['id'], ok: true, result: null })
      else emit({ id: message['id'], ok: false, error: { code: 'DETECT_FAILED', message: 'bad image' } })
    })
    const client = new DetectClient({ fork: () => fake.worker, modelPath: 'm', logger: silentLogger })
    expect(await client.detect(job)).toEqual({ ok: false, error: { code: 'DETECT_FAILED', message: 'bad image' } })
  })

  it('ignores malformed worker messages', async () => {
    const fake = fakeWorker((message, emit) => {
      emit({ nonsense: true })
      emit({ id: message['id'], ok: true, result: message['type'] === 'detect' ? okResult : null })
    })
    const client = new DetectClient({ fork: () => fake.worker, modelPath: 'm', logger: silentLogger })
    expect((await client.detect(job)).ok).toBe(true)
  })

  it('fails pending work and restarts after the worker exits', async () => {
    let first = true
    const forks: Array<ReturnType<typeof fakeWorker>> = []
    const fork = vi.fn(() => {
      const mine = first
      first = false
      const fake = fakeWorker((message, emit) => {
        if (message['type'] === 'init') return emit({ id: message['id'], ok: true, result: null })
        if (mine) return // the first worker never answers detect requests
        emit({ id: message['id'], ok: true, result: okResult })
      })
      forks.push(fake)
      return fake.worker
    })
    const client = new DetectClient({ fork, modelPath: 'm', logger: silentLogger })

    const pending = client.detect(job)
    await new Promise((resolve) => setTimeout(resolve, 10))
    forks[0]!.exit(1)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'WORKER_EXITED' } })

    expect((await client.detect(job)).ok).toBe(true)
    expect(fork).toHaveBeenCalledTimes(2)
  })

  it('times out, kills the worker and recovers', async () => {
    const workers: Array<ReturnType<typeof fakeWorker>> = []
    const fork = vi.fn(() => {
      const index = workers.length
      const fake = fakeWorker((message, emit) => {
        if (message['type'] === 'init') return emit({ id: message['id'], ok: true, result: null })
        if (index === 0) return
        emit({ id: message['id'], ok: true, result: okResult })
      })
      workers.push(fake)
      return fake.worker
    })
    const client = new DetectClient({ fork, modelPath: 'm', logger: silentLogger, timeoutMs: 30 })
    expect(await client.detect(job)).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    expect(workers[0]!.worker.kill).toHaveBeenCalled()
    expect((await client.detect(job)).ok).toBe(true)
  })

  it('refuses work after dispose and kills the worker', async () => {
    const fake = fakeWorker((message, emit) => emit({ id: message['id'], ok: true, result: okResult }))
    const client = new DetectClient({ fork: () => fake.worker, modelPath: 'm', logger: silentLogger })
    await client.detect(job)
    await client.dispose()
    expect(fake.worker.kill).toHaveBeenCalled()
    expect(await client.detect(job)).toMatchObject({ ok: false, error: { code: 'DISPOSED' } })
  })
})
