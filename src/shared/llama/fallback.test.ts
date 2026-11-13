import { describe, expect, it } from 'vitest'
import type { ServerStatus } from '../ipc/contract'
import { shouldOfferVulkanFallback } from './fallback'

const status = (patch: Partial<ServerStatus>): ServerStatus => ({
  role: 'ocr',
  state: 'ready',
  port: 18791,
  pid: 1,
  errorCode: null,
  message: null,
  ...patch,
})

describe('shouldOfferVulkanFallback', () => {
  it('never offers on Vulkan', () => {
    expect(shouldOfferVulkanFallback('vulkan', [status({ state: 'error', errorCode: 'CRASH_LOOP' })])).toBe(false)
  })

  it('offers when a CUDA or custom server failed to start or keeps crashing', () => {
    for (const errorCode of ['BINARY_MISSING', 'SPAWN_FAILED', 'STARTUP_TIMEOUT', 'EXITED', 'CRASH_LOOP'] as const) {
      expect(shouldOfferVulkanFallback('cuda', [status({}), status({ role: 'translate', state: 'error', errorCode })])).toBe(true)
    }
    expect(shouldOfferVulkanFallback('custom', [status({ state: 'error', errorCode: 'SPAWN_FAILED' })])).toBe(true)
  })

  it('does not offer for healthy servers or for missing models', () => {
    expect(shouldOfferVulkanFallback('cuda', [status({}), status({ role: 'translate' })])).toBe(false)
    expect(shouldOfferVulkanFallback('cuda', [status({ state: 'starting' })])).toBe(false)
    expect(shouldOfferVulkanFallback('cuda', [status({ state: 'error', errorCode: 'MODEL_MISSING' })])).toBe(false)
    expect(shouldOfferVulkanFallback('cuda', [status({ state: 'error', errorCode: 'INVALID_CONFIG' })])).toBe(false)
  })
})