import { join } from 'node:path'
import type { Config, DeepPartial } from '../../shared/config/schema'
import type { ModelCheck, ModelItem, ModelNotice, ModelsActionResult, ModelsOverview } from '../../shared/ipc/contract'
import { explicitModelPath, explicitPathPatch, isMissingModel, resolveModelPath } from '../config/model-path'
import type { ModelPathEnv, ModelRole } from '../config/model-path'
import type { Logger } from '../log/log'
import { DownloadManager } from './download-manager'
import type { DownloadManagerOptions } from './download-manager'
import type { FetchLike } from './download'
import { manifestFor } from './manifest'
import type { ManifestEntry } from './manifest'
import type { FileCheck, FileVerifier } from './verify'

/** Native dialogs, wrapped so tests (and headless runs) never open a window. */
export interface ModelPickers {
  /** Returns the chosen folder, or null when the user cancelled. */
  pickFolder(): Promise<string | null>
  /** Returns the chosen file, or null when the user cancelled. */
  pickFile(role: ModelRole): Promise<string | null>
}

export interface ModelServiceDeps {
  getConfig: () => Config
  updateConfig: (patch: DeepPartial<Config>) => Config
  env: ModelPathEnv
  fetch: FetchLike
  pickers: ModelPickers
  verifier: FileVerifier
  /** File names in a folder (not recursive). */
  listDir: (dir: string) => Promise<string[]>
  onChange: (overview: ModelsOverview) => void
  /** Called after a download completed, so stopped servers can start with the new files. */
  onModelsReady?: () => void
  logger: Logger
  manifest?: readonly ManifestEntry[]
  downloadOptions?: Pick<DownloadManagerOptions, 'concurrency' | 'attemptsPerSource' | 'retryDelayMs'>
}

type CheckState = FileCheck['status'] | 'checking'

const toModelCheck = (state: CheckState | undefined): ModelCheck => {
  if (state === undefined) return 'unchecked'
  return state
}

/**
 * Model setup for the shell: what is present, where it came from, whether it verified, and the downloads that
 * fill the gaps (R13). Never starts a download by itself; `models.autoDownload: false` (dev) refuses downloads.
 */
export class ModelService {
  private readonly manager: DownloadManager
  private readonly checks = new Map<string, CheckState>()
  private disposed = false

  /** Read per call: the translator row changes with `models.translator`. */
  private get manifest(): readonly ManifestEntry[] {
    return this.deps.manifest ?? manifestFor(this.deps.getConfig())
  }

  constructor(private readonly deps: ModelServiceDeps) {
    this.manager = new DownloadManager({
      fetch: deps.fetch,
      getTargetDir: () => this.modelsDir(),
      getMirrors: () => deps.getConfig().models.mirrors,
      onChange: () => this.emit(),
      onFileDone: (entry, path) => this.onFileDone(entry, path),
      logger: deps.logger,
      ...deps.downloadOptions,
    })
  }

  private modelsDir(): string {
    return this.deps.getConfig().models.dir ?? join(this.deps.env.userDataDir, 'models')
  }

  private downloadsAllowed(): boolean {
    return this.deps.getConfig().models.autoDownload
  }

  getOverview(): ModelsOverview {
    const config = this.deps.getConfig()
    const downloads = new Map(this.manager.states().map((s) => [s.role, s]))
    const modelsDir = this.modelsDir()
    const items: ModelItem[] = this.manifest.map((entry) => {
      const resolved = resolveModelPath(entry.role, config, this.deps.env)
      const missing = isMissingModel(resolved)
      const path = missing ? null : resolved
      const explicit = config.models.paths[entry.role]
      const origin: ModelItem['origin'] = missing
        ? 'missing'
        : explicit
          ? 'config'
          : path !== null && path.startsWith(modelsDir)
            ? 'models-dir'
            : 'bundled'
      const download = downloads.get(entry.role)
      return {
        role: entry.role,
        fileName: entry.fileName,
        displayName: entry.displayName,
        size: entry.size,
        bundled: entry.bundled,
        path,
        expectedPath: missing ? resolved.expectedPath : join(modelsDir, entry.fileName),
        origin,
        check: path === null ? 'unchecked' : toModelCheck(this.checks.get(path)),
        download: download
          ? {
              status: download.status,
              receivedBytes: download.receivedBytes,
              totalBytes: download.totalBytes,
              bytesPerSecond: download.bytesPerSecond,
              source: download.source,
              attempt: download.attempt,
              errorCode: download.errorCode,
            }
          : null,
      }
    })
    // Only files the chosen engine runs count: Gemini needs none of the GGUF files, an API translator no translation model.
    const engine = config.translate.engine
    const needed = (role: string): boolean =>
      role === 'detector' || (engine !== 'gemini' && (role === 'ocr' || role === 'ocrMmproj')) || (engine === 'local' && role === 'translator')
    const missing = items.filter((item) => item.path === null && needed(item.role))
    const allowed = this.downloadsAllowed()
    return {
      modelsDir,
      downloadsAllowed: allowed,
      needsSetup: allowed && missing.length > 0,
      missingBytes: missing.reduce((sum, item) => sum + item.size, 0),
      items,
    }
  }

