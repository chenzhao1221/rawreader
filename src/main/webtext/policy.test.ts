import { describe, expect, it } from 'vitest'
import { applyChoice, baseLang, decide, WEBTEXT_LIMITS } from './policy'
import type { WebTranslatePrefs } from './policy'

const none: WebTranslatePrefs = { alwaysLangs: [], neverLangs: [], neverSites: [] }

describe('baseLang', () => {
  it('keeps the primary subtag in lower case', () => {
    expect(baseLang('en-US')).toBe('en')
    expect(baseLang('ZH_hant')).toBe('zh')
    expect(baseLang(' fil ')).toBe('fil')
  })

  it('returns empty for unknown or missing languages', () => {
    expect(baseLang('')).toBe('')
    expect(baseLang('x')).toBe('')
    expect(baseLang('not a language')).toBe('')
  })
})

describe('decide', () => {
  it('offers a translation for a foreign language', () => {
    expect(decide(none, 'example.com', 'en-US')).toBe('offer')
  })

  it('ignores Chinese pages and unknown languages', () => {
    expect(decide(none, 'example.com', 'zh-Hans')).toBe('none')
    expect(decide(none, 'example.com', '')).toBe('none')
  })

  it('translates at once for an always language', () => {
    expect(decide({ ...none, alwaysLangs: ['en'] }, 'example.com', 'en')).toBe('auto')
  })

  it('never offers for a never language or site, even if also always', () => {
    expect(decide({ ...none, neverLangs: ['ko'] }, 'example.com', 'ko')).toBe('none')
    expect(decide({ ...none, neverSites: ['example.com'] }, 'example.com', 'en')).toBe('none')
    expect(decide({ ...none, alwaysLangs: ['en'], neverSites: ['example.com'] }, 'example.com', 'en')).toBe('none')
  })

  it('matches hosts case-insensitively', () => {
    expect(decide({ ...none, neverSites: ['example.com'] }, 'EXAMPLE.com', 'en')).toBe('none')
  })
})

describe('applyChoice', () => {
  it('adds an always language and drops it from never', () => {
    const prefs = applyChoice({ ...none, neverLangs: ['en'] }, 'always', 'example.com', 'en-US')
    expect(prefs.alwaysLangs).toEqual(['en'])
    expect(prefs.neverLangs).toEqual([])
  })

  it('adds a never language and drops it from always', () => {
    const prefs = applyChoice({ ...none, alwaysLangs: ['ko'] }, 'never-lang', 'example.com', 'ko')
    expect(prefs.neverLangs).toEqual(['ko'])
    expect(prefs.alwaysLangs).toEqual([])
  })

  it('adds a never site in lower case and keeps other choices', () => {
    const prefs = applyChoice({ alwaysLangs: ['en'], neverLangs: ['ko'], neverSites: [] }, 'never-site', 'Example.COM', 'ko')
    expect(prefs).toEqual({ alwaysLangs: ['en'], neverLangs: ['ko'], neverSites: ['example.com'] })
  })

  it('does not duplicate an entry', () => {
    const prefs = applyChoice({ ...none, alwaysLangs: ['en'] }, 'always', 'example.com', 'en')
    expect(prefs.alwaysLangs).toEqual(['en'])
    expect(applyChoice({ ...none, neverSites: ['a.com'] }, 'never-site', 'a.com', 'en').neverSites).toEqual(['a.com'])
  })

  it('does not add empty values for an unknown language', () => {
    const prefs = applyChoice(none, 'always', '', '')
    expect(prefs.alwaysLangs).toEqual([])
  })
})

describe('WEBTEXT_LIMITS', () => {
  it('keeps the page-side and main-side limits aligned', () => {
    expect(WEBTEXT_LIMITS.maxItems).toBeGreaterThan(0)
    expect(WEBTEXT_LIMITS.maxItemChars).toBeGreaterThan(0)
    expect(WEBTEXT_LIMITS.maxTotalChars).toBeGreaterThanOrEqual(WEBTEXT_LIMITS.maxItemChars)
  })
})
