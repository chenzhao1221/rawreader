import type { Config } from '../../shared/config/schema'
import type { BrowseState, PipelineProgress, ServerRole, ServerStatus } from '../../shared/ipc/contract'
import { label, zhCN } from './i18n/zh-CN'

export interface ShellStore {
  browse: BrowseState
  config: Config | null
  llama: Record<ServerRole, ServerStatus | null>
  /** Images of the current page: done / total (R5.7). */
  progress: PipelineProgress
  /** Transient message in the status bar (Simplified Chinese), or null. */
  message: string | null
}

export const store: ShellStore = $state({
  browse: { url: '', title: '', canGoBack: false, canGoForward: false, loading: false },
  config: null,
  llama: { ocr: null, translate: null },
  progress: { total: 0, done: 0, failed: 0, active: 0 },
  message: null,
})

let messageTimer: ReturnType<typeof setTimeout> | undefined

function showMessage(text: string): void {
  store.message = text
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => {
    store.message = null
  }, 6000)
}

/** Subscribes to main-process events and loads the initial state. Returns a cleanup function. */
export function initStore(): () => void {
  const api = window.rawreader
  const unsubscribe = [
    api.on('browse:state', (state) => {
      store.browse = state
    }),
    api.on('config:changed', (config) => {
      store.config = config
    }),
    api.on('llama:status', (status) => {
      store.llama[status.role] = status
    }),
    api.on('shell:notice', (notice) => showMessage(label.notice(notice.code))),
    api.on('pipeline:progress', (progress) => {
      store.progress = progress
    }),
  ]

  void api.invoke('config:get').then((result) => {
    if (result.ok) store.config = result.value
  })
  void api.invoke('llama:status').then((result) => {
    if (!result.ok) return
    for (const status of result.value) store.llama[status.role] = status
  })

  return () => unsubscribe.forEach((off) => off())
}

/** Submits address-bar text. Returns an error message to display, or null on success. */
export async function navigate(input: string): Promise<string | null> {
  const result = await window.rawreader.invoke('browse:navigate', { input })
  if (!result.ok) return zhCN.errors.generic
  return result.value.ok ? null : label.navReject(result.value.reason)
}

export function go(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  void window.rawreader.invoke('browse:go', { action })
}

export function openLogs(): void {
  void window.rawreader.invoke('app:open-logs')
}

export async function setToggle(key: 'autoTranslate' | 'overlayVisible', value: boolean): Promise<void> {
  const result = await window.rawreader.invoke('config:update', { ui: { [key]: value } })
  if (result.ok) store.config = result.value
  else showMessage(zhCN.errors.generic)
}
