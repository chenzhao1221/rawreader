import type { WebTextBar, WebTextBarAction, WebTextCommand, WebTextPage, WebTextRequest } from '../../shared/ipc/contract'
import type { Logger } from '../log/log'
import type { GoogleTranslator } from './google'
import { WEBTEXT_LIMITS, applyChoice, baseLang, decide } from './policy'
import type { WebTranslatePrefs } from './policy'

type TabState = {
  docId: string
  host: string
  lang: string
  state: WebTextBar['state']
}

export interface WebTextServiceOptions {
  translator: Pick<GoogleTranslator, 'translate'>
  getPrefs: () => WebTranslatePrefs
  setPrefs: (prefs: WebTranslatePrefs) => void
  /** Sends a command to the page of a tab. */
  sendCommand: (tabId: number, command: WebTextCommand) => void
  /** Pushes the bar of the active tab to the shell. */
  sendBar: (bar: WebTextBar) => void
  getActiveTabId: () => number | null
  /** Host of a tab's current page ('' when unknown). */
  getHost: (tabId: number) => string
  logger: Logger
}

const HIDDEN = (tabId: number | null): WebTextBar => ({ tabId, state: 'hidden', lang: '', host: '' })

/**
 * The Chrome-style "translate this page?" bar. Pages report their language once loaded; the bar
 * offers a translation, or the page is translated at once when the language is set to "always".
 * The text itself goes to Google Translate from main, never from the page.
 */
export class WebTextService {
  private readonly tabs = new Map<number, TabState>()
  /** Bumped on every navigation, so a slow language detection cannot overwrite the next page. */
  private readonly generations = new Map<number, number>()

  constructor(private readonly options: WebTextServiceOptions) {}

  /** A page finished loading and reported its language. */
  async pageReady(tabId: number, page: WebTextPage): Promise<void> {
    const generation = this.generations.get(tabId) ?? 0
    const host = this.options.getHost(tabId)
    let lang = baseLang(page.lang)
    if (lang === '' && page.sample.trim().length > 0) {
      // No <html lang>: let Google detect it from a little visible text.
      try {
        lang = baseLang((await this.options.translator.translate([page.sample])).detected)
      } catch (error) {
        this.options.logger.warn(`Language detection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // The tab navigated while we waited: this report belongs to a document that is gone.
    if ((this.generations.get(tabId) ?? 0) !== generation) return
    const decision = decide(this.options.getPrefs(), host, lang)
    const state: TabState = { docId: page.docId, host, lang, state: decision === 'offer' ? 'offer' : 'hidden' }
    this.tabs.set(tabId, state)
    if (decision === 'auto') this.start(tabId, state)
    else this.push(tabId)
  }

  /** Translates a batch of page text. Rejects stale documents and oversized requests. */
  async translate(tabId: number, request: WebTextRequest): Promise<string[]> {
    const state = this.tabs.get(tabId)
    if (!state || state.docId !== request.docId) throw new Error('Stale or unknown document')
    const total = request.texts.reduce((sum, text) => sum + text.length, 0)
    if (total > WEBTEXT_LIMITS.maxTotalChars) throw new Error(`Request too large (${total} characters)`)
    const { translations } = await this.options.translator.translate(request.texts)
    return translations
  }

  /** The page finished a run. */
  done(tabId: number, docId: string, result: 'translated' | 'restored' | 'error'): void {
    const state = this.tabs.get(tabId)
    if (!state || state.docId !== docId) return
    if (result === 'translated') state.state = 'translated'
    else if (result === 'error') state.state = 'error'
    // A restore after "never translate" must not bring the offer back.
    else state.state = decide(this.options.getPrefs(), state.host, state.lang) === 'offer' ? 'offer' : 'hidden'
    this.push(tabId)
  }

  /** A button on the bar. */
  barAction({ tabId, action }: WebTextBarAction): void {
    const state = this.tabs.get(tabId)
    if (!state) return
    const prefs = this.options.getPrefs()
    switch (action) {
      case 'translate':
        this.start(tabId, state)
        return
      case 'restore':
        this.options.sendCommand(tabId, { action: 'restore' })
        return
      case 'always':
        this.options.setPrefs(applyChoice(prefs, 'always', state.host, state.lang))
        if (state.state !== 'translated') this.start(tabId, state)
        return
      case 'never-lang':
      case 'never-site':
        this.options.setPrefs(applyChoice(prefs, action, state.host, state.lang))
        if (state.state === 'translated' || state.state === 'translating') this.options.sendCommand(tabId, { action: 'restore' })
        state.state = 'hidden'
        this.push(tabId)
        return
      case 'dismiss':
        // Hides the bar only; a translated page stays translated.
        if (state.state !== 'translated') state.state = 'hidden'
        this.push(tabId, true)
        return
    }
  }

  /** A main-frame navigation started: the old page's state is gone. */
  forget(tabId: number): void {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1)
    this.tabs.delete(tabId)
    if (tabId === this.options.getActiveTabId()) this.options.sendBar(HIDDEN(tabId))
  }

  /** The bar to show for the active tab (after a tab switch or on shell start). */
  barFor(tabId: number | null): WebTextBar {
    const state = tabId === null ? undefined : this.tabs.get(tabId)
    if (!state || state.state === 'hidden') return HIDDEN(tabId)
    return { tabId, state: state.state, lang: state.lang, host: state.host }
  }

  private start(tabId: number, state: TabState): void {
    state.state = 'translating'
    this.options.sendCommand(tabId, { action: 'translate' })
    this.push(tabId)
  }

  private push(tabId: number, hide = false): void {
    if (tabId !== this.options.getActiveTabId()) return
    this.options.sendBar(hide ? HIDDEN(tabId) : this.barFor(tabId))
  }
}
