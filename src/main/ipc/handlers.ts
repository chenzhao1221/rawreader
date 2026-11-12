import type { Config, DeepPartial } from '../../shared/config/schema'
import type { NavResult, PageConfig, PageImagesBatch, ServerRole, ServerStatus } from '../../shared/ipc/contract'
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
}
