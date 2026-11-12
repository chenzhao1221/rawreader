import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDevOverlay, resolveOverlayPaths } from './overlay'

const root = resolve('/repo/app')

function files(map: Record<string, string>) {
  return (path: string): string | null => map[path] ?? null
}

describe('resolveOverlayPaths', () => {
  it('resolves relative path fields against the repo root and keeps absolute ones', () => {
    const absolute = resolve('/elsewhere/llama-server-dir')
    const out = resolveOverlayPaths(
      {
        llama: { binDirs: { vulkan: '../ocr-vl-test/llamacpp/bin', cuda: absolute } },
        models: { autoDownload: false, paths: { translator: '../wb-tests/models/m.gguf' } },
      },
      root,
    )
    expect(out).toEqual({
      llama: { binDirs: { vulkan: resolve(root, '../ocr-vl-test/llamacpp/bin'), cuda: absolute } },
      models: { autoDownload: false, paths: { translator: resolve(root, '../wb-tests/models/m.gguf') } },
    })
  })

  it('leaves non-path strings alone', () => {
    const out = resolveOverlayPaths({ llama: { build: 'b12318' }, models: { mirrors: { huggingface: 'https://x.test' } } }, root)
    expect(out).toEqual({ llama: { build: 'b12318' }, models: { mirrors: { huggingface: 'https://x.test' } } })
  })
})

describe('loadDevOverlay', () => {
  it('merges dev.config.local.json over dev.config.json', () => {
    const result = loadDevOverlay({
      rootDir: root,
      readFile: files({
        [join(root, 'dev.config.json')]: JSON.stringify({
          llama: { backend: 'vulkan' },
          models: { autoDownload: false, paths: { ocr: 'models/ocr.gguf' } },
        }),
        [join(root, 'dev.config.local.json')]: JSON.stringify({ models: { paths: { ocr: 'D:/mine/ocr.gguf' } } }),
      }),
    })
    expect(result.sources).toHaveLength(2)
    expect(result.warnings).toEqual([])
    const models = result.overlay['models'] as { autoDownload: boolean; paths: { ocr: string } }
    expect(models.autoDownload).toBe(false)
    expect(models.paths.ocr).toBe('D:/mine/ocr.gguf') // absolute paths are kept as written
    expect(isAbsolute(models.paths.ocr)).toBe(true)
  })

  it('honours RAWREADER_DEV_CONFIG instead of dev.config.json', () => {
    const custom = join(root, 'custom.json')
    const result = loadDevOverlay({
      rootDir: root,
      env: { RAWREADER_DEV_CONFIG: 'custom.json' },
      readFile: files({
        [join(root, 'dev.config.json')]: JSON.stringify({ ui: { autoTranslate: true } }),
        [custom]: JSON.stringify({ ui: { overlayVisible: false } }),
      }),
    })
    expect(result.sources).toEqual([custom])
    expect(result.overlay).toEqual({ ui: { overlayVisible: false } })
  })

  it('returns an empty overlay when no file exists', () => {
    const result = loadDevOverlay({ rootDir: root, readFile: () => null })
    expect(result).toEqual({ overlay: {}, sources: [], warnings: [] })
  })

  it('warns about invalid JSON and missing explicit files without throwing', () => {
    const bad = loadDevOverlay({ rootDir: root, readFile: files({ [join(root, 'dev.config.json')]: '{ nope' }) })
    expect(bad.overlay).toEqual({})
    expect(bad.warnings).toHaveLength(1)

    const missing = loadDevOverlay({ rootDir: root, env: { RAWREADER_DEV_CONFIG: 'gone.json' }, readFile: () => null })
    expect(missing.warnings).toHaveLength(1)
  })
})
