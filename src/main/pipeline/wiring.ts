import { utilityProcess } from 'electron'
import type { Session, WebContents } from 'electron'
import type { Config } from '../../shared/config/schema'
import type {
  OverlayResult,
  PageConfig,
  PageImagesBatch,
  PageTranslateImage,
  PageTranslateRequest,
  PipelineProgress,
  ServerRole,
  ServerStatus,
} from '../../shared/ipc/contract'
import { attachCdpCapture } from '../capture/cdp'
import type { CdpCapture } from '../capture/cdp'
import { captureImage } from '../capture/capture'
import { createSessionFetch } from '../capture/session-fetch'
import { isMissingModel, resolveModelPath } from '../config/model-path'
import type { ModelPathEnv } from '../config/model-path'
import { DetectClient } from '../detect/client'
import type { WorkerLike } from '../detect/client'
import type { DetectJob, DetectOutcome, DetectService } from '../detect/service'
import type { Logger } from '../log/log'
import type { FetchLike as GeminiFetch } from '../gemini/client'
import type { SecretName } from '../secrets/store'
import { toOverlayPayload } from './overlay-payload'
import { Pipeline } from './scheduler'
import type { PipelineCache } from './scheduler'
import { createModelClients, serversUnavailable } from './services'
import { pageConfigFrom, pipelineSettingsFrom } from './settings'

export interface PipelineWiringOptions {
  getConfig: () => Config
  getServerStatus: (role: ServerRole) => ServerStatus
  browseSession: Session
  env: ModelPathEnv
  /** Absolute path of the bundled detection worker (`out/main/detect-worker.js`). */
  workerPath: string
  sendProgress: (progress: PipelineProgress) => void
  /** Persistent result cache, or undefined when it could not be opened. */
  cache?: PipelineCache
  /** API keys (OpenAI-compatible API, Gemini). */
  secrets: { get(name: SecretName): string | null; has(name: SecretName): boolean }
  /** Network fetch for Gemini (Electron net, so the system proxy applies). */
  fetch: GeminiFetch
  logger: Logger
}

export interface PipelineWiring {
  readonly pipeline: Pipeline
  /** A tab was created: watch its image responses (CDP) and navigations. */
  attachTab(wc: WebContents): void
  /** A tab is closing. */
  detachTab(wc: WebContents): void
  /**
   * Only the active tab is translated. Switching pauses the old tab (its page stops reporting) and
   * restarts the new one, whose page then reports its images again; finished images come from the cache.
   */
  setActiveTab(wc: WebContents | null): void
  pageHello(hello: { docId: string; url: string }, senderId: number): PageConfig
  pageImages(batch: PageImagesBatch, senderId: number): void
  /** Right-click: asks the page of tab `wc` which image lies at the click. The page answers through `translateImage`. */
  requestImageTranslation(wc: WebContents, request: PageTranslateRequest): void
  /**
   * Translates one image the user picked (right-click menu), whatever the auto-translate switch says, and sends the
   * result to its element. Resolves false when the image could not be translated.
   */
  translateImage(request: PageTranslateImage, senderId: number): Promise<boolean>
  /** Forget in-memory results after the persistent cache was cleared. */
  clearResults(): void
  onConfigChanged(next: Config): void
  dispose(): Promise<void>
}

/**
 * Detection service that resolves the detector model and starts the utility
 * process on first use, so startup never waits for it. A missing model fails
 * the image, not the app (R6.7).
 */
class LazyDetectService implements DetectService {
  private client: DetectClient | null = null

  constructor(
    private readonly options: PipelineWiringOptions,
  ) {}

  async detect(job: DetectJob): Promise<DetectOutcome> {
    if (!this.client) {
      const modelPath = resolveModelPath('detector', this.options.getConfig(), this.options.env)
      if (isMissingModel(modelPath)) {
        return { ok: false, error: { code: 'MODEL_MISSING', message: `Detector model not found at ${modelPath.expectedPath}` } }
      }
      this.client = new DetectClient({
        fork: () =>
          utilityProcess.fork(this.options.workerPath, [], { serviceName: 'detector', stdio: 'ignore' }) as unknown as WorkerLike,
        modelPath,
        logger: this.options.logger,
      })
    }
    return this.client.detect(job)
  }

  async dispose(): Promise<void> {
    await this.client?.dispose()
    this.client = null
  }
}

/**
 * Electron edge of the pipeline: CDP capture on the browse view, the
 * `session.fetch` fallback, the detection utility process, the model clients
 * and the IPC-facing entry points. Everything with logic lives in pure
 * modules next to it.
 */
