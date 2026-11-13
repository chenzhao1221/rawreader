import type { Config } from '../../shared/config/schema'
import type {
  BrowseState,
  CacheStats,
  CudaStatus,
  InvokeReq,
  Licenses,
  ModelNotice,
  ModelRoleName,
  ModelsActionResult,
  ModelsOverview,
  PipelineProgress,
  ServerRole,
  ServerStatus,
} from '../../shared/ipc/contract'
import { label, zhCN } from './i18n/zh-CN'

export type SettingsTab = 'models' | 'servers' | 'advanced' | 'licenses'

export interface ShellStore {
  browse: BrowseState
  config: Config | null
  llama: Record<ServerRole, ServerStatus | null>
  /** Images of the current page: done / total (R5.7). */
  progress: PipelineProgress
  /** Transient message in the status bar (Simplified Chinese), or null. */
  message: string | null
  /** Settings / first-run panel. While open, main hides the native browse view. */
  panelOpen: boolean
  tab: SettingsTab
  models: ModelsOverview | null
  /** Last notice from a model action (cancelled, wrong size ...). */
  modelNotice: ModelNotice | null
  cuda: CudaStatus | null
  cache: CacheStats | null
  licenses: Licenses | null
  /** The first-run panel was shown (or dismissed) once in this session. */
  setupHandled: boolean
}

export const store: ShellStore = $state({
  browse: { url: '', title: '', canGoBack: false, canGoForward: false, loading: false },
  config: null,
  llama: { ocr: null, translate: null },
  progress: { total: 0, done: 0, failed: 0, active: 0 },
  message: null,
  panelOpen: false,
  tab: 'models',
  models: null,
  modelNotice: null,
  cuda: null,
  cache: null,
  licenses: null,
  setupHandled: false,
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
    api.on('models:changed', (overview) => {
      store.models = overview
    }),
    api.on('cuda:changed', (status) => {
      store.cuda = status
    }),
  ]

  void api.invoke('config:get').then((result) => {
    if (result.ok) store.config = result.value
  })
  void api.invoke('llama:status').then((result) => {
    if (!result.ok) return
    for (const status of result.value) store.llama[status.role] = status
  })
  void api.invoke('models:overview').then((result) => {
    if (!result.ok) return
    store.models = result.value
    // R13.1: a missing required model opens the first-run panel once.
    if (result.value.needsSetup && !store.setupHandled) {
      store.setupHandled = true
      openSettings('models')
    }
  })
  void api.invoke('cuda:status').then((result) => {
    if (result.ok) store.cuda = result.value
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

// ---------------------------------------------------------------------------
// Settings panel actions
// ---------------------------------------------------------------------------

export function openSettings(tab: SettingsTab = 'models'): void {
  store.tab = tab
  store.panelOpen = true
  store.modelNotice = null
  void window.rawreader.invoke('shell:panel-visibility', { open: true })
  if (tab === 'advanced') void refreshCache()
  if (tab === 'licenses') void loadLicenses()
}

export function closeSettings(): void {
  store.panelOpen = false
  void window.rawreader.invoke('shell:panel-visibility', { open: false })
}

export function selectTab(tab: SettingsTab): void {
  store.tab = tab
  if (tab === 'advanced') void refreshCache()
  if (tab === 'licenses') void loadLicenses()
}

function applyModelsResult(result: { ok: true; value: ModelsActionResult } | { ok: false }): void {
  if (!result.ok) {
    showMessage(zhCN.errors.generic)
    return
  }
  store.models = result.value.overview
  store.modelNotice = result.value.notice
}

export async function modelsDownload(action: 'start' | 'pause' | 'resume' | 'cancel', role?: ModelRoleName): Promise<void> {
  applyModelsResult(await window.rawreader.invoke('models:download', role ? { action, role } : { action }))
}

export async function modelsPickFolder(): Promise<void> {
  applyModelsResult(await window.rawreader.invoke('models:pick-folder'))
}

export async function modelsLocateFolder(): Promise<void> {
  applyModelsResult(await window.rawreader.invoke('models:locate-folder'))
}

export async function modelsPickFile(role: ModelRoleName): Promise<void> {
  applyModelsResult(await window.rawreader.invoke('models:pick-file', { role }))
}

export async function modelsUseFile(role: ModelRoleName, path: string): Promise<void> {
  applyModelsResult(await window.rawreader.invoke('models:use-file', { role, path }))
}

export async function modelsClearPath(role: ModelRoleName): Promise<void> {
  applyModelsResult(await window.rawreader.invoke('models:clear-path', { role }))
}

/** Saves a config patch. Returns true on success; false when main rejected the values. */
export async function saveConfig(patch: InvokeReq<'config:update'>): Promise<boolean> {
  const result = await window.rawreader.invoke('config:update', patch)
  if (result.ok) store.config = result.value
  return result.ok
}

export async function controlServer(role: ServerRole, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const result = await window.rawreader.invoke('llama:control', { role, action })
  if (result.ok) store.llama[role] = result.value
  else showMessage(zhCN.errors.generic)
}

export async function cudaDownload(action: 'start' | 'cancel'): Promise<void> {
  const result = await window.rawreader.invoke('cuda:download', { action })
  if (result.ok) store.cuda = result.value
  else showMessage(zhCN.errors.generic)
}

export async function refreshCache(): Promise<void> {
  const result = await window.rawreader.invoke('cache:stats')
  if (result.ok) store.cache = result.value
}

export async function clearCache(): Promise<void> {
  const result = await window.rawreader.invoke('cache:clear')
  if (result.ok) {
    store.cache = result.value
    showMessage(zhCN.advanced.cacheCleared)
  } else {
    showMessage(zhCN.errors.generic)
  }
}

export async function loadLicenses(): Promise<void> {
  if (store.licenses) return
  const result = await window.rawreader.invoke('licenses:get')
  if (result.ok) store.licenses = result.value
}
