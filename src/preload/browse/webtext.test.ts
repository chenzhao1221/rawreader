import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isTranslatable, splitSpace, WebTextTranslator } from './webtext'

class FakeText {
  isConnected = true
  parentElement: FakeElement | null = null
  constructor(public data: string) {}
}

class FakeElement {
  parentElement: FakeElement | null
  readonly texts: FakeText[] = []
  readonly children: FakeElement[] = []
  private readonly attrs = new Map<string, string>()

  constructor(
    readonly tagName: string,
    parent: FakeElement | null = null,
  ) {
    this.parentElement = parent
  }

  attr(name: string, value: string): this {
    this.attrs.set(name, value)
    return this
  }

  append(...nodes: Array<FakeText | FakeElement>): this {
    for (const node of nodes) {
      if (node instanceof FakeText) {
        node.parentElement = this
        this.texts.push(node)
      } else {
        node.parentElement = this
        this.children.push(node)
      }
    }
    return this
  }

  /** Only the selectors `collect` uses. */
  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parentElement) {
      if (selector.includes('contenteditable')) {
        const value = el.attrs.get('contenteditable')
        if (value === '' || value === 'true') return el
      }
      if (selector.includes('translate') && el.attrs.get('translate') === 'no') return el
      if (selector.includes('notranslate') && (el.attrs.get('class') ?? '').split(/\s+/).includes('notranslate')) return el
    }
    return null
  }
}

class FakeDocument {
  readonly body = new FakeElement('BODY')

  createTreeWalker(root: FakeElement, _what: number, filter: { acceptNode: (node: FakeText) => number }) {
    const nodes: FakeText[] = []
    const walk = (el: FakeElement): void => {
      nodes.push(...el.texts)
      for (const child of el.children) walk(child)
    }
    walk(root)
    let index = 0
    return {
      nextNode(): FakeText | null {
        while (index < nodes.length) {
          const node = nodes[index++]!
          if (filter.acceptNode(node) === 1) return node
        }
        return null
      },
    }
  }
}

class FakeMutationObserver {
  constructor(readonly callback: () => void) {}
  observe(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 })
  vi.stubGlobal('MutationObserver', FakeMutationObserver)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

function setup(translate: (texts: string[]) => Promise<string[]> = async (texts) => texts.map((text) => text.toUpperCase())) {
  const doc = new FakeDocument()
  const done = vi.fn()
  const translateSpy = vi.fn(translate)
  const translator = new WebTextTranslator({
    doc: doc as unknown as Document,
    translate: translateSpy,
    done,
  })
  const add = (tag: string, text: string, prepare: (el: FakeElement) => void = () => {}): FakeText => {
    const el = new FakeElement(tag)
    prepare(el)
    const node = new FakeText(text)
    el.append(node)
    doc.body.append(el)
    return node
  }
  return { doc, translator, done, translateSpy, add }
}

describe('isTranslatable', () => {
  it('accepts text with letters', () => {
    expect(isTranslatable('Hello')).toBe(true)
    expect(isTranslatable('  안녕하세요  ')).toBe(true)
  })

  it('rejects empty text, numbers and Chinese text', () => {
    expect(isTranslatable('   ')).toBe(false)
    expect(isTranslatable('12345 !!!')).toBe(false)
    expect(isTranslatable('你好，世界！')).toBe(false)
  })

  it('rejects a too-long block', () => {
    expect(isTranslatable('a'.repeat(5000))).toBe(true)
    expect(isTranslatable('a'.repeat(5001))).toBe(false)
  })
})

describe('splitSpace', () => {
  it('keeps the white space around the translated core', () => {
    expect(splitSpace('  Hello world\n')).toEqual({ lead: '  ', core: 'Hello world', tail: '\n' })
  })

  it('handles text without white space', () => {
    expect(splitSpace('Hello')).toEqual({ lead: '', core: 'Hello', tail: '' })
  })
})

describe('WebTextTranslator', () => {
  it('translates visible text and puts the original back', async () => {
    const h = setup()
    const hello = h.add('P', '  Hello world  ')
    const zh = h.add('P', '你好')
    const code = h.add('CODE', 'const x = 1')

    await h.translator.translatePage()
    expect(h.done).toHaveBeenLastCalledWith('translated')
    expect(hello.data).toBe('  HELLO WORLD  ')
    expect(zh.data).toBe('你好')
    expect(code.data).toBe('const x = 1')
    expect(h.translateSpy).toHaveBeenCalledWith(['Hello world'])

    h.translator.restore()
    expect(h.done).toHaveBeenLastCalledWith('restored')
    expect(hello.data).toBe('  Hello world  ')
  })

  it('skips editable, opted-out and script-like elements', async () => {
    const h = setup()
    const editable = h.add('P', 'Editable', (el) => el.attr('contenteditable', ''))
    const optedOut = h.add('P', 'Opted out', (el) => el.attr('translate', 'no'))
    const marked = h.add('P', 'Marked', (el) => el.attr('class', 'notranslate'))
    const script = h.add('SCRIPT', 'let x = 1')
    const visible = h.add('P', 'Visible')

    await h.translator.translatePage()
    expect([editable.data, optedOut.data, marked.data, script.data]).toEqual(['Editable', 'Opted out', 'Marked', 'let x = 1'])
    expect(visible.data).toBe('VISIBLE')
    expect(h.translateSpy).toHaveBeenCalledWith(['Visible'])
  })

  it('does not start twice', async () => {
    const h = setup()
    h.add('P', 'Hello')
    await h.translator.translatePage()
    await h.translator.translatePage()
    expect(h.translateSpy).toHaveBeenCalledTimes(1)
    expect(h.done).toHaveBeenCalledTimes(1)
  })

  it('reports an error and lets a retry run', async () => {
    let attempts = 0
    const h = setup(async (texts) => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return texts.map((text) => text.toUpperCase())
    })
    const hello = h.add('P', 'Hello')

    await h.translator.translatePage()
    expect(h.done).toHaveBeenLastCalledWith('error')
    expect(hello.data).toBe('Hello')

    await h.translator.translatePage()
    expect(h.done).toHaveBeenLastCalledWith('translated')
    expect(hello.data).toBe('HELLO')
  })

  it('skips text the page changed while the answer was pending', async () => {
    let release!: (translations: string[]) => void
    const h = setup(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve
        }),
    )
    const hello = h.add('P', 'Hello')
    const pending = h.translator.translatePage()
    hello.data = 'Changed by the page'
    release(['HELLO'])
    await pending
    expect(hello.data).toBe('Changed by the page')
  })

  it('does nothing without a body', async () => {
    const done = vi.fn()
    const doc = { body: null } as unknown as Document
    const translator = new WebTextTranslator({ doc, translate: async () => [], done })
    await translator.translatePage()
    expect(done).toHaveBeenCalledWith('error')
  })
})
