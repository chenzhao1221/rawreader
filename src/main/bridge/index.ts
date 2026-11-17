import type { Config, DeepPartial } from '../../shared/config/schema'
import type { Logger } from '../log/log'
import { PipelineError } from '../pipeline/scheduler'
import type { TranslateBytesOptions, TranslateBytesResult } from '../pipeline/scheduler'
import { normalizeContext } from './context'
import { formatPairingCode, generatePairingCode } from './pairing'
import type { RandomBytes } from './pairing'
import { toBridgeResult } from './protocol'
import type { PingResponse } from './protocol'
import { createBridgeServer } from './server'
import type { BridgeFailure, BridgeServer, BridgeServerDeps } from './server'

export type BridgeState = 'off' | 'starting' | 'listening' | 'error'

/** What the settings page shows. Never contains the pairing code. */
export interface BridgeStatus {
  state: BridgeState
  /** Port in use while listening, else the configured one. */
  port: number
  /** Redacted start error (port in use, bind failure), or null. */
  error: string | null
  /** Extension ID recorded at the first authenticated request, or null. */
  extensionId: string | null
}

export interface BridgeDeps {
  getConfig(): Config
  updateConfig(patch: DeepPartial<Config>): Config
  pipeline: { translateBytes(bytes: Uint8Array, options?: TranslateBytesOptions): Promise<TranslateBytesResult> }
  /** `null` when the configured engine can take work, otherwise why not (as for the desktop pipeline). */
  serversUnavailable(): { code: string; message: string } | null
  /** The pairing code lives under the secret name `bridge`. */
  secrets: { get(name: 'bridge'): string | null; set(name: 'bridge', value: string): void }
  randomBytes: RandomBytes
  appInfo: { productName: string; version: string }
  logger: Logger
  /** Test seam: replaces the HTTP server. */
  createServer?: (deps: BridgeServerDeps) => BridgeServer
}

export interface Bridge {
  /** Starts the listener when `bridge.enabled` is true. A no-op otherwise: nothing listens by default. */
  start(): Promise<void>
  /** Stops listening and aborts in-flight requests. Safe to call when not running. */
  stop(): Promise<void>
  /** Reacts to a config change: enable, disable or port change. */
  onConfigChanged(next: Config, previous: Config): Promise<void>
  getStatus(): BridgeStatus
  /** The code in display form (`ABCD-EFGH-JKMN-PQRS`); created on first use. */
  showCode(): string
  /** Invalidates the old code and clears the recorded extension ID. Returns the new code in display form. */
  regenerateCode(): string
}

/** Pipeline failures that are not the caller's business are reported without internals. */
function toFailure(error: unknown): BridgeFailure {
  if (error instanceof PipelineError && error.code !== 'INTERNAL') return { code: error.code, message: error.message }
  return { code: 'internal', message: 'Translation failed' }
}

/**
 * Lifecycle of the extension bridge (design 4.4). Everything Electron-specific is injected, so the default-off
 * rule and the enable / disable / port-change paths are unit-tested with a fake server.
 */
export function createBridge(deps: BridgeDeps): Bridge {
  const make = deps.createServer ?? createBridgeServer
  let server: BridgeServer | null = null
  let state: BridgeState = 'off'
  let activePort: number | null = null
  let error: string | null = null
  /** Start and stop calls run one after the other. */
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  function ensureCode(): string {
    const existing = deps.secrets.get('bridge')
    if (existing) return existing
    const fresh = generatePairingCode(deps.randomBytes)
    deps.secrets.set('bridge', fresh)
    return fresh
  }

  function serverDeps(): BridgeServerDeps {
    return {
      ping(): PingResponse {
        const reason = deps.serversUnavailable()
        return {
          v: 1,
          app: deps.appInfo.productName,
          version: deps.appInfo.version,
          ready: reason === null,
          engine: deps.getConfig().translate.engine,
          ...(reason ? { reason } : {}),
        }
      },
      async translate(job) {
        const context = normalizeContext(job.context)
        try {
          const result = await deps.pipeline.translateBytes(job.bytes, {
            priority: job.priority,
            signal: job.signal,
            ...(context ? { context } : {}),
            ...(job.boxes ? { boxes: job.boxes } : {}),
          })
          return toBridgeResult(result)
        } catch (failure) {
          throw toFailure(failure)
        }
      },
      pairing: {
        getCode: () => ensureCode(),
        getExtensionId: () => deps.getConfig().bridge.extensionId,
        recordExtensionId: (id) => {
          deps.updateConfig({ bridge: { extensionId: id } })
          deps.logger.info('bridge paired with an extension (trust on first use)')
        },
      },
      maxImageBytes: () => deps.getConfig().pipeline.maxImageBytes,
      logger: deps.logger,
    }
  }

  async function listen(): Promise<void> {
    const config = deps.getConfig().bridge
    if (!config.enabled || server) return
    state = 'starting'
    error = null
    const created = make(serverDeps())
    try {
      ensureCode()
      activePort = await created.start(config.port)
      server = created
      state = 'listening'
      deps.logger.info(`bridge listening on 127.0.0.1:${activePort}`)
    } catch (failure) {
      server = null
      activePort = null
      state = 'error'
      // Port in use and bind errors carry no secrets, but keep to the message only.
      error = failure instanceof Error ? failure.message : 'Cannot start the bridge'
      deps.logger.error(`bridge failed to start: ${error}`)
    }
  }

  async function close(): Promise<void> {
    const current = server
    server = null
    activePort = null
    if (current) {
      await current.stop().catch((failure: unknown) => {
        deps.logger.warn(`bridge stop failed: ${failure instanceof Error ? failure.message : String(failure)}`)
      })
      deps.logger.info('bridge stopped')
    }
    state = 'off'
    error = null
  }

  return {
    start: () => enqueue(listen),
    stop: () => enqueue(close),
    onConfigChanged(next, previous) {
      const was = previous.bridge
      const now = next.bridge
      if (now.enabled === was.enabled && now.port === was.port) return Promise.resolve()
      return enqueue(async () => {
        if (!now.enabled) return close()
        // Enabled now: a new port or a fresh enable needs a (re)start.
        if (server || state === 'error') await close()
        return listen()
      })
    },
    getStatus() {
      const config = deps.getConfig().bridge
      return { state, port: activePort ?? config.port, error, extensionId: config.extensionId }
    },
    showCode() {
      return formatPairingCode(ensureCode())
    },
    regenerateCode() {
      const fresh = generatePairingCode(deps.randomBytes)
      deps.secrets.set('bridge', fresh)
      // The old code is gone and the next authenticated request records its extension again.
      deps.updateConfig({ bridge: { extensionId: null } })
      deps.logger.info('bridge pairing code regenerated')
      return formatPairingCode(fresh)
    },
  }
}

/** Creates the bridge and starts it when `bridge.enabled` is true. With the default config nothing listens. */
export async function startBridge(deps: BridgeDeps): Promise<Bridge> {
  const bridge = createBridge(deps)
  await bridge.start()
  return bridge
}

/** Stops the bridge first in the shutdown sequence (before the pipeline and the servers). */
export async function stopBridge(bridge: Bridge | null): Promise<void> {
  await bridge?.stop()
}
