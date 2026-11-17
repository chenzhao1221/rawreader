import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../log/log'
import { registerSkeletonHandlers } from './handlers'
import type { HandlerDeps } from './handlers'
import { createChannelHandler } from './register'
import type { IpcRegistrar, SenderEventLike } from './register'

const SHELL_ID = 7
const BROWSE_ID = 9
const ids = { shell: () => SHELL_ID, isBrowse: (id: number) => id === BROWSE_ID }
const event = (senderId: number): SenderEventLike => ({ sender: { id: senderId } }) as unknown as SenderEventLike

describe('bridge IPC channels', () => {
  it('delegate status, show code and regenerate to the bridge dependencies', () => {
    const handlers = new Map<string, (payload: unknown, event: SenderEventLike) => unknown>()
    const registrar = { handle: (channel: string, fn: (payload: unknown, event: SenderEventLike) => unknown) => void handlers.set(channel, fn) }
    const deps = {
      getBridgeStatus: vi.fn(() => ({ state: 'off', port: 18793, error: null, extensionId: null })),
      showBridgeCode: vi.fn(() => ({ code: 'ABCD-EFGH-JKMN-PQRS' })),
      regenerateBridgeCode: vi.fn(() => ({ code: 'WXYZ-0123-4567-89AB' })),
    }
    registerSkeletonHandlers(registrar as unknown as IpcRegistrar, deps as unknown as HandlerDeps)

    expect(handlers.get('bridge:status')?.(undefined, event(SHELL_ID))).toMatchObject({ state: 'off' })
    expect(handlers.get('bridge:code')?.(undefined, event(SHELL_ID))).toEqual({ code: 'ABCD-EFGH-JKMN-PQRS' })
    expect(handlers.get('bridge:regenerate')?.(undefined, event(SHELL_ID))).toEqual({ code: 'WXYZ-0123-4567-89AB' })
    expect(deps.regenerateBridgeCode).toHaveBeenCalledTimes(1)
  })

  it.each(['bridge:status', 'bridge:code', 'bridge:regenerate'] as const)('%s accepts the shell only, never the browse view', async (channel) => {
    const handler = vi.fn(() => ({ code: 'x', state: 'off', port: 1, error: null, extensionId: null }))
    const run = createChannelHandler(channel, handler, ids, silentLogger)
    const fromBrowse = await run(event(BROWSE_ID), undefined)
    expect(fromBrowse.ok === false && fromBrowse.error.code).toBe('FORBIDDEN_SENDER')
    const stranger = await run(event(12345), undefined)
    expect(stranger.ok === false && stranger.error.code).toBe('FORBIDDEN_SENDER')
    expect(handler).not.toHaveBeenCalled()
    expect((await run(event(SHELL_ID), undefined)).ok).toBe(true)
  })

  it('keeps the recorded extension ID out of config patches from the shell', async () => {
    const handler = vi.fn()
    const run = createChannelHandler('config:update', handler, ids, silentLogger)
    const result = await run(event(SHELL_ID), { bridge: { extensionId: 'a'.repeat(32) } })
    expect(result.ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})
