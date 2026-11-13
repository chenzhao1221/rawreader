import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { buildCacheIdentity, buildCacheKey, modelFileId, promptIdentity } from './key'
import type { CacheIdentity } from './key'

const identity: CacheIdentity = {
  lang: 'zh-Hans',
  detectorId: 'detector-v4-s_int8.onnx:11120765',
  ocrModelId: 'PaddleOCR-VL-1.5.gguf:935768992',
  mtModelId: 'Index-Translate-2B.Q4_K_M.gguf:1312164352',
  promptVersion: 'lmt-2+ctx3+ltr+cov0.85',
}

describe('buildCacheKey', () => {
  it('joins the content hash and every identity part with |', () => {
    expect(buildCacheKey('abc', identity)).toBe(
      'abc|zh-Hans|detector-v4-s_int8.onnx:11120765|PaddleOCR-VL-1.5.gguf:935768992|Index-Translate-2B.Q4_K_M.gguf:1312164352|lmt-2+ctx3+ltr+cov0.85',
    )
  })

  it('changes when any part changes', () => {
    const base = buildCacheKey('abc', identity)
    expect(buildCacheKey('abd', identity)).not.toBe(base)
    for (const field of Object.keys(identity) as Array<keyof CacheIdentity>) {
      expect(buildCacheKey('abc', { ...identity, [field]: `${identity[field]}x` })).not.toBe(base)
    }
  })

  it('keeps the separator out of the parts so two identities cannot collide', () => {
    const a = buildCacheKey('h', { ...identity, lang: 'a|b', detectorId: 'c' })
    const b = buildCacheKey('h', { ...identity, lang: 'a', detectorId: 'b|c' })
    expect(a).not.toBe(b)
    expect(a.split('|')).toHaveLength(6)
  })
})

describe('model and prompt identity', () => {
  it('uses file name and size, and marks missing files', () => {
    expect(modelFileId('ocr', 'C:\\m\\PaddleOCR-VL-1.5.gguf', () => 42)).toBe('PaddleOCR-VL-1.5.gguf:42')
    expect(modelFileId('ocr', { missing: true, expectedPath: 'x' }, () => 42)).toBe('PaddleOCR-VL-1.5.gguf:missing')
    expect(modelFileId('ocr', 'C:\\m\\a.gguf', () => null)).toBe('a.gguf:unknown')
  })

  it('includes prompt variant, context length and reading direction', () => {
    const base = promptIdentity(ConfigSchema.parse({}))
    expect(base).toBe('lmt-3+ctx3+ltr+cov0.85')
    expect(promptIdentity(ConfigSchema.parse({ translate: { promptVariant: 'baseline' } }))).not.toBe(base)
    expect(promptIdentity(ConfigSchema.parse({ translate: { contextUnits: 0 } }))).not.toBe(base)
    expect(promptIdentity(ConfigSchema.parse({ pipeline: { readingDirection: 'rtl' } }))).not.toBe(base)
    expect(promptIdentity(ConfigSchema.parse({ pipeline: { maxBoxImageCoverage: 0.9 } }))).not.toBe(base)
  })

  it('builds the identity from resolved model paths', () => {
    const id = buildCacheIdentity(
      ConfigSchema.parse({}),
      { detector: 'd.onnx', ocr: 'o.gguf', translator: { missing: true, expectedPath: 't' } },
      () => 7,
    )
    expect(id).toMatchObject({ lang: 'zh-Hans', detectorId: 'd.onnx:7', ocrModelId: 'o.gguf:7', mtModelId: 'Index-Translate-2B.Q4_K_M.gguf:missing' })
  })
})