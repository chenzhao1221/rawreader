// Page-text translation for the Google translate bar. Runs in the browse preload's isolated world:
// it reads and rewrites text nodes of the page, and sends the text to main, which calls Google.

/** Elements whose text is never translated. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'CANVAS', 'IFRAME'])
/** Text with no letters at all (numbers, punctuation, emoji) is left alone. */
const HAS_LETTER = /\p{L}/u
/** Already Chinese: no point in sending it. */
const MOSTLY_HAN = /^[\s\p{P}\p{S}\p{N}\p{Script=Han}]*$/u

const BATCH_ITEMS = 120
const BATCH_CHARS = 12_000
const MAX_ITEM_CHARS = 5000
const OBSERVE_DELAY_MS = 600

export interface WebTextOptions {
  doc: Document
  /** Sends texts to main and returns the translations in the same order. */
  translate(texts: string[]): Promise<string[]>
  /** Reports the end of a run. */
  done(state: 'translated' | 'restored' | 'error'): void
}

/** True for a text node worth translating. Exported for tests. */
export function isTranslatable(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_ITEM_CHARS && HAS_LETTER.test(trimmed) && !MOSTLY_HAN.test(trimmed)
}

/** Splits leading and trailing white space off, so it survives translation. Exported for tests. */
export function splitSpace(text: string): { lead: string; core: string; tail: string } {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
  return { lead: match?.[1] ?? '', core: match?.[2] ?? text, tail: match?.[3] ?? '' }
}

export class WebTextTranslator {
  /** Original value of every node we changed. */
  private readonly originals = new Map<Text, string>()
  /** Value we wrote, to tell our own changes from the page's. */
  private readonly written = new WeakMap<Text, string>()
  private active = false
  private running: Promise<void> | null = null
  private observer: MutationObserver | null = null
  private pending = new Set<Text>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: WebTextOptions) {}

  get translated(): boolean {
    return this.active
  }

  /** Translates the whole page, then keeps translating text the page adds later. */
  async translatePage(): Promise<void> {
    if (this.active) return
    this.active = true
    const body = this.options.doc.body
    if (!body) {
      this.active = false
      this.options.done('error')
      return
    }
    try {
      await this.translateNodes(this.collect(body))
      this.observe(body)
      this.options.done('translated')
    } catch {
      // Let the retry button start a new run; texts already written stay translated.
      this.active = false
      this.options.done('error')
    }
  }

  /** Puts every original text back and stops watching the page. */
  restore(): void {
    this.active = false
    this.observer?.disconnect()
    this.observer = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    for (const [node, original] of this.originals) {
      if (node.isConnected && node.data === this.written.get(node)) node.data = original
    }
    this.originals.clear()
    this.options.done('restored')
  }

  private collect(root: Node): Text[] {
    const doc = this.options.doc
    const nodes: Text[] = []
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest('[contenteditable=""], [contenteditable="true"], [translate="no"], .notranslate')) return NodeFilter.FILTER_REJECT
        for (let el: Element | null = parent; el; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
        }
        const text = node as Text
        if (this.written.get(text) === text.data) return NodeFilter.FILTER_REJECT
        return isTranslatable(text.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    return nodes
  }

  /** Sends nodes in batches, one batch at a time, and writes the answers back. */
  private async translateNodes(nodes: Text[]): Promise<void> {
    let batch: Text[] = []
    let size = 0
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return
      const current = batch
      batch = []
      size = 0
      const parts = current.map((node) => splitSpace(node.data))
      const answers = await this.options.translate(parts.map((p) => p.core))
      if (!this.active) return
      current.forEach((node, index) => {
        const answer = answers[index]
        const part = parts[index]
        if (!answer || !part || !node.isConnected) return
        // The page changed this node while we waited: leave its new text alone.
        if (node.data !== `${part.lead}${part.core}${part.tail}`) return
        if (!this.originals.has(node)) this.originals.set(node, node.data)
        const value = `${part.lead}${answer}${part.tail}`
        this.written.set(node, value)
        node.data = value
      })
    }
    for (const node of nodes) {
      if (!this.active) return
      batch.push(node)
      size += node.data.length
      if (batch.length >= BATCH_ITEMS || size >= BATCH_CHARS) await flush()
    }
    await flush()
  }

  /** New or changed text (infinite scroll, SPA navigation) is translated shortly after it appears. */
  private observe(body: HTMLElement): void {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData' && mutation.target instanceof Text) {
          const node = mutation.target
          if (this.written.get(node) !== node.data) {
            this.originals.delete(node)
            this.pending.add(node)
          }
        }
        for (const added of mutation.addedNodes) {
          if (added instanceof Text) this.pending.add(added)
          else if (added instanceof Element) for (const node of this.collect(added)) this.pending.add(node)
        }
      }
      if (this.pending.size > 0) this.schedule()
    })
    this.observer.observe(body, { childList: true, subtree: true, characterData: true })
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      const nodes = [...this.pending].filter((node) => node.isConnected && isTranslatable(node.data) && this.written.get(node) !== node.data)
      this.pending.clear()
      // One run at a time; a later burst waits for the current one.
      const previous = this.running ?? Promise.resolve()
      this.running = previous
        .then(() => this.translateNodes(nodes))
        .catch(() => {})
        .finally(() => {
          this.running = null
        })
    }, OBSERVE_DELAY_MS)
  }
}

/** A little visible text for language detection when the page has no `lang`. */
export function sampleText(doc: Document, max = 500): string {
  const text = (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim()
  return text.slice(0, max)
}
