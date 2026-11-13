import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { MAX_UNITS_PER_IMAGE, OCR_PADDING_PX, pageConfigFrom, pipelineSettingsFrom } from './settings'

describe('pipeline settings', () => {
  it('defaults stage concurrency to the server -np values', () => {
    const config = ConfigSchema.parse({})
    expect(pipelineSettingsFrom(config)).toMatchObject({
      ocrConcurrency: 1,
      translateConcurrency: 1,
      readingDirection: 'ltr',
      maxBoxImageCoverage: 0.85,
      ocrPadding: OCR_PADDING_PX,
      maxUnitsPerImage: MAX_UNITS_PER_IMAGE,
      maxImageBytes: 50 * 1024 * 1024,
    })
  })

  it('keeps free units by default and follows the bubblesOnly toggle', () => {
    expect(pipelineSettingsFrom(ConfigSchema.parse({})).bubblesOnly).toBe(false)
    expect(pipelineSettingsFrom(ConfigSchema.parse({ ui: { bubblesOnly: true } })).bubblesOnly).toBe(true)
  })

  it('prefers explicit pipeline concurrency', () => {
    const config = ConfigSchema.parse({
      llama: { translate: { parallel: 2 } },
      pipeline: { translateConcurrency: 4, ocrConcurrency: 3 },
    })
    expect(pipelineSettingsFrom(config)).toMatchObject({ ocrConcurrency: 3, translateConcurrency: 4 })
    const fallback = ConfigSchema.parse({ llama: { translate: { parallel: 2 } } })
    expect(pipelineSettingsFrom(fallback).translateConcurrency).toBe(2)
  })

  it('derives the page config from the auto-translate toggle and scan settings', () => {
    const config = ConfigSchema.parse({ ui: { autoTranslate: true }, pipeline: { minImageSize: 300, rootMarginPx: 400 } })
    expect(pageConfigFrom(config)).toEqual({ enabled: true, overlayVisible: true, minImageSize: 300, rootMarginPx: 400 })
    expect(pageConfigFrom(ConfigSchema.parse({})).enabled).toBe(false)
  })
})
