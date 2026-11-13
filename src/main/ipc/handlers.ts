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
  pageHello(hello: { docId: string; url: string }): PageConfig
  /** Browse preload reported images near the viewport. */
  pageImages(batch: PageImagesBatch): void
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

  registrar.handle('config:get', () => deps.getConfig())

  registrar.handle('config:update', (patch) => deps.updateConfig(patch))

  registrar.handle('llama:status', () => deps.getLlamaStatuses())

  registrar.handle('llama:control', ({ role, action }) => deps.controlLlama(role, action))

  registrar.handle('app:open-logs', () => deps.openLogFolder())

  // Browse-preload channels. The payloads come from page-adjacent code and are validated by zod in the registrar.
  registrar.handle('page:hello', (hello) => deps.pageHello(hello))
  registrar.handle('page:images', (batch) => {
    deps.pageImages(batch)
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
