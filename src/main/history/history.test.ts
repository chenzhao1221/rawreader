import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log/log'
import { historyGroup } from '../../shared/history-group'
import { HISTORY_MAX_TITLE, HISTORY_MAX_URL, cleanTouch, normalizeHistoryUrl, searchWords } from './record'
import type { HistoryTouch } from './record'
import { openHistoryStore } from './store'
import type { HistoryStore } from './store'
import { attachHistoryRecorder } from './tab-recorder'
import type { RecorderTarget } from './tab-recorder'

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
const MIN = 60_000

describe('normalizeHistoryUrl', () => {
  it('keeps http(s), drops the fragment and tracking parameters, keeps real parameters', () => {
    expect(normalizeHistoryUrl('https://reader.example.com/c/1?page=2&utm_source=x&fbclid=y#top')).toBe('https://reader.example.com/c/1?page=2')
  })
  it('rejects other schemes, garbage and very long addresses', () => {
    expect(normalizeHistoryUrl('file:///C:/a.png')).toBeNull()
    expect(normalizeHistoryUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeHistoryUrl('not a url')).toBeNull()
    expect(normalizeHistoryUrl(`https://example.com/${'a'.repeat(HISTORY_MAX_URL)}`)).toBeNull()
  })
})

describe('cleanTouch', () => {
  it('clips and collapses text, derives the site and clamps a future time to now', () => {
    const clean = cleanTouch({ url: 'https://Reader.Example.com/a', title: `  A\n\n  ${'x'.repeat(500)}`, series: ' S ', at: NOW + 99 * MIN }, NOW)
    expect(clean).toMatchObject({ url: 'https://reader.example.com/a', site: 'reader.example.com', series: 'S', chapter: '', at: NOW, refresh: false })
    expect(clean?.title.length).toBe(HISTORY_MAX_TITLE)
    expect(clean?.title.startsWith('A xxx')).toBe(true)
  })
  it('uses now for a missing or invalid time and null for an unusable address', () => {
    expect(cleanTouch({ url: 'https://example.com/', at: Number.NaN }, NOW)?.at).toBe(NOW)
    expect(cleanTouch({ url: 'ftp://example.com/' }, NOW)).toBeNull()
  })
})

describe('searchWords / historyGroup', () => {
  it('lower-cases, splits on blanks and caps the number of words', () => {
    expect(searchWords('  Foo  BAR ')).toEqual(['foo', 'bar'])
    expect(searchWords('a b c d e f g h i j')).toHaveLength(8)
    expect(searchWords('   ')).toEqual([])
  })
  it('puts a visit into today, yesterday or earlier by local day', () => {
    const now = new Date(2026, 10, 24, 15, 0, 0).getTime()
    expect(historyGroup(new Date(2026, 10, 24, 0, 5).getTime(), now)).toBe('today')
    expect(historyGroup(new Date(2026, 10, 23, 23, 59).getTime(), now)).toBe('yesterday')
    expect(historyGroup(new Date(2026, 10, 22, 12, 0).getTime(), now)).toBe('earlier')
  })
})

