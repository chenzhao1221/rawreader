import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { Config, DeepPartial } from '../../shared/config/schema'
import { silentLogger } from '../log/log'
import { PipelineError } from '../pipeline/scheduler'
import { createBridge, startBridge, stopBridge } from './index'
import type { BridgeDeps } from './index'
import type { BridgeServer, BridgeServerDeps } from './server'

const defaults = (): Config => ConfigSchema.parse({})
const withBridge = (patch: Partial<Config['bridge']>): Config => {
  const base = defaults()
  return { ...base, bridge: { ...base.bridge, ...patch } }
}

function harness(initial: Config = defaults(), options: { failStart?: boolean } = {}) {
  let config = initial
  const secrets = new Map<string, string>()
  const servers: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; deps: BridgeServerDeps }> = []
  const translateBytes = vi.fn()
  let counter = 0
  const deps: BridgeDeps = {
    getConfig: () => config,
    updateConfig: (patch: DeepPartial<Config>) => {
      config = { ...config, bridge: { ...config.bridge, ...patch.bridge } } as Config
      return config
    },
    pipeline: { translateBytes },
    serversUnavailable: () => null,
    secrets: { get: (name) => secrets.get(name) ?? null, set: (name, value) => void secrets.set(name, value) },
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    appInfo: { productName: 'App', version: '1.2.3' },
    logger: silentLogger,
    createServer: (serverDeps): BridgeServer => {
      const start = vi.fn((port: number) => (options.failStart ? Promise.reject(new Error('listen EADDRINUSE')) : Promise.resolve(port)))
      const stop = vi.fn(() => Promise.resolve())
      servers.push({ start, stop, deps: serverDeps })
      return { start, stop, listening: false }
    },
  }
  return { deps, servers, secrets, translateBytes, setConfig: (next: Config) => (config = next), getConfig: () => config }
}

