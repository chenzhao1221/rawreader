import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { sanitizeConfig } from './sanitize'

describe('sanitizeConfig', () => {
  it('returns defaults without warnings for empty input', () => {
    const { config, warnings } = sanitizeConfig(undefined)
    expect(config).toEqual(ConfigSchema.parse({}))
    expect(warnings).toEqual([])
  })

  it('keeps valid fields and replaces only the invalid one', () => {
    const { config, warnings } = sanitizeConfig({
      ui: { autoTranslate: true },
      llama: { ocr: { port: 'not a number', ctxSize: 2048 }, backend: 'cuda' },
    })
    expect(config.ui.autoTranslate).toBe(true)
    expect(config.llama.backend).toBe('cuda')
    expect(config.llama.ocr.ctxSize).toBe(2048)
    expect(config.llama.ocr.port).toBe(18791)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('llama.ocr.port')
  })

  it('drops a whole array when one element is invalid', () => {
    const { config, warnings } = sanitizeConfig({ llama: { translate: { extraArgs: ['--threads', '--host'] } } })
    expect(config.llama.translate.extraArgs).toEqual([])
    expect(warnings.some((w) => w.includes('llama.translate.extraArgs'))).toBe(true)
  })

  it('replaces a section of the wrong type', () => {
    const { config, warnings } = sanitizeConfig({ llama: 'oops', cache: { maxBytes: -5 } })
    expect(config.llama.ocr.port).toBe(18791)
    expect(config.cache.maxBytes).toBe(2 * 1024 ** 3)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to defaults when the root is not an object', () => {
    const { config, warnings } = sanitizeConfig('garbage')
    expect(config).toEqual(ConfigSchema.parse({}))
    expect(warnings).toHaveLength(1)
  })

  it('does not mutate its input', () => {
    const raw = { llama: { ocr: { port: 'bad' } } }
    sanitizeConfig(raw)
    expect(raw).toEqual({ llama: { ocr: { port: 'bad' } } })
  })
})
