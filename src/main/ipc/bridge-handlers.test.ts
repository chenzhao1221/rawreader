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
  it('delegates status to the bridge dependency', () => {
    const handlers = new Map<string, (payload: unknown, event: SenderEventLike) => unknown>()
    const registrar = { handle: (channel: string, fn: (payload: unknown, event: SenderEventLike) => unknown) => void handlers.set(channel, fn) }
    const deps = { getBridgeStatus: vi.fn(() => ({ state: 'listening', port: 18793, error: null })) }
    registerSkeletonHandlers(registrar as unknown as IpcRegistrar, deps as unknown as HandlerDeps)

    expect(handlers.get('bridge:status')?.(undefined, event(SHELL_ID))).toMatchObject({ state: 'listening', port: 18793 })
    expect(handlers.has('bridge:code')).toBe(false)
    expect(handlers.has('bridge:regenerate')).toBe(false)
  })

  it('accepts the shell only for bridge:status, never the browse view', async () => {
    const handler = vi.fn(() => ({ state: 'off' as const, port: 18793, error: null }))
    const run = createChannelHandler('bridge:status', handler, ids, silentLogger)
    const fromBrowse = await run(event(BROWSE_ID), undefined)
    expect(fromBrowse.ok === false && fromBrowse.error.code).toBe('FORBIDDEN_SENDER')
    const stranger = await run(event(12345), undefined)
    expect(stranger.ok === false && stranger.error.code).toBe('FORBIDDEN_SENDER')
    expect(handler).not.toHaveBeenCalled()
    expect((await run(event(SHELL_ID), undefined)).ok).toBe(true)
  })

  it('rejects a bridge port or extension ID in config patches from the shell', async () => {
    const handler = vi.fn()
    const run = createChannelHandler('config:update', handler, ids, silentLogger)
    expect((await run(event(SHELL_ID), { bridge: { extensionId: 'a'.repeat(32) } })).ok).toBe(false)
    expect((await run(event(SHELL_ID), { bridge: { port: 18800 } })).ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})