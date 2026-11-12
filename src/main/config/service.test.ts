import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { Config } from '../../shared/config/schema'
import { silentLogger } from '../log/log'
import { resolveOverlayPaths } from './overlay'
import { ConfigService } from './service'
import type { ConfigBackend } from './service'

function memoryBackend(initial?: unknown): ConfigBackend & { stored: () => unknown; writes: number } {
  let data: unknown = initial
  const backend = {
    writes: 0,
    read: () => data,
    write(value: Config) {
      data = structuredClone(value)
      backend.writes++
    },
    stored: () => data,
  }
  return backend
}

const devOverlay = resolveOverlayPaths(
  {
    llama: { backend: 'vulkan', binDirs: { vulkan: '../ocr-vl-test/llamacpp/bin' } },
    models: {
      autoDownload: false,
      paths: {
        detector: '../ocr-vl-test/models/detector-v4-s_int8.onnx',
        ocr: '../ocr-vl-test/llamacpp/models/PaddleOCR-VL-1.5.gguf',
        ocrMmproj: '../ocr-vl-test/llamacpp/models/PaddleOCR-VL-1.5-mmproj.gguf',
        translator: '../wb-tests/models/Index-Translate-2B.Q4_K_M.gguf',
      },
    },
  },
  resolve('/repo/app'),
)

describe('ConfigService', () => {
  it('starts from defaults and warns once per invalid stored field', () => {
    const logger = { ...silentLogger, warn: vi.fn() }
    const service = new ConfigService({
      backend: memoryBackend({ llama: { ocr: { port: 'x' } } }),
      logger,
    })
    expect(service.get().llama.ocr.port).toBe(18791)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('applies the dev overlay: absolute paths to the five local files and autoDownload false', () => {
    const service = new ConfigService({ backend: memoryBackend(), overlay: devOverlay, logger: silentLogger })
    const config = service.get()
    expect(config.models.autoDownload).toBe(false)
    const paths = [
      config.llama.binDirs.vulkan,
      config.models.paths.detector,
      config.models.paths.ocr,
      config.models.paths.ocrMmproj,
      config.models.paths.translator,
    ]
    expect(paths).toHaveLength(5)
    for (const path of paths) {
      expect(path).not.toBeNull()
      expect(isAbsolute(path as string)).toBe(true)
    }
  })

  it('never writes the overlay to the store', () => {
    const backend = memoryBackend()
    const service = new ConfigService({ backend, overlay: devOverlay, logger: silentLogger })
    service.update({ ui: { autoTranslate: true } })

    const stored = backend.stored() as Config
    expect(stored.ui.autoTranslate).toBe(true)
    expect(stored.models.autoDownload).toBe(true) // the schema default, not the overlay's false
    expect(stored.models.paths.ocr).toBeNull()
    expect(stored.llama.binDirs.vulkan).toBeNull()
    // The effective config still has the overlay.
    expect(service.get().models.autoDownload).toBe(false)
    expect(service.get().ui.autoTranslate).toBe(true)
  })

  it('persists updates, merges deeply and notifies listeners with the previous config', () => {
    const backend = memoryBackend()
    const service = new ConfigService({ backend, logger: silentLogger })
    const listener = vi.fn()
    service.onChanged(listener)

    service.update({ llama: { ocr: { ctxSize: 2048 } } })

    expect(service.get().llama.ocr.ctxSize).toBe(2048)
    expect(service.get().llama.ocr.port).toBe(18791)
    expect(backend.writes).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    const [next, previous] = listener.mock.calls[0] as [Config, Config]
    expect(next.llama.ocr.ctxSize).toBe(2048)
    expect(previous.llama.ocr.ctxSize).toBe(4096)
  })

  it('does not notify when the effective config is unchanged', () => {
    const service = new ConfigService({ backend: memoryBackend(), logger: silentLogger })
    const listener = vi.fn()
    service.onChanged(listener)
    service.update({ ui: { overlayVisible: true } }) // already the default
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects an invalid update and keeps the previous config', () => {
    const backend = memoryBackend()
    const service = new ConfigService({ backend, logger: silentLogger })
    expect(() => service.update({ llama: { ocr: { port: 80 } } })).toThrow()
    expect(service.get().llama.ocr.port).toBe(18791)
    expect(backend.writes).toBe(0)
  })

  it('survives a restart: a new service reads what the first one stored', () => {
    const backend = memoryBackend()
    new ConfigService({ backend, logger: silentLogger }).update({ ui: { autoTranslate: true, lastUrl: 'https://example.com/a' } })
    const second = new ConfigService({ backend, logger: silentLogger })
    expect(second.get().ui).toEqual({ autoTranslate: true, overlayVisible: true, lastUrl: 'https://example.com/a' })
    expect(ConfigSchema.safeParse(backend.stored()).success).toBe(true)
  })
})
