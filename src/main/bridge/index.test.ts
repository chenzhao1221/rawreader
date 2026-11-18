import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PORTS } from '../../shared/bridge'
import { ConfigSchema } from '../../shared/config/schema'
import type { Config } from '../../shared/config/schema'
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

function harness(initial: Config = defaults(), options: { busyPorts?: readonly number[] } = {}) {
  let config = initial
  const servers: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; deps: BridgeServerDeps }> = []
  const translateBytes = vi.fn()
  const deps: BridgeDeps = {
    getConfig: () => config,
    pipeline: { translateBytes },
    serversUnavailable: () => null,
    appInfo: { productName: 'App', version: '1.2.3' },
    logger: silentLogger,
    createServer: (serverDeps): BridgeServer => {
      const start = vi.fn((port: number) => (options.busyPorts?.includes(port) ? Promise.reject(new Error('listen EADDRINUSE')) : Promise.resolve(port)))
      const stop = vi.fn(() => Promise.resolve())
      servers.push({ start, stop, deps: serverDeps })
      return { start, stop, listening: false }
    },
  }
  return { deps, servers, translateBytes, setConfig: (next: Config) => (config = next), getConfig: () => config }
}

describe('bridge lifecycle', () => {
  it('is enabled by default', () => {
    expect(defaults().bridge.enabled).toBe(true)
  })

  it('starts with the default config on 127.0.0.1:18793', async () => {
    const h = harness()
    const bridge = await startBridge(h.deps)
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0]?.start).toHaveBeenCalledTimes(1)
    expect(h.servers[0]?.start).toHaveBeenCalledWith(18793)
    expect(bridge.getStatus()).toEqual({ state: 'listening', port: 18793, error: null })
  })

  it('takes the next free port of 18793-18797 when ports are busy', async () => {
    const h = harness(defaults(), { busyPorts: [18793, 18794] })
    const bridge = await startBridge(h.deps)
    expect(h.servers[0]?.start.mock.calls.map((call) => call[0])).toEqual([18793, 18794, 18795])
    expect(bridge.getStatus()).toEqual({ state: 'listening', port: 18795, error: null })
  })

  it('reports an error in the status when every port is busy, and stays usable', async () => {
    const h = harness(defaults(), { busyPorts: BRIDGE_PORTS })
    const bridge = await startBridge(h.deps)
    expect(h.servers[0]?.start).toHaveBeenCalledTimes(BRIDGE_PORTS.length)
    expect(bridge.getStatus()).toMatchObject({ state: 'error', error: 'listen EADDRINUSE' })
    await expect(bridge.stop()).resolves.toBeUndefined()
    expect(bridge.getStatus().state).toBe('off')
  })

  it('does not listen when the user turned the bridge off', async () => {
    const h = harness(withBridge({ enabled: false }))
    const bridge = await startBridge(h.deps)
    expect(h.servers).toHaveLength(0)
    expect(bridge.getStatus()).toMatchObject({ state: 'off', port: 18793 })
    await bridge.onConfigChanged(withBridge({ enabled: false, startHidden: true }), withBridge({ enabled: false }))
    await stopBridge(bridge)
    expect(h.servers).toHaveLength(0)
  })

  it('reacts to disable and enable, and stops in-flight work on the way', async () => {
    const h = harness()
    const bridge = await startBridge(h.deps)
    const on = h.getConfig()

    const same = withBridge({ startHidden: true })
    h.setConfig(same)
    await bridge.onConfigChanged(same, on)
    expect(h.servers).toHaveLength(1) // startHidden alone does not restart

    const off = withBridge({ enabled: false })
    h.setConfig(off)
    await bridge.onConfigChanged(off, same)
    expect(h.servers[0]?.stop).toHaveBeenCalledTimes(1)
    expect(bridge.getStatus().state).toBe('off')

    h.setConfig(on)
    await bridge.onConfigChanged(on, off)
    expect(h.servers).toHaveLength(2)
    expect(bridge.getStatus()).toMatchObject({ state: 'listening', port: 18793 })
  })

  it('answers ping from the engine state without paths or settings', async () => {
    const h = harness()
    await startBridge(h.deps)
    expect(h.servers[0]?.deps.ping()).toEqual({ v: 1, app: 'App', version: '1.2.3', ready: true, engine: 'local' })
    const reason = { code: 'SERVER_NOT_READY', message: 'ocr server is not ready' }
    h.deps.serversUnavailable = () => reason
    expect(h.servers[0]?.deps.ping()).toMatchObject({ ready: false, reason })
  })

  it('hands request data to the pipeline and hides internal errors', async () => {
    const h = harness()
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
