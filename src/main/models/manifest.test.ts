import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODEL_FILE_NAMES } from '../config/model-path'
import { MODEL_MANIFEST, REQUIRED_DOWNLOAD_ROLES, manifestEntry, sourceUrlsFor } from './manifest'

describe('MODEL_MANIFEST', () => {
  it('covers every role with the default file name', () => {
    expect(MODEL_MANIFEST.map((e) => e.role).sort()).toEqual(['detector', 'ocr', 'ocrMmproj', 'translator'])
    for (const e of MODEL_MANIFEST) expect(e.fileName).toBe(MODEL_FILE_NAMES[e.role])
  })

  it('pins revisions and sha256 values', () => {
    for (const e of MODEL_MANIFEST) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(e.huggingface.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(e.size).toBeGreaterThan(1_000_000)
    }
    expect(manifestEntry('translator').sha256).toBe('044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a')
    expect(manifestEntry('translator').size).toBe(1_312_164_352)
  })

  it('bundles only the detector, which has no ModelScope fallback', () => {
    expect(MODEL_MANIFEST.filter((e) => e.bundled).map((e) => e.role)).toEqual(['detector'])
    expect(manifestEntry('detector').modelscope).toBeNull()
    expect(REQUIRED_DOWNLOAD_ROLES).toEqual(['ocr', 'ocrMmproj', 'translator'])
  })
})

describe('sourceUrlsFor', () => {
  const mirrors = { huggingface: 'https://hf-mirror.com/', modelscope: 'https://modelscope.cn' }

  it('puts the Hugging Face mirror first and ModelScope second', () => {
    expect(sourceUrlsFor(manifestEntry('translator'), mirrors)).toEqual([
      {
        source: 'huggingface',
        url: 'https://hf-mirror.com/IndexTeam/Index-Translate-2B-GGUF/resolve/3a0eca6ce931d88d00614d427ab3ed8ff0743902/Index-Translate-2B.Q4_K_M.gguf',
      },
      {
        source: 'modelscope',
        url: 'https://modelscope.cn/models/IndexTeam/Index-Translate-2B-GGUF/resolve/master/Index-Translate-2B.Q4_K_M.gguf',
      },
    ])
  })

  it('has a single source for a file without a ModelScope repo', () => {
    expect(sourceUrlsFor(manifestEntry('detector'), mirrors)).toHaveLength(1)
  })

  it('uses configurable base URLs', () => {
    const urls = sourceUrlsFor(manifestEntry('ocr'), { huggingface: 'http://127.0.0.1:9', modelscope: 'http://127.0.0.1:8/' })
    expect(urls[0]?.url.startsWith('http://127.0.0.1:9/PaddlePaddle/')).toBe(true)
    expect(urls[1]?.url.startsWith('http://127.0.0.1:8/models/PaddlePaddle/')).toBe(true)
  })
})

describe('scripts/fetch-resources.mjs', () => {
  const script = readFileSync(join(import.meta.dirname, '../../../scripts/fetch-resources.mjs'), 'utf8')

  it('pins the same detector file as the manifest', () => {
    const detector = manifestEntry('detector')
    expect(script).toContain(detector.sha256)
    expect(script).toContain(String(detector.size).replace(/(\d)(?=(\d{3})+$)/g, '$1_'))
    expect(script).toContain(detector.fileName)
  })

  it('pins the build used for the CUDA assets', async () => {
    const { CUDA_BUILD } = await import('./cuda')
    expect(script).toContain(`LLAMA_BUILD = '${CUDA_BUILD}'`)
  })
})
