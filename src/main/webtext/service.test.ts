import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../log/log'
import type { WebTextBar, WebTextCommand } from '../../shared/ipc/contract'
import type { WebTranslatePrefs } from './policy'
import { WebTextService } from './service'

const EMPTY: WebTranslatePrefs = { alwaysLangs: [], neverLangs: [], neverSites: [] }

interface SetupOptions {
  prefs?: WebTranslatePrefs
  active?: number | null
  host?: string
  detected?: string
}

function setup(options: SetupOptions = {}) {
  let prefs = options.prefs ?? EMPTY
  let active = options.active === undefined ? 1 : options.active
  const commands: Array<{ tabId: number; command: WebTextCommand }> = []
  const bars: WebTextBar[] = []
  const translate = vi.fn(async (texts: readonly string[]) => ({
    translations: texts.map((text) => `译${text}`),
    detected: options.detected ?? '',
  }))
  const service = new WebTextService({
    translator: { translate },
    getPrefs: () => prefs,
    setPrefs: (next) => {
      prefs = next
    },
    sendCommand: (tabId, command) => commands.push({ tabId, command }),
    sendBar: (bar) => bars.push(bar),
    getActiveTabId: () => active,
    getHost: () => options.host ?? 'example.com',
    logger: silentLogger,
  })
  return {
    service,
    translate,
    commands,
    bars,
    lastBar: () => bars.at(-1),
    prefs: () => prefs,
    setActive: (id: number | null) => {
      active = id
    },
  }
}

const page = (lang: string, sample = '', docId = 'doc-1') => ({ docId, lang, sample })

describe('WebTextService pageReady', () => {
  it('offers a translation for a foreign page', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en-US'))
    expect(h.lastBar()).toEqual({ tabId: 1, state: 'offer', lang: 'en', host: 'example.com' })
  })

  it('stays hidden for Chinese and unknown languages', async () => {
    const h = setup()
    await h.service.pageReady(1, page('zh-Hans'))
    expect(h.lastBar()?.state).toBe('hidden')
  })

  it('detects the language from a sample when <html lang> is missing', async () => {
    const h = setup({ detected: 'ko' })
    await h.service.pageReady(1, page('', '안녕하세요'))
    expect(h.translate).toHaveBeenCalledWith(['안녕하세요'])
    expect(h.lastBar()).toEqual({ tabId: 1, state: 'offer', lang: 'ko', host: 'example.com' })
  })

  it('translates at once for an always language', async () => {
    const h = setup({ prefs: { ...EMPTY, alwaysLangs: ['en'] } })
    await h.service.pageReady(1, page('en'))
    expect(h.commands).toEqual([{ tabId: 1, command: { action: 'translate' } }])
    expect(h.lastBar()?.state).toBe('translating')
  })

  it('drops a slow detection after the tab navigated', async () => {
    let resolve!: (value: { translations: string[]; detected: string }) => void
    const translate = vi.fn(
      () =>
        new Promise<{ translations: string[]; detected: string }>((done) => {
          resolve = done
        }),
    )
    const bars: WebTextBar[] = []
    const service = new WebTextService({
      translator: { translate },
      getPrefs: () => EMPTY,
      setPrefs: () => {},
      sendCommand: () => {},
      sendBar: (bar) => bars.push(bar),
      getActiveTabId: () => 1,
      getHost: () => 'example.com',
      logger: silentLogger,
    })
    const pending = service.pageReady(1, page('', 'bonjour'))
    service.forget(1)
    resolve({ translations: ['hello'], detected: 'fr' })
    await pending
    expect(service.barFor(1)).toEqual({ tabId: 1, state: 'hidden', lang: '', host: '' })
  })
})

describe('WebTextService translate', () => {
  it('translates the texts of the current document', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    await expect(h.service.translate(1, { docId: 'doc-1', texts: ['Hello'] })).resolves.toEqual(['译Hello'])
  })

  it('rejects a stale document', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    await expect(h.service.translate(1, { docId: 'doc-2', texts: ['Hello'] })).rejects.toThrow(/Stale/)
  })

  it('rejects an oversized request before calling Google', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    const texts = Array.from({ length: 13 }, () => 'a'.repeat(5000))
    await expect(h.service.translate(1, { docId: 'doc-1', texts })).rejects.toThrow(/too large/)
    expect(h.translate).not.toHaveBeenCalled()
  })
})

describe('WebTextService done', () => {
  it('shows the translated bar', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.done(1, 'doc-1', 'translated')
    expect(h.lastBar()?.state).toBe('translated')
  })

  it('shows the offer again after showing the original', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.done(1, 'doc-1', 'restored')
    expect(h.lastBar()?.state).toBe('offer')
  })

  it('does not show the offer again after "never translate this site"', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.barAction({ tabId: 1, action: 'never-site' })
    h.service.done(1, 'doc-1', 'restored')
    expect(h.lastBar()?.state).toBe('hidden')
  })

  it('ignores a result from another document', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.done(1, 'doc-2', 'translated')
    expect(h.lastBar()?.state).toBe('offer')
  })
})

describe('WebTextService barAction', () => {
  it('starts translating', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.barAction({ tabId: 1, action: 'translate' })
    expect(h.commands.at(-1)?.command).toEqual({ action: 'translate' })
    expect(h.lastBar()?.state).toBe('translating')
  })

  it('asks the page to show its original text', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.done(1, 'doc-1', 'translated')
    h.service.barAction({ tabId: 1, action: 'restore' })
    expect(h.commands.at(-1)?.command).toEqual({ action: 'restore' })
  })

  it('remembers "always translate" and translates right away', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.barAction({ tabId: 1, action: 'always' })
    expect(h.prefs().alwaysLangs).toEqual(['en'])
    expect(h.commands.at(-1)?.command).toEqual({ action: 'translate' })
  })

  it('remembers "never translate this language" and restores a translated page', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.done(1, 'doc-1', 'translated')
    h.service.barAction({ tabId: 1, action: 'never-lang' })
    expect(h.prefs().neverLangs).toEqual(['en'])
    expect(h.commands.at(-1)?.command).toEqual({ action: 'restore' })
    expect(h.lastBar()?.state).toBe('hidden')
  })

  it('hides the bar on dismiss but keeps the translated page', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.done(1, 'doc-1', 'translated')
    h.service.barAction({ tabId: 1, action: 'dismiss' })
    expect(h.lastBar()?.state).toBe('hidden')
    expect(h.service.barFor(1).state).toBe('translated')
  })
})

describe('WebTextService.remembered state', () => {
  it('hides the bar for the active tab on navigation', async () => {
    const h = setup()
    await h.service.pageReady(1, page('en'))
    h.service.forget(1)
    expect(h.lastBar()).toEqual({ tabId: 1, state: 'hidden', lang: '', host: '' })
    expect(h.service.barFor(1).state).toBe('hidden')
  })

  it('does not push a bar for an inactive tab', async () => {
    const h = setup()
    h.setActive(2)
    await h.service.pageReady(1, page('en'))
    expect(h.bars).toHaveLength(0)
    expect(h.service.barFor(1).state).toBe('offer')
  })

  it('ignores actions for an unknown tab', () => {
    const h = setup()
    h.service.barAction({ tabId: 9, action: 'translate' })
    expect(h.commands).toHaveLength(0)
  })

  it('returns a hidden bar without a tab', () => {
    const h = setup()
    expect(h.service.barFor(null)).toEqual({ tabId: null, state: 'hidden', lang: '', host: '' })
  })
})
