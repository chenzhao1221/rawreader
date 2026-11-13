import { describe, expect, it } from 'vitest'
import { cycle, insertIndex, nextAfterClose, restorePlan, shortcutFor } from './tab-order'

function key(overrides: Partial<{ type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }>) {
  return { type: 'keyDown', key: '', control: false, shift: false, alt: false, meta: false, ...overrides }
}

describe('shortcutFor', () => {
  it('maps the tab shortcuts', () => {
    expect(shortcutFor(key({ key: 't', control: true }))).toBe('new-tab')
    expect(shortcutFor(key({ key: 'w', control: true }))).toBe('close-tab')
    expect(shortcutFor(key({ key: 'l', control: true }))).toBe('focus-address')
    expect(shortcutFor(key({ key: 'Tab', control: true }))).toBe('next-tab')
    expect(shortcutFor(key({ key: 'Tab', control: true, shift: true }))).toBe('previous-tab')
  })

  it('maps F5 to reload, with or without Ctrl', () => {
    expect(shortcutFor(key({ key: 'F5' }))).toBe('reload')
    expect(shortcutFor(key({ key: 'F5', control: true }))).toBe('reload')
  })

  it('ignores other keys and modifier combinations', () => {
    expect(shortcutFor(key({ key: 't' }))).toBeNull()
    expect(shortcutFor(key({ key: 't', control: true, shift: true }))).toBeNull()
    expect(shortcutFor(key({ key: 't', control: true, alt: true }))).toBeNull()
    expect(shortcutFor(key({ key: 'w', meta: true }))).toBeNull()
    expect(shortcutFor(key({ key: 'x', control: true }))).toBeNull()
  })

  it('only reacts to key presses, not releases', () => {
    expect(shortcutFor(key({ type: 'keyUp', key: 't', control: true }))).toBeNull()
  })
})

describe('insertIndex', () => {
  it('inserts after the active tab', () => {
    expect(insertIndex([1, 2, 3], 2)).toBe(2)
    expect(insertIndex([1, 2, 3], 3)).toBe(3)
  })

  it('appends when there is no active tab or it is gone', () => {
    expect(insertIndex([], null)).toBe(0)
    expect(insertIndex([1, 2], null)).toBe(2)
    expect(insertIndex([1, 2], 9)).toBe(2)
  })
})

describe('nextAfterClose', () => {
  it('keeps the active tab when another tab closes', () => {
    expect(nextAfterClose([1, 2, 3], 1, 2)).toBe(2)
  })

  it('picks the right neighbour, then the left one', () => {
    expect(nextAfterClose([1, 2, 3], 2, 2)).toBe(3)
    expect(nextAfterClose([1, 2, 3], 3, 3)).toBe(2)
    expect(nextAfterClose([1], 1, 1)).toBeNull()
  })

  it('falls back to the first remaining tab when the active one is gone', () => {
    expect(nextAfterClose([1, 2], 9, 9)).toBe(1)
  })
})

describe('cycle', () => {
  it('wraps in both directions', () => {
    expect(cycle([1, 2, 3], 3, 1)).toBe(1)
    expect(cycle([1, 2, 3], 1, -1)).toBe(3)
    expect(cycle([1, 2, 3], 2, 1)).toBe(3)
  })

  it('returns the first tab when none is active, and null when empty', () => {
    expect(cycle([1, 2], null, 1)).toBe(1)
    expect(cycle([], null, 1)).toBeNull()
  })
})

describe('restorePlan', () => {
  const isHttp = (url: string): boolean => url.startsWith('https://')

  it('drops non-http URLs and caps the count', () => {
    const plan = restorePlan({ urls: ['https://a', 'file:///b', 'https://c', 'https://d'], active: 2 }, null, isHttp, 2)
    expect(plan).toEqual({ urls: ['https://a', 'https://c'], active: 1 })
  })

  it('falls back to the last URL when nothing is restorable', () => {
    expect(restorePlan({ urls: [], active: 0 }, 'https://last', isHttp, 10)).toEqual({ urls: ['https://last'], active: 0 })
    expect(restorePlan({ urls: ['file:///a'], active: 0 }, 'file:///last', isHttp, 10)).toEqual({ urls: [], active: 0 })
  })

  it('clamps the active index into range', () => {
    expect(restorePlan({ urls: ['https://a'], active: 5 }, null, isHttp, 10).active).toBe(0)
    expect(restorePlan({ urls: ['https://a', 'https://b'], active: 0 }, null, isHttp, 10).active).toBe(0)
  })
})
