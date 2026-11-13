import type { Config } from '../../shared/config/schema'
import type { ServerRole, ServerStatus } from '../../shared/ipc/contract'
import { OcrClient } from '../ocr/client'
import { RETRY_SCALE, looksLikeFormula } from '../ocr/garbled'

/** Enlarges a PNG crop for a second OCR pass. sharp is loaded on first use only. */
async function upscale(png: Uint8Array): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp')
  const image = sharp(png)
  const { width, height } = await image.metadata()
  if (!width || !height) throw new Error('Unreadable crop')
  const out = await image.resize(width * RETRY_SCALE, height * RETRY_SCALE, { kernel: 'lanczos3' }).png().toBuffer()
  return new Uint8Array(out)
}
import { TranslateClient } from '../translate/client'
import type { TranslateRequest, TranslateResult } from '../translate/client'
import type { PipelineDeps } from './scheduler'

/** Port the server actually listens on: the status port after a free-port fallback, else the configured one. */
export function effectivePort(status: ServerStatus | null, configured: number): number {
  return status?.port ?? configured
}

/** Reason the pipeline cannot call the servers yet, or `null` when both are ready. */
export function serversUnavailable(statuses: Record<ServerRole, ServerStatus | null>): { code: string; message: string } | null {
  for (const role of ['ocr', 'translate'] as const) {
    const status = statuses[role]
    if (status?.state !== 'ready') {
      const detail = status ? `${status.state}${status.errorCode ? ` (${status.errorCode})` : ''}` : 'unknown'
      return { code: 'SERVER_NOT_READY', message: `${role} server is not ready: ${detail}` }
    }
  }
  return null
}

/**
 * OCR and translation clients that read ports and prompt settings from the
 * current config on every call, so config changes and port fallbacks apply
 * without rebuilding the pipeline.
 */
export function createModelClients(
  getConfig: () => Config,
  getStatus: (role: ServerRole) => ServerStatus | null,
): Pick<PipelineDeps, 'ocr' | 'translator'> {
  const clientFor = (config: Config): TranslateClient => clientForConfig(config, getStatus)
  return {
    ocr: {
      async recognize(png, signal) {
        const config = getConfig()
        const client = new OcrClient({
          getPort: () => effectivePort(getStatus('ocr'), config.llama.ocr.port),
          model: config.llama.ocr.alias,
        })
        const first = await client.recognize(png, signal)
        if (!first.ok || !looksLikeFormula(first.text)) return first
        // A formula instead of lettering: read the crop again at twice the size.
        const larger = await upscale(png).catch(() => null)
        const second = larger ? await client.recognize(larger, signal) : null
        if (second?.ok && !looksLikeFormula(second.text)) return second
        // Still a formula: the text is lost. Empty text means "no text": not translated, not drawn.
        return { ...first, text: '' }
      },
    },
    translator: {
      translate(request: TranslateRequest): Promise<TranslateResult> {
        return clientFor(getConfig()).translate(request)
      },
      // Batch mode needs the Index prompt rules; the baseline variant stays one bubble per request.
      translateBatch(sources, signal) {
        const config = getConfig()
        if (!config.translate.batch || config.translate.promptVariant !== 'lmt') return Promise.resolve(sources.map(() => null))
        return clientFor(config).translateBatch(sources, signal)
      },
    },
  }
}

function clientForConfig(
  config: Config,
  getStatus: (role: ServerRole) => ServerStatus | null,
): TranslateClient {
  return new TranslateClient({
    getPort: () => effectivePort(getStatus('translate'), config.llama.translate.port),
    model: config.llama.translate.alias,
    targetLang: config.translate.targetLang,
    promptVariant: config.translate.promptVariant,
    contextUnits: config.translate.contextUnits,
  })
}