describe('HistoryStore', () => {
  let dir: string
  let clock: number
  let store: HistoryStore

  const open = (maxEntries?: number): HistoryStore => {
    const opened = openHistoryStore(join(dir, 'history', 'history.db'), {
      logger: silentLogger,
      now: () => clock,
      ...(maxEntries !== undefined ? { maxEntries } : {}),
    })
    if (!opened) throw new Error('history store did not open')
    return opened
  }
  const urls = (): string[] => store.list('', 100, 0).entries.map((e) => e.url)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-history-'))
    clock = NOW
    store = open()
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores a visit with title, site and times', () => {
    expect(store.touch({ url: 'https://reader.example.com/a?x=1', title: 'Page A' })).toBe(true)
    const [entry] = store.list('', 10, 0).entries
    expect(entry).toMatchObject({ url: 'https://reader.example.com/a?x=1', title: 'Page A', site: 'reader.example.com', visits: 1, firstVisitedAt: NOW, lastVisitedAt: NOW })
  })

  it('ignores addresses it must not store', () => {
    expect(store.touch({ url: 'about:blank' })).toBe(false)
    expect(store.touch({ url: 'file:///a' })).toBe(false)
    expect(store.count()).toBe(0)
  })

  it('counts the same address once within five seconds, then counts a new visit', () => {
    store.touch({ url: 'https://example.com/a', title: 'A' })
    clock += 2_000
    expect(store.touch({ url: 'https://example.com/a', title: 'A' })).toBe(false)
    clock += 10_000
    expect(store.touch({ url: 'https://example.com/a', title: 'A2' })).toBe(true)
    expect(store.list('', 10, 0).entries[0]).toMatchObject({ visits: 2, title: 'A2', firstVisitedAt: NOW, lastVisitedAt: NOW + 12_000 })
  })

  it('a refresh fills in the title without counting a visit or moving the time', () => {
    store.touch({ url: 'https://example.com/a', title: 'example.com' })
    clock += 60_000
    expect(store.touch({ url: 'https://example.com/a', title: 'Real title', refresh: true })).toBe(true)
    expect(store.touch({ url: 'https://example.com/a', title: 'Real title', refresh: true })).toBe(false)
    expect(store.list('', 10, 0).entries[0]).toMatchObject({ title: 'Real title', visits: 1, lastVisitedAt: NOW })
  })

  it('a refresh never brings back an entry that was deleted', () => {
    store.touch({ url: 'https://example.com/a', title: 'A' })
    const id = store.list('', 10, 0).entries[0]!.id
    store.remove(id)
    expect(store.touch({ url: 'https://example.com/a', title: 'A', refresh: true })).toBe(false)
    expect(store.count()).toBe(0)
  })

  it('merges pages of one series and chapter within 30 minutes into one entry pointing at the newest page', () => {
    const page = (n: number, at: number): HistoryTouch => ({ url: `https://reader.example.com/c/9/p${n}`, title: `Ch 9 p${n}`, series: 'Series', chapter: '9', at })
    clock = NOW + 60 * MIN // visits in the past, so none is clamped to "now"
    store.touch(page(1, NOW))
    store.touch(page(2, NOW + 10 * MIN))
    expect(store.count()).toBe(1)
    expect(store.list('', 10, 0).entries[0]).toMatchObject({ url: 'https://reader.example.com/c/9/p2', visits: 2, firstVisitedAt: NOW, lastVisitedAt: NOW + 10 * MIN })
    store.touch(page(3, NOW + 10 * MIN + 31 * MIN))
    expect(store.count()).toBe(2)
  })

  it('does not merge when series or chapter is missing', () => {
    store.touch({ url: 'https://reader.example.com/p1', title: 'a', series: 'S' })
    store.touch({ url: 'https://reader.example.com/p2', title: 'b', series: 'S' })
    expect(store.count()).toBe(2)
  })

  it('lists newest first and applies the batch of an extension backlog in time order', () => {
    const changed = store.touchMany([
      { url: 'https://example.com/new', at: NOW - 1 * MIN },
      { url: 'https://example.com/old', at: NOW - 90 * MIN },
      { url: 'https://example.com/mid', at: NOW - 30 * MIN },
      { url: 'ftp://example.com/skipped', at: NOW },
    ])
    expect(changed).toBe(3)
    expect(urls()).toEqual(['https://example.com/new', 'https://example.com/mid', 'https://example.com/old'])
  })

  it('searches every word over title, address, site and series, case-insensitively', () => {
    store.touch({ url: 'https://one.example.com/a', title: 'Hero Chapter 1', series: 'Hero' })
    store.touch({ url: 'https://two.example.org/b', title: '勇者 第二话' })
    expect(store.list('hero chapter', 10, 0).total).toBe(1)
    expect(store.list('EXAMPLE.ORG', 10, 0).total).toBe(1)
    expect(store.list('第二话', 10, 0).entries[0]?.title).toBe('勇者 第二话')
    expect(store.list('hero 勇者', 10, 0).total).toBe(0)
  })

  it('treats % and _ in a search as plain characters', () => {
    store.touch({ url: 'https://example.com/a', title: '100% sure' })
    store.touch({ url: 'https://example.com/b', title: 'plain' })
    expect(store.list('100%', 10, 0).total).toBe(1)
    expect(store.list('%', 10, 0).total).toBe(1)
    expect(store.list('_', 10, 0).total).toBe(0)
  })

  it('pages the list and reports the total', () => {
    for (let i = 0; i < 5; i++) {
      clock += 10_000
      store.touch({ url: `https://example.com/${i}` })
    }
    const page = store.list('', 2, 2)
    expect(page.total).toBe(5)
    expect(page.entries.map((e) => e.url)).toEqual(['https://example.com/2', 'https://example.com/1'])
  })

  it('deletes one entry and returns how many are left; clear removes all', () => {
    store.touch({ url: 'https://example.com/a' })
    store.touch({ url: 'https://example.com/b' })
    const id = store.list('', 10, 0).entries[0]!.id
    expect(store.remove(id)).toBe(1)
    expect(store.remove(999_999)).toBe(1)
    store.clear()
    expect(store.count()).toBe(0)
  })

  it('keeps at most maxEntries and drops the oldest visits', () => {
    store.close()
    store = open(3)
    for (let i = 0; i < 5; i++) {
      clock += 10_000
      store.touch({ url: `https://example.com/${i}` })
    }
    expect(urls()).toEqual(['https://example.com/4', 'https://example.com/3', 'https://example.com/2'])
  })

  it('keeps its data when reopened', () => {
    store.touch({ url: 'https://example.com/a', title: 'A' })
    store.close()
    store = open()
    expect(urls()).toEqual(['https://example.com/a'])
  })
})

