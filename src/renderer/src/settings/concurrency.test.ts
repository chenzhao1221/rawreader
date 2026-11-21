import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../../shared/config/schema'
import { CONCURRENCY_OPTIONS, concurrencyOptionValue, concurrencySelectValue, parseConcurrencyInput } from './concurrency'

describe('concurrency select', () => {
  it('shows the auto option when nothing is saved', () => {
    expect(concurrencySelectValue(null)).toBe('')
    expect(concurrencySelectValue(undefined)).toBe('')
  })

  it('shows the saved number', () => {
    expect(concurrencySelectValue(3)).toBe(3)
  })

  it('the default config value selects an existing option', () => {
    const config = ConfigSchema.parse({})
    for (const saved of [config.pipeline.ocrConcurrency, config.pipeline.translateConcurrency]) {
      const shown = concurrencySelectValue(saved)
      expect(CONCURRENCY_OPTIONS.map(concurrencyOptionValue)).toContain(shown)
    }
  })

  it('round-trips auto and numbers', () => {
    expect(parseConcurrencyInput('')).toBeNull()
    expect(parseConcurrencyInput('4')).toBe(4)
    for (const option of CONCURRENCY_OPTIONS) {
      expect(parseConcurrencyInput(String(concurrencyOptionValue(option)))).toBe(option)
    }
  })
})
