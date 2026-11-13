import type { Config, DeepPartial } from '../../shared/config/schema'
import type {
  CacheStats,
  CudaStatus,
  Licenses,
  ModelRoleName,
  ModelsActionResult,
  ModelsOverview,
  NavResult,
  PageConfig,
  PageImagesBatch,
  ServerRole,
  ServerStatus,
  TabsState,
  WebTextBar,
  WebTextBarAction,
  WebTextPage,
  WebTextRequest,
  WebTextResult,
  SecretsStatus,
} from '../../shared/ipc/contract'
import { normalizeAddress } from '../window/address'
import type { BrowseAction } from '../window/browse-view'
import type { IpcRegistrar } from './register'

/** Services the skeleton channels delegate to. Injected so this file has no Electron imports. */
export interface HandlerDeps {
  getConfig(): Config
  updateConfig(patch: DeepPartial<Config>): Config
  navigate(url: string): void
  go(action: BrowseAction): void
  setBrowseVisible(visible: boolean): void
  getLlamaStatuses(): ServerStatus[]
  controlLlama(role: ServerRole, action: 'start' | 'stop' | 'restart'): Promise<ServerStatus>
  openLogFolder(): Promise<void>
  /** Browse preload announced a new document. Returns the settings it should use. */
  pageHello(hello: { docId: string; url: string }, senderId: number): PageConfig
  /** Browse preload reported images near the viewport. */
  pageImages(batch: PageImagesBatch, senderId: number): void
  getTabs(): TabsState
  /** Opens a new tab with the given URL, or an empty one. */
  newTab(url: string | null): void
  closeTab(id: number): void
  activateTab(id: number): void
  /** Browse preload reported its language once loaded. */
  webTextPage(page: WebTextPage, senderId: number): void
  /** Translates page text through Google (browse preload only). */
  webTextTranslate(request: WebTextRequest, senderId: number): Promise<WebTextResult>
  webTextDone(done: { docId: string; state: 'translated' | 'restored' | 'error' }, senderId: number): void
  getWebTextBar(): WebTextBar
  webTextBarAction(action: WebTextBarAction): void
  getSecretsStatus(): SecretsStatus
  setSecret(name: 'openai' | 'gemini', value: string): SecretsStatus
  /** Bundled overlay font bytes, or null when the file is missing. */
  getOverlayFont(): Promise<Uint8Array | null>
  getCacheStats(): CacheStats
  /** Deletes every cached result (DELETE + VACUUM) and returns the new stats. */
  clearCache(): CacheStats
  getModelsOverview(): ModelsOverview
  modelsDownload(action: 'start' | 'pause' | 'resume' | 'cancel', role?: ModelRoleName): ModelsActionResult
  modelsPickFolder(): Promise<ModelsActionResult>
  modelsLocateFolder(): Promise<ModelsActionResult>
  modelsPickFile(role: ModelRoleName): Promise<ModelsActionResult>
  modelsUseFile(role: ModelRoleName, path: string): Promise<ModelsActionResult>
  modelsClearPath(role: ModelRoleName): ModelsActionResult
  getCudaStatus(): CudaStatus
  cudaDownload(action: 'start' | 'cancel'): CudaStatus
  getLicenses(): Promise<Licenses>
}

/** Registers every skeleton channel. All of them accept the shell renderer only. */
export function registerSkeletonHandlers(registrar: IpcRegistrar, deps: HandlerDeps): void {
  registrar.handle('browse:navigate', ({ input }): NavResult => {
    const result = normalizeAddress(input)
    if (!result.ok) return result
    deps.navigate(result.url)
    return { ok: true, url: result.url }
  })

  registrar.handle('browse:go', ({ action }) => {
    deps.go(action)
  })

  registrar.handle('shell:panel-visibility', ({ open }) => {
    deps.setBrowseVisible(!open)
  })

  registrar.handle('tabs:get', () => deps.getTabs())
  registrar.handle('tabs:new', ({ input }): NavResult => {
    if (input === undefined || input.trim() === '') {
      deps.newTab(null)
      return { ok: true, url: '' }
    }
    const result = normalizeAddress(input)
    if (!result.ok) return result
    deps.newTab(result.url)
    return { ok: true, url: result.url }
  })
  registrar.handle('tabs:close', ({ id }) => {
    deps.closeTab(id)
  })
  registrar.handle('tabs:activate', ({ id }) => {
    deps.activateTab(id)
  })

  // Translate bar. The page channels accept browse tabs only; the bar channels the shell only.
  registrar.handle('webtext:page', (page, event) => {
    deps.webTextPage(page, event.sender.id)
  })
  registrar.handle('webtext:translate', (request, event) => deps.webTextTranslate(request, event.sender.id))
  registrar.handle('webtext:done', (done, event) => {
    deps.webTextDone(done, event.sender.id)
  })
  registrar.handle('webtext:bar', () => deps.getWebTextBar())
  registrar.handle('webtext:bar-action', (action) => {
    deps.webTextBarAction(action)
  })
  registrar.handle('secrets:status', () => deps.getSecretsStatus())
  registrar.handle('secrets:set', ({ name, value }) => deps.setSecret(name, value))

  registrar.handle('config:get', () => deps.getConfig())

  registrar.handle('config:update', (patch) => deps.updateConfig(patch))

  registrar.handle('llama:status', () => deps.getLlamaStatuses())

  registrar.handle('llama:control', ({ role, action }) => deps.controlLlama(role, action))

  registrar.handle('app:open-logs', () => deps.openLogFolder())

  // Browse-preload channels. The payloads come from page-adjacent code and are validated by zod in the registrar.
  registrar.handle('page:hello', (hello, event) => deps.pageHello(hello, event.sender.id))
  registrar.handle('page:images', (batch, event) => {
    deps.pageImages(batch, event.sender.id)
  })
  registrar.handle('overlay:font', () => deps.getOverlayFont())
  registrar.handle('cache:stats', () => deps.getCacheStats())
  registrar.handle('cache:clear', () => deps.clearCache())

  registrar.handle('models:overview', () => deps.getModelsOverview())
  registrar.handle('models:download', ({ action, role }) => deps.modelsDownload(action, role))
  registrar.handle('models:pick-folder', () => deps.modelsPickFolder())
  registrar.handle('models:locate-folder', () => deps.modelsLocateFolder())
  registrar.handle('models:pick-file', ({ role }) => deps.modelsPickFile(role))
  registrar.handle('models:use-file', ({ role, path }) => deps.modelsUseFile(role, path))
  registrar.handle('models:clear-path', ({ role }) => deps.modelsClearPath(role))
  registrar.handle('cuda:status', () => deps.getCudaStatus())
  registrar.handle('cuda:download', ({ action }) => deps.cudaDownload(action))
  registrar.handle('licenses:get', () => deps.getLicenses())
}