class FakeTab extends EventEmitter implements RecorderTarget {
  url = ''
  title = ''
  destroyed = false
  getURL = (): string => this.url
  getTitle = (): string => this.title
  isDestroyed = (): boolean => this.destroyed
}

describe('attachHistoryRecorder', () => {
  const setup = () => {
    const tab = new FakeTab()
    const seen: HistoryTouch[] = []
    attachHistoryRecorder(tab, (touch) => seen.push(touch))
    return { tab, seen }
  }

  it('records a main-frame navigation as a visit, then completes it on title and load end without more visits', () => {
    const { tab, seen } = setup()
    tab.url = 'https://reader.example.com/c/1'
    tab.title = 'reader.example.com/c/1'
    tab.emit('did-navigate', {}, tab.url)
    tab.title = 'Chapter 1'
    tab.emit('page-title-updated', {}, tab.title)
    tab.emit('did-stop-loading')
    expect(seen).toEqual([
      { url: tab.url, title: 'reader.example.com/c/1', refresh: false },
      { url: tab.url, title: 'Chapter 1', refresh: true },
      { url: tab.url, title: 'Chapter 1', refresh: true },
    ])
  })

  it('counts an in-page navigation of the main frame, not one of a subframe', () => {
    const { tab, seen } = setup()
    tab.url = 'https://reader.example.com/c/2'
    tab.emit('did-navigate-in-page', {}, tab.url, false)
    expect(seen).toHaveLength(0)
    tab.emit('did-navigate-in-page', {}, tab.url, true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ url: tab.url, refresh: false })
  })

  it('ignores a title or load event for a page it did not record as a visit', () => {
    const { tab, seen } = setup()
    tab.url = 'https://reader.example.com/c/3'
    tab.emit('did-stop-loading')
    tab.emit('page-title-updated', {}, 'x')
    expect(seen).toHaveLength(0)
  })

  it('ignores non-http pages and a destroyed tab', () => {
    const { tab, seen } = setup()
    tab.url = 'about:blank'
    tab.emit('did-navigate', {}, tab.url)
    tab.url = 'https://reader.example.com/c/4'
    tab.destroyed = true
    tab.emit('did-navigate', {}, tab.url)
    expect(seen).toHaveLength(0)
  })
})