describe('bridge lifecycle', () => {
  it('never creates a server or listens with the default config', async () => {
    const h = harness()
    expect(h.getConfig().bridge.enabled).toBe(false)
    const bridge = await startBridge(h.deps)
    expect(h.servers).toHaveLength(0)
    expect(bridge.getStatus()).toMatchObject({ state: 'off', extensionId: null })
    // Disabled stays disabled when unrelated config changes arrive.
    await bridge.onConfigChanged(withBridge({}), defaults())
    await stopBridge(bridge)
    expect(h.servers).toHaveLength(0)
    expect(h.secrets.size).toBe(0) // no pairing code is created either
  })

  it('starts on 127.0.0.1 at the configured port when enabled, and creates the pairing code', async () => {
    const h = harness(withBridge({ enabled: true, port: 18900 }))
    const bridge = await startBridge(h.deps)
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0]?.start).toHaveBeenCalledWith(18900)
    expect(bridge.getStatus()).toEqual({ state: 'listening', port: 18900, error: null, extensionId: null })
    expect(h.secrets.get('bridge')).toMatch(/^[0-9A-Z]{16}$/)
  })

  it('reacts to enable, port change and disable, and stops in-flight work on the way', async () => {
    const h = harness()
    const bridge = createBridge(h.deps)
    const off = h.getConfig()

    const on = withBridge({ enabled: true, port: 18900 })
    h.setConfig(on)
    await bridge.onConfigChanged(on, off)
    expect(h.servers).toHaveLength(1)

    const moved = withBridge({ enabled: true, port: 18901 })
    h.setConfig(moved)
    await bridge.onConfigChanged(moved, on)
    expect(h.servers[0]?.stop).toHaveBeenCalledTimes(1)
    expect(h.servers[1]?.start).toHaveBeenCalledWith(18901)
    expect(bridge.getStatus().port).toBe(18901)

    const same = withBridge({ enabled: true, port: 18901, startHidden: true })
    h.setConfig(same)
    await bridge.onConfigChanged(same, moved)
    expect(h.servers).toHaveLength(2) // startHidden alone does not restart

    h.setConfig(off)
    await bridge.onConfigChanged(off, same)
    expect(h.servers[1]?.stop).toHaveBeenCalledTimes(1)
    expect(bridge.getStatus().state).toBe('off')
  })

  it('reports a start failure in the status and keeps running without a listener', async () => {
    const h = harness(withBridge({ enabled: true }), { failStart: true })
    const bridge = await startBridge(h.deps)
    expect(bridge.getStatus()).toMatchObject({ state: 'error', error: 'listen EADDRINUSE' })
    await expect(bridge.stop()).resolves.toBeUndefined()
    expect(bridge.getStatus().state).toBe('off')
  })

  it('keeps the pairing code across restarts, regenerates it on request and clears the recorded extension', async () => {
    const h = harness(withBridge({ enabled: true, extensionId: 'a'.repeat(32) }))
    const bridge = await startBridge(h.deps)
    const first = bridge.showCode()
    expect(first).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    expect(bridge.showCode()).toBe(first)

    const second = bridge.regenerateCode()
    expect(second).not.toBe(first)
    expect(h.getConfig().bridge.extensionId).toBeNull()
    expect(h.secrets.get('bridge')).toBe(second.replaceAll('-', ''))
    // The running server reads the new code at once.
    expect(h.servers[0]?.deps.pairing.getCode()).toBe(second.replaceAll('-', ''))
  })

  it('records the extension ID through the config on first use', async () => {
    const h = harness(withBridge({ enabled: true }))
    await startBridge(h.deps)
    h.servers[0]?.deps.pairing.recordExtensionId('b'.repeat(32))
    expect(h.getConfig().bridge.extensionId).toBe('b'.repeat(32))
  })

  it('answers ping from the engine state without paths or settings', async () => {
    const h = harness(withBridge({ enabled: true }))
    await startBridge(h.deps)
    expect(h.servers[0]?.deps.ping()).toEqual({ v: 1, app: 'App', version: '1.2.3', ready: true, engine: 'local' })
    const reason = { code: 'SERVER_NOT_READY', message: 'ocr server is not ready' }
    h.deps.serversUnavailable = () => reason
    expect(h.servers[0]?.deps.ping()).toMatchObject({ ready: false, reason })
  })

  it('hands request data to the pipeline and hides internal errors', async () => {
    const h = harness(withBridge({ enabled: true }))
    await startBridge(h.deps)
    const server = h.servers[0]?.deps as BridgeServerDeps
    const signal = new AbortController().signal
    h.translateBytes.mockResolvedValueOnce({
      hash: 'h', width: 1, height: 2, cached: false, captureSource: 'bridge', units: [], timings: { captureMs: 0, detectMs: 0, ocrMs: 0, translateMs: 0 },
    })
    const out = await server.translate({ bytes: Uint8Array.from([1]), priority: 2, context: { summary: 's' }, boxes: undefined, signal })
    expect(out).toMatchObject({ v: 1, hash: 'h', cached: false })
    const options = h.translateBytes.mock.calls[0]?.[1]
    expect(options).toMatchObject({ priority: 2, signal, context: { background: ['剧情：s'] } })
    expect(options).not.toHaveProperty('boxes')

    h.translateBytes.mockRejectedValueOnce(new PipelineError('SERVER_NOT_READY', 'ocr server is not ready'))
    await expect(server.translate({ bytes: Uint8Array.from([1]), priority: 0, context: undefined, boxes: undefined, signal })).rejects.toEqual({
      code: 'SERVER_NOT_READY',
      message: 'ocr server is not ready',
    })
    h.translateBytes.mockRejectedValueOnce(new PipelineError('INTERNAL', 'ENOENT C:\\Users\\someone\\secret'))
    await expect(server.translate({ bytes: Uint8Array.from([1]), priority: 0, context: undefined, boxes: undefined, signal })).rejects.toEqual({
      code: 'internal',
      message: 'Translation failed',
    })
  })
})
