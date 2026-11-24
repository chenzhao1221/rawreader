import { BRIDGE_PORTS, DEFAULT_BRIDGE_PORT } from '../../shared/bridge'
import type { Config } from '../../shared/config/schema'
import type { Logger } from '../log/log'
import { PipelineError } from '../pipeline/scheduler'
import type { TranslateBytesOptions, TranslateBytesResult } from '../pipeline/scheduler'
import { normalizeContext } from './context'
import { toBridgeResult } from './protocol'
import type { PingResponse } from './protocol'
import { createBridgeServer } from './server'
import type { BridgeFailure, BridgeHistoryPort, BridgeServer, BridgeServerDeps } from './server'

export type BridgeState = 'off' | 'starting' | 'listening' | 'error'

/** What the settings page shows. */
export interface BridgeStatus {
  state: BridgeState
  /** Port in use while listening, else the default one. */
  port: number
  /** Redacted start error (port in use, bind failure), or null. */
  error: string | null
}

export interface BridgeDeps {
  getConfig(): Config
  pipeline: { translateBytes(bytes: Uint8Array, options?: TranslateBytesOptions): Promise<TranslateBytesResult> }
  /** `null` when the configured engine can take work, otherwise why not (as for the desktop pipeline). */
  serversUnavailable(): { code: string; message: string } | null
  appInfo: { productName: string; version: string }
  /** Reading history behind `POST /history` and `POST /history/open`. */
  history?: BridgeHistoryPort
  logger: Logger
  /** Test seam: replaces the HTTP server. */
  createServer?: (deps: BridgeServerDeps) => BridgeServer
}

export interface Bridge {
  /** Starts the listener when `bridge.enabled` is true (the default). A no-op otherwise. */
  start(): Promise<void>
  /** Stops listening and aborts in-flight requests. Safe to call when not running. */
  stop(): Promise<void>
  /** Reacts to a config change: enable or disable. */
  onConfigChanged(next: Config, previous: Config): Promise<void>
  getStatus(): BridgeStatus
}

/** Pipeline failures that are not the caller's business are reported without internals. */
function toFailure(error: unknown): BridgeFailure {
  if (error instanceof PipelineError && error.code !== 'INTERNAL') return { code: error.code, message: error.message }
  return { code: 'internal', message: 'Translation failed' }
}

/**
 * Lifecycle of the extension bridge (design 4.4). Everything Electron-specific is injected, so the default-on
 * rule, the port fallback and the enable / disable paths are unit-tested with a fake server.
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

  function serverDeps(): BridgeServerDeps {
    return {
      ...(deps.history ? { history: deps.history } : {}),
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
      maxImageBytes: () => deps.getConfig().pipeline.maxImageBytes,
      logger: deps.logger,
    }
  }

  async function listen(): Promise<void> {
    if (!deps.getConfig().bridge.enabled || server) return
    state = 'starting'
    error = null
    const created = make(serverDeps())
    let lastError = 'Cannot start the bridge'
    // First free port of the fixed range; the extension probes the same list.
    for (const port of BRIDGE_PORTS) {
      try {
        activePort = await created.start(port)
        server = created
        state = 'listening'
        deps.logger.info(`bridge listening on 127.0.0.1:${activePort}`)
        return
      } catch (failure) {
        // Port in use and bind errors carry no secrets, but keep to the message only.
        lastError = failure instanceof Error ? failure.message : lastError
      }
    }
    server = null
    activePort = null
    state = 'error'
    error = lastError
    deps.logger.error(`bridge failed to start on every port: ${lastError}`)
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
      if (now.enabled === was.enabled) return Promise.resolve()
      return enqueue(async () => {
        if (!now.enabled) return close()
        // Enabled now: a fresh enable needs a (re)start.
        if (server || state === 'error') await close()
        return listen()
      })
    },
    getStatus() {
      return { state, port: activePort ?? DEFAULT_BRIDGE_PORT, error }
    },
  }
}

/** Creates the bridge and starts it when `bridge.enabled` is true (the default). */
export async function startBridge(deps: BridgeDeps): Promise<Bridge> {
  const bridge = createBridge(deps)
  await bridge.start()
  return bridge
}

/** Stops the bridge first in the shutdown sequence (before the pipeline and the servers). */
export async function stopBridge(bridge: Bridge | null): Promise<void> {
  await bridge?.stop()
}
