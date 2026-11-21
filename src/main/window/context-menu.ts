import { isHttpUrl } from './address'

/** Labels of the page context menu (Simplified Chinese UI strings, like TRAY_LABELS). */
export const MENU_LABELS = {
  back: '后退',
  forward: '前进',
  reload: '重新加载',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  copyLink: '复制链接地址',
  copyImage: '复制图片',
  openImage: '在新标签页中打开图片',
  translateImage: '翻译这张图片',
  inspect: '检查',
} as const

export type MenuAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'copy-link'
  | 'copy-image'
  | 'open-image'
  | 'translate-image'
  | 'inspect'

export type MenuEntry = { type: 'separator' } | { type: 'item'; action: MenuAction; label: string; enabled: boolean }

/** The parts of Electron's `ContextMenuParams` that decide the menu. */
export interface MenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  srcURL: string
  mediaType: string
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

export interface MenuState {
  canGoBack: boolean
  canGoForward: boolean
  /** True in development builds only: adds "Inspect". */
  isDev: boolean
}

/** Image the translation can capture: a normal web image or an inline data URL. */
export function isTranslatableImageUrl(url: string): boolean {
  return isHttpUrl(url) || /^data:image\//i.test(url)
}

const item = (action: MenuAction, label: string, enabled = true): MenuEntry => ({ type: 'item', action, label, enabled })

/**
 * Decides which entries the page menu shows. Groups (image, link, text, navigation, developer) are separated by
 * one separator; empty groups leave no separator behind.
 */
export function buildMenuEntries(params: MenuParams, state: MenuState): MenuEntry[] {
  const groups: MenuEntry[][] = []

  if (params.mediaType === 'image' && params.srcURL) {
    const group: MenuEntry[] = []
    if (isTranslatableImageUrl(params.srcURL)) group.push(item('translate-image', MENU_LABELS.translateImage))
    group.push(item('copy-image', MENU_LABELS.copyImage))
    if (isHttpUrl(params.srcURL)) group.push(item('open-image', MENU_LABELS.openImage))
    groups.push(group)
  }

  if (isHttpUrl(params.linkURL)) groups.push([item('copy-link', MENU_LABELS.copyLink)])

  if (params.isEditable) {
    groups.push([
      item('cut', MENU_LABELS.cut, params.editFlags.canCut),
      item('copy', MENU_LABELS.copy, params.editFlags.canCopy),
      item('paste', MENU_LABELS.paste, params.editFlags.canPaste),
      item('select-all', MENU_LABELS.selectAll, params.editFlags.canSelectAll),
    ])
  } else if (params.selectionText.trim() !== '') {
    groups.push([item('copy', MENU_LABELS.copy, params.editFlags.canCopy)])
  }

  groups.push([
    item('back', MENU_LABELS.back, state.canGoBack),
    item('forward', MENU_LABELS.forward, state.canGoForward),
    item('reload', MENU_LABELS.reload),
  ])

  if (state.isDev) groups.push([item('inspect', MENU_LABELS.inspect)])

  const entries: MenuEntry[] = []
  for (const group of groups) {
    if (group.length === 0) continue
    if (entries.length > 0) entries.push({ type: 'separator' })
    entries.push(...group)
  }
  return entries
}
