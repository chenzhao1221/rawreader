import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../log/log'
import { createChannelHandler, createIpcRegistrar } from './register'
import type { IpcMainLike, SenderEventLike } from './register'

const SHELL_ID = 7
const BROWSE_ID = 9
const ids = { shell: () => SHELL_ID, isBrowse: (id: number) => id === BROWSE_ID }

function event(senderId: number): SenderEventLike {
  return { sender: { id: senderId } } as unknown as SenderEventLike
}

describe('createChannelHandler', () => {
  it('returns the handler value for a valid call from the shell', async () => {
    const run = createChannelHandler('browse:go', () => undefined, ids, silentLogger)
    expect(await run(event(SHELL_ID), { action: 'reload' })).toEqual({ ok: true, value: undefined })
  })

  it('rejects an invalid payload with INVALID_PAYLOAD and does not run the handler', async () => {
    const handler = vi.fn()
    const run = createChannelHandler('browse:go', handler, ids, silentLogger)
    const result = await run(event(SHELL_ID), { action: 'format-disk' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_PAYLOAD')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects unknown keys in config:update payloads', async () => {
    const handler = vi.fn()
    const run = createChannelHandler('config:update', handler, ids, silentLogger)
    const result = await run(event(SHELL_ID), { ui: { lastUrl: 'https://example.com' } })
    expect(result.ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a call from the browse view with FORBIDDEN_SENDER', async () => {
    const handler = vi.fn()
    const run = createChannelHandler('config:get', handler, ids, silentLogger)
    const result = await run(event(BROWSE_ID), undefined)
    expect(result).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN_SENDER', message: expect.any(String) },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects an unknown sender and a missing view', async () => {
    const handler = vi.fn()
    const run = createChannelHandler('llama:status', handler, ids, silentLogger)
    const stranger = await run(event(12345), undefined)
    expect(stranger.ok === false && stranger.error.code).toBe('FORBIDDEN_SENDER')

    const noShell = createChannelHandler('llama:status', handler, { shell: () => null, isBrowse: () => false }, silentLogger)
    const result = await noShell(event(SHELL_ID), undefined)
    expect(result.ok === false && result.error.code).toBe('FORBIDDEN_SENDER')
    expect(handler).not.toHaveBeenCalled()
  })

  it('maps a thrown error to INTERNAL without leaking its message', async () => {
    const run = createChannelHandler(
      'config:get',
      () => {
        throw new Error('secret path C:\\Users\\x\\token')
      },
      ids,
      silentLogger,
    )
    const result = await run(event(SHELL_ID), undefined)
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Internal error' } })
  })

  it('maps a rejected promise to INTERNAL', async () => {
    const run = createChannelHandler('llama:status', () => Promise.reject(new Error('boom')), ids, silentLogger)
    const result = await run(event(SHELL_ID), undefined)
    expect(result.ok === false && result.error.code).toBe('INTERNAL')
  })
})

describe('createIpcRegistrar', () => {
  it('registers wrapped handlers on ipcMain and removes them on dispose', async () => {
    const handlers = new Map<string, (e: SenderEventLike, raw: unknown) => unknown>()
    const removed: string[] = []
    const ipcMain = {
      handle: (channel: string, fn: (e: SenderEventLike, raw: unknown) => unknown) => void handlers.set(channel, fn),
      removeHandler: (channel: string) => void removed.push(channel),
    } as unknown as IpcMainLike

    const registrar = createIpcRegistrar(ipcMain, ids, silentLogger)
    registrar.handle('shell:panel-visibility', () => undefined)

    const fn = handlers.get('shell:panel-visibility')
    expect(fn).toBeDefined()
    expect(await fn?.(event(SHELL_ID), { open: true })).toEqual({ ok: true, value: undefined })

    registrar.dispose()
    expect(removed).toEqual(['shell:panel-visibility'])
  })
})