export function createPipelineWiring(options: PipelineWiringOptions): PipelineWiring {
  const { logger } = options
  const fetchBytes = createSessionFetch(options.browseSession)
  const clients = createModelClients(options.getConfig, options.getServerStatus, options.secrets.get, options.fetch, logger)

  interface TabEntry {
    wc: WebContents
    cdp: CdpCapture
    /** Last document the tab's preload announced. */
    doc: { docId: string; url: string } | null
  }
  const tabs = new Map<number, TabEntry>()
  let activeId: number | null = null

  const send = (
    wc: WebContents,
    channel: 'page:config' | 'overlay:result' | 'page:translate-request',
    payload: PageConfig | OverlayResult | PageTranslateRequest,
  ): void => {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
  /** Inactive tabs keep their overlays (and the visibility toggle) but do not scan. */
  const configFor = (config: Config, id: number): PageConfig => {
    const page = pageConfigFrom(config)
    return id === activeId ? page : { ...page, enabled: false }
  }

  const pipeline = new Pipeline({
    settings: () => pipelineSettingsFrom(options.getConfig()),
    capture: (request) =>
      captureImage(
        {
          getLoadedBytes: async (url) => {
            const entry = activeId === null ? undefined : tabs.get(activeId)
            return entry ? entry.cdp.getBody(url) : null
          },
          fetchBytes,
        },
        request,
      ),
    detect: new LazyDetectService(options),
    // Chrome extension bridge: boxes the user drew skip detection. sharp loads on first use.
    cropBoxes: async (bytes, boxes, padding) => (await import('../detect/crop')).cropBoxesToUnits(bytes, boxes, padding),
    ocr: clients.ocr,
    translator: clients.translator,
    ...(clients.vision ? { vision: clients.vision } : {}),
    serversUnavailable: () =>
      serversUnavailable(
        {
          ocr: options.getServerStatus('ocr'),
          translate: options.getServerStatus('translate'),
        },
        options.getConfig().translate.engine,
        options.secrets.has,
      ),
    onResult: (subscriber, result) => {
      const payload = toOverlayPayload(subscriber, result)
      for (const entry of tabs.values()) {
        if (entry.doc?.docId === subscriber.docId) send(entry.wc, 'overlay:result', payload)
      }
    },
    onFailure: (subscriber, failure) => logger.warn(`image ${subscriber.elId} failed: ${failure.code}: ${failure.message}`),
    onProgress: options.sendProgress,
    ...(options.cache ? { cache: options.cache } : {}),
    logger,
  })
  pipeline.setEnabled(options.getConfig().ui.autoTranslate)

  return {
    pipeline,
    attachTab(wc) {
      if (tabs.has(wc.id)) return
      const entry: TabEntry = { wc, cdp: attachCdpCapture(wc, logger), doc: null }
      tabs.set(wc.id, entry)
      // Navigation cancels the old page at once; the new page's preload announces its document id.
      wc.on('did-start-navigation', (details) => {
        if (!details.isMainFrame || details.isSameDocument) return
        entry.doc = null
        if (wc.id === activeId) pipeline.beginDocument(null)
      })
    },
    detachTab(wc) {
      const entry = tabs.get(wc.id)
      if (!entry) return
      tabs.delete(wc.id)
      entry.cdp.dispose()
      if (activeId === wc.id) {
        activeId = null
        pipeline.beginDocument(null)
      }
    },
    setActiveTab(wc) {
      const nextId = wc && tabs.has(wc.id) ? wc.id : null
      if (nextId === activeId) return
      const config = options.getConfig()
      const previous = activeId === null ? undefined : tabs.get(activeId)
      activeId = nextId
      pipeline.beginDocument(null)
      if (previous) send(previous.wc, 'page:config', configFor(config, previous.wc.id))
      const next = nextId === null ? undefined : tabs.get(nextId)
      if (!next) return
      if (next.doc) pipeline.beginDocument(next.doc.docId, next.doc.url)
      // enabled false -> true makes the page forget what it reported and report again.
      send(next.wc, 'page:config', configFor(config, next.wc.id))
    },
    pageHello({ docId, url }, senderId) {
      const config = options.getConfig()
      const entry = tabs.get(senderId)
      if (entry) entry.doc = { docId, url }
      if (senderId === activeId) {
        pipeline.setEnabled(config.ui.autoTranslate)
        pipeline.beginDocument(docId, url)
      }
      return configFor(config, senderId)
    },
    pageImages(batch, senderId) {
      if (senderId === activeId) pipeline.submit(batch)
    },
    requestImageTranslation(wc, request) {
      if (tabs.has(wc.id)) send(wc, 'page:translate-request', request)
    },
    async translateImage({ docId, pageUrl, image }, senderId) {
      const entry = tabs.get(senderId)
      // A page that has navigated since the click is not the page the user asked about.
      if (!entry || entry.doc?.docId !== docId) return false
      try {
        const captured = await captureImage(
          { getLoadedBytes: (url) => entry.cdp.getBody(url), fetchBytes },
          { url: image.url, pageUrl, maxBytes: pipelineSettingsFrom(options.getConfig()).maxImageBytes },
        )
        if (!captured.ok) {
          logger.warn(`manual image ${image.elId} failed: ${captured.code}: ${captured.detail ?? ''}`)
          return false
        }
        // Same stage queues, settings and cache as the page scan, and ahead of it. The auto-translate switch does not gate this call.
        const result = await pipeline.translateBytes(captured.image.bytes, { priority: 1_000_000 })
        if (entry.doc?.docId !== docId) return false
        send(entry.wc, 'overlay:result', toOverlayPayload({ docId, elId: image.elId }, result))
        return true
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        logger.warn(`manual image ${image.elId} failed: ${typeof code === 'string' ? code : 'INTERNAL'}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    clearResults() {
      pipeline.clearResults()
    },
    onConfigChanged(next) {
      pipeline.setEnabled(next.ui.autoTranslate)
      pipeline.applySettings()
      for (const entry of tabs.values()) send(entry.wc, 'page:config', configFor(next, entry.wc.id))
    },
    async dispose() {
      for (const entry of tabs.values()) entry.cdp.dispose()
      tabs.clear()
      activeId = null
      await pipeline.dispose()
    },
  }
}
