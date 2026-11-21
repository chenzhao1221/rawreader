import { describe, expect, it } from 'vitest'
import { MENU_LABELS, buildMenuEntries, isTranslatableImageUrl } from './context-menu'
import type { MenuEntry, MenuParams, MenuState } from './context-menu'

const plain: MenuParams = {
  isEditable: false,
  selectionText: '',
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
}
const state: MenuState = { canGoBack: true, canGoForward: false, isDev: false }

const actions = (entries: MenuEntry[]): string[] => entries.map((e) => (e.type === 'separator' ? '|' : e.action))
const find = (entries: MenuEntry[], action: string) => entries.find((e) => e.type === 'item' && e.action === action)

describe('buildMenuEntries', () => {
  it('offers back, forward and reload on a plain page, with forward disabled when there is no forward history', () => {
    const entries = buildMenuEntries(plain, state)
    expect(actions(entries)).toEqual(['back', 'forward', 'reload'])
    expect(find(entries, 'back')).toMatchObject({ enabled: true, label: MENU_LABELS.back })
    expect(find(entries, 'forward')).toMatchObject({ enabled: false })
  })

  it('adds Copy for a text selection', () => {
    const entries = buildMenuEntries({ ...plain, selectionText: 'abc', editFlags: { ...plain.editFlags, canCopy: true } }, state)
    expect(actions(entries)).toEqual(['copy', '|', 'back', 'forward', 'reload'])
  })

  it('ignores a whitespace-only selection', () => {
    expect(actions(buildMenuEntries({ ...plain, selectionText: '  ' }, state))).toEqual(['back', 'forward', 'reload'])
  })

  it('offers cut, copy, paste and select all in editable fields, honouring the edit flags', () => {
    const entries = buildMenuEntries({ ...plain, isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, state)
    expect(actions(entries).slice(0, 4)).toEqual(['cut', 'copy', 'paste', 'select-all'])
    expect(find(entries, 'cut')).toMatchObject({ enabled: false })
    expect(find(entries, 'paste')).toMatchObject({ enabled: true })
  })

  it('puts the image group first, with translate before copy and open', () => {
    const entries = buildMenuEntries({ ...plain, mediaType: 'image', srcURL: 'https://cdn.example.test/p/1.jpg' }, state)
    expect(actions(entries)).toEqual(['translate-image', 'copy-image', 'open-image', '|', 'back', 'forward', 'reload'])
    expect(find(entries, 'translate-image')).toMatchObject({ label: '翻译这张图片' })
  })

  it('does not offer open-in-tab for a data URL image, but still offers translation and copy', () => {
    const entries = buildMenuEntries({ ...plain, mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, state)
    expect(actions(entries).slice(0, 2)).toEqual(['translate-image', 'copy-image'])
    expect(find(entries, 'open-image')).toBeUndefined()
  })

  it('offers only copy for an image that cannot be captured (blob URL)', () => {
    const entries = buildMenuEntries({ ...plain, mediaType: 'image', srcURL: 'blob:https://reader.example.test/abc' }, state)
    expect(find(entries, 'translate-image')).toBeUndefined()
    expect(find(entries, 'open-image')).toBeUndefined()
    expect(find(entries, 'copy-image')).toBeDefined()
  })

  it('shows no image entries for other media or an image without a URL', () => {
    expect(find(buildMenuEntries({ ...plain, mediaType: 'video', srcURL: 'https://cdn.example.test/v.mp4' }, state), 'copy-image')).toBeUndefined()
    expect(find(buildMenuEntries({ ...plain, mediaType: 'image', srcURL: '' }, state), 'copy-image')).toBeUndefined()
  })

  it('offers Copy link only for http(s) links', () => {
    expect(find(buildMenuEntries({ ...plain, linkURL: 'https://reader.example.test/next' }, state), 'copy-link')).toBeDefined()
    expect(find(buildMenuEntries({ ...plain, linkURL: 'javascript:void(0)' }, state), 'copy-link')).toBeUndefined()
  })

  it('shows Inspect in development builds only', () => {
    expect(find(buildMenuEntries(plain, state), 'inspect')).toBeUndefined()
    const dev = buildMenuEntries(plain, { ...state, isDev: true })
    expect(actions(dev).at(-1)).toBe('inspect')
    expect(actions(dev).at(-2)).toBe('|')
  })

  it('never starts or ends with a separator or repeats one', () => {
    const entries = buildMenuEntries(
      { ...plain, mediaType: 'image', srcURL: 'https://cdn.example.test/p/1.jpg', linkURL: 'https://reader.example.test/n', selectionText: 'x' },
      { ...state, isDev: true },
    )
    const list = actions(entries)
    expect(list[0]).not.toBe('|')
    expect(list.at(-1)).not.toBe('|')
    expect(list.join(',')).not.toContain('|,|')
  })
})

describe('isTranslatableImageUrl', () => {
  it('accepts http(s) and data images only', () => {
    expect(isTranslatableImageUrl('https://cdn.example.test/a.jpg')).toBe(true)
    expect(isTranslatableImageUrl('http://cdn.example.test/a.jpg')).toBe(true)
    expect(isTranslatableImageUrl('data:image/webp;base64,AAAA')).toBe(true)
    expect(isTranslatableImageUrl('data:text/html,hi')).toBe(false)
    expect(isTranslatableImageUrl('blob:https://reader.example.test/abc')).toBe(false)
    expect(isTranslatableImageUrl('file:///a.png')).toBe(false)
    expect(isTranslatableImageUrl('')).toBe(false)
  })
})