  /** Verifies every present file in the background (size first, then sha256, remembered per file). */
  refresh(): void {
    if (this.disposed) return
    for (const item of this.getOverview().items) {
      const entry = this.manifest.find((e) => e.role === item.role)
      if (!entry || item.path === null) continue
      const path = item.path
      if (this.checks.has(path)) continue
      this.checks.set(path, 'checking')
      void this.deps.verifier.check(entry, path).then((result) => {
        this.checks.set(path, result.status)
        if (result.status !== 'ok') this.deps.logger.warn(`${entry.fileName}: verification result ${result.status}`)
        this.emit()
      })
    }
    this.emit()
  }

  // ---- downloads ----------------------------------------------------------

  download(action: 'start' | 'pause' | 'resume' | 'cancel', role?: ModelRole): ModelsActionResult {
    if (action === 'pause') this.manager.pause(role)
    else if (action === 'cancel') this.manager.cancel(role)
    else if (action === 'resume') this.manager.resume(role)
    else {
      if (!this.downloadsAllowed()) return this.result({ code: 'downloads-disabled' })
      const wanted = this.getOverview().items.filter((item) => item.path === null && (!role || item.role === role))
      const entries = wanted
        .map((item) => this.manifest.find((e) => e.role === item.role))
        .filter((e): e is ManifestEntry => e !== undefined)
      if (entries.length === 0) return this.result({ code: 'nothing-to-download' })
      this.manager.start(entries)
    }
    return this.result(null)
  }

  private onFileDone(entry: ManifestEntry, path: string): void {
    void this.deps.verifier.markVerified(entry, path)
    this.checks.set(path, 'ok')
    // A stale explicit path would keep shadowing the downloaded file.
    const config = this.deps.getConfig()
    const explicit = explicitModelPath(entry.role, config)
    if (explicit && !this.deps.env.exists(explicit)) {
      this.deps.updateConfig(explicitPathPatch(entry.role, config, null))
    }
    this.emit()
    if (!this.manager.isActive()) this.deps.onModelsReady?.()
  }

  // ---- user-supplied files ------------------------------------------------

  async pickFolder(): Promise<ModelsActionResult> {
    const dir = await this.deps.pickers.pickFolder()
    if (dir === null) return this.result({ code: 'canceled' })
    this.deps.updateConfig({ models: { dir } })
    this.refresh()
    return this.result(null)
  }

  /** "Locate existing models": looks for the manifest file names in a folder and uses what it finds. */
  async locateFolder(): Promise<ModelsActionResult> {
    const dir = await this.deps.pickers.pickFolder()
    if (dir === null) return this.result({ code: 'canceled' })
    const names = new Map((await this.deps.listDir(dir)).map((name) => [name.toLowerCase(), name]))
    let found = 0
    let notice: ModelNotice | null = null
    for (const entry of this.manifest) {
      const actual = names.get(entry.fileName.toLowerCase())
      if (!actual) continue
      found++
      const outcome = await this.apply(entry.role, join(dir, actual), false)
      if (outcome && !notice) notice = outcome
    }
    if (found === 0) return this.result({ code: 'nothing-found' })
    return this.result(notice)
  }

  async pickFile(role: ModelRole): Promise<ModelsActionResult> {
    const path = await this.deps.pickers.pickFile(role)
    if (path === null) return this.result({ code: 'canceled', role })
    return this.result(await this.apply(role, path, false))
  }

  /** The user confirmed a file that failed the size check ("use anyway"). */
  async useFile(role: ModelRole, path: string): Promise<ModelsActionResult> {
    return this.result(await this.apply(role, path, true))
  }

  clearPath(role: ModelRole): ModelsActionResult {
    this.deps.updateConfig(explicitPathPatch(role, this.deps.getConfig(), null))
    this.refresh()
    return this.result(null)
  }

  /** Uses `path` for `role`. Returns a notice instead of applying when the size is wrong and `force` is off. */
  private async apply(role: ModelRole, path: string, force: boolean): Promise<ModelNotice | null> {
    const entry = this.manifest.find((e) => e.role === role)
    if (!entry) return null
    const sizeCheck = await this.deps.verifier.checkSize(entry, path)
    if (sizeCheck.status === 'unreadable') return { code: 'unreadable', role, path }
    if (sizeCheck.status === 'size-mismatch' && !force) return { code: 'size-mismatch', role, path }
    this.deps.updateConfig(explicitPathPatch(role, this.deps.getConfig(), path))
    this.checks.delete(path)
    this.refresh()
    return null
  }

  private result(notice: ModelNotice | null): ModelsActionResult {
    return { overview: this.getOverview(), notice }
  }

  private emit(): void {
    if (this.disposed) return
    this.deps.onChange(this.getOverview())
  }

  dispose(): void {
    this.disposed = true
    this.manager.dispose()
  }
}
