import { utilityProcess } from 'electron'
import type { Session, WebContents } from 'electron'
import type { Config } from '../../shared/config/schema'
import type { OverlayResult, PageConfig, PageImagesBatch, PipelineProgress, ServerRole, ServerStatus } from '../../shared/ipc/contract'
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
import { toOverlayPayload } from './overlay-payload'
import { Pipeline } from './scheduler'
import type { PipelineCache } from './scheduler'
import { createModelClients, serversUnavailable } from './services'
import { pageConfigFrom, pipelineSettingsFrom } from './settings'

export interface PipelineWiringOptions {
  getConfig: () => Config
  getServerStatus: (role: ServerRole) => ServerStatus
  browseWebContents: WebContents
  browseSession: Session
  env: ModelPathEnv
  /** Absolute path of the bundled detection worker (`out/main/detect-worker.js`). */
  workerPath: string
  sendProgress: (progress: PipelineProgress) => void
  sendPageConfig: (config: PageConfig) => void
  /** Delivers a finished image to the browse preload. */
  sendOverlay: (payload: OverlayResult) => void
  /** Persistent result cache, or undefined when it could not be opened. */
  cache?: PipelineCache
  logger: Logger
}

export interface PipelineWiring {
  readonly pipeline: Pipeline
  pageHello(hello: { docId: string; url: string }): PageConfig
  pageImages(batch: PageImagesBatch): void
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
  const { logger, browseWebContents: wc } = options
  const cdp: CdpCapture = attachCdpCapture(wc, logger)
  const fetchBytes = createSessionFetch(options.browseSession)
  const clients = createModelClients(options.getConfig, options.getServerStatus)

  const pipeline = new Pipeline({
    settings: () => pipelineSettingsFrom(options.getConfig()),
    capture: (request) => captureImage({ getLoadedBytes: (url) => cdp.getBody(url), fetchBytes }, request),
    detect: new LazyDetectService(options),
    ocr: clients.ocr,
    translator: clients.translator,
    serversUnavailable: () =>
      serversUnavailable({
        ocr: options.getServerStatus('ocr'),
        translate: options.getServerStatus('translate'),
      }),
    onResult: (subscriber, result) => options.sendOverlay(toOverlayPayload(subscriber, result)),
    onFailure: (subscriber, failure) => logger.warn(`image ${subscriber.elId} failed: ${failure.code}: ${failure.message}`),
    onProgress: options.sendProgress,
    ...(options.cache ? { cache: options.cache } : {}),
    logger,
  })
  pipeline.setEnabled(options.getConfig().ui.autoTranslate)

  // Navigation cancels the old page at once; the new page's preload announces its document id.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) pipeline.beginDocument(null)
  })

  return {
    pipeline,
    pageHello({ docId, url }) {
      const config = options.getConfig()
      pipeline.setEnabled(config.ui.autoTranslate)
      pipeline.beginDocument(docId, url)
      return pageConfigFrom(config)
    },
    pageImages(batch) {
      pipeline.submit(batch)
    },
    clearResults() {
      pipeline.clearResults()
    },
    onConfigChanged(next) {
      pipeline.setEnabled(next.ui.autoTranslate)
      pipeline.applySettings()
      options.sendPageConfig(pageConfigFrom(next))
    },
    async dispose() {
      cdp.dispose()
      await pipeline.dispose()
    },
  }
}
