import { describe, expect, it } from 'vitest'
import { ConfigPatchSchema, ConfigSchema } from './schema'

describe('ConfigSchema defaults', () => {
  it('matches the documented defaults', () => {
    expect(ConfigSchema.parse({})).toEqual({
      schemaVersion: 1,
      ui: {
        autoTranslate: false,
        overlayVisible: true,
        bubblesOnly: false,
        adBlock: true,
        lastUrl: null,
        openTabs: { urls: [], active: 0 },
        webTranslate: { alwaysLangs: [], neverLangs: [], neverSites: [] },
        trayHintShown: false,
        setupDone: false,
      },
      llama: {
        build: 'b12318',
        backend: 'vulkan',
        binDirs: { vulkan: null, cuda: null, custom: null },
        startupTimeoutMs: 120_000,
        ocr: {
          port: 18791,
          ctxSize: 4096,
          nGpuLayers: 99,
          parallel: 1,
          cacheRamMb: 256,
          flashAttn: 'auto',
          alias: 'PaddleOCR-VL-1.5',
          extraArgs: [],
          autostart: true,
        },
        translate: {
          port: 18792,
          ctxSize: 8192,
          nGpuLayers: 99,
          parallel: 1,
          cacheRamMb: 256,
          flashAttn: 'on',
          alias: 'Index-Translate-2B',
          extraArgs: [],
          autostart: true,
          temp: 0,
          reasoning: 'off',
        },
      },
      models: {
        dir: null,
        paths: { detector: null, ocr: null, ocrMmproj: null, translator: null },
        autoDownload: true,
        translator: 'index-2b',
        translatorPaths: {},
        mirrors: { huggingface: 'https://hf-mirror.com', modelscope: 'https://modelscope.cn' },
      },
      pipeline: {
        detectConcurrency: 1,
        ocrConcurrency: null,
        translateConcurrency: null,
        minImageSize: 200,
        rootMarginPx: 1000,
        maxImageBytes: 50 * 1024 * 1024,
        readingDirection: 'ltr',
        maxBoxImageCoverage: 0.85,
      },
      translate: {
        targetLang: 'zh-Hans',
        promptVariant: 'lmt',
        contextUnits: 3,
        batch: true,
        engine: 'local',
        api: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        gemini: { model: 'gemini-2.5-flash' },
      },
      cache: { maxBytes: 2 * 1024 ** 3 },
    })
  })

  it('applies nested defaults when a section is partially present', () => {
    const config = ConfigSchema.parse({ llama: { ocr: { port: 19000 } } })
    expect(config.llama.ocr.port).toBe(19000)
    expect(config.llama.ocr.ctxSize).toBe(4096)
    expect(config.llama.translate.port).toBe(18792)
  })

  it('rejects --host and --port in extraArgs, including the = form', () => {
    expect(ConfigSchema.safeParse({ llama: { ocr: { extraArgs: ['--host', '0.0.0.0'] } } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ llama: { translate: { extraArgs: ['--port=9999'] } } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ llama: { ocr: { extraArgs: ['--threads', '4'] } } }).success).toBe(true)
  })
})

describe('ConfigPatchSchema', () => {
  it('does not inject defaults into a patch', () => {
    expect(ConfigPatchSchema.parse({ llama: { ocr: { port: 19000 } } })).toEqual({ llama: { ocr: { port: 19000 } } })
    expect(ConfigPatchSchema.parse({})).toEqual({})
  })

  it('rejects fields outside the whitelist', () => {
    expect(ConfigPatchSchema.safeParse({ ui: { lastUrl: 'https://example.com' } }).success).toBe(false)
    expect(ConfigPatchSchema.safeParse({ ui: { trayHintShown: true } }).success).toBe(false)
    expect(ConfigPatchSchema.safeParse({ schemaVersion: 1 }).success).toBe(false)
    expect(ConfigPatchSchema.safeParse({ llama: { build: 'b1' } }).success).toBe(false)
  })

  it('accepts the bubblesOnly toggle in a patch and rejects non-booleans', () => {
    expect(ConfigPatchSchema.parse({ ui: { bubblesOnly: true } })).toEqual({ ui: { bubblesOnly: true } })
    expect(ConfigPatchSchema.safeParse({ ui: { bubblesOnly: 'yes' } }).success).toBe(false)
  })

  it('keeps translate-bar preferences main-process only: the shell cannot patch them', () => {
    expect(ConfigPatchSchema.safeParse({ ui: { webTranslate: { neverSites: ['example.com'] } } }).success).toBe(false)
  })

  it('rejects invalid values', () => {
    expect(ConfigPatchSchema.safeParse({ llama: { ocr: { port: 80 } } }).success).toBe(false)
    expect(ConfigPatchSchema.safeParse({ llama: { backend: 'metal' } }).success).toBe(false)
    expect(ConfigPatchSchema.safeParse({ llama: { ocr: { extraArgs: ['--host'] } } }).success).toBe(false)
  })

  it('accepts maxBoxImageCoverage in (0, 1] and rejects 0 and values above 1', () => {
    const parse = (v: number) => ConfigPatchSchema.safeParse({ pipeline: { maxBoxImageCoverage: v } }).success
    expect(parse(0.5)).toBe(true)
    expect(parse(1)).toBe(true)
    expect(parse(0)).toBe(false)
    expect(parse(1.01)).toBe(false)
    expect(ConfigSchema.safeParse({ pipeline: { maxBoxImageCoverage: 0 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ pipeline: { maxBoxImageCoverage: 2 } }).success).toBe(false)
  })

  it('accepts null to clear a path override', () => {
    expect(ConfigPatchSchema.safeParse({ models: { paths: { ocr: null } } }).success).toBe(true)
  })
})
