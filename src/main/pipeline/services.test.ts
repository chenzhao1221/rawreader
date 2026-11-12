import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { ServerRole, ServerStatus } from '../../shared/ipc/contract'
import { createModelClients, effectivePort, serversUnavailable } from './services'

const status = (role: ServerRole, state: ServerStatus['state'], port: number | null = null): ServerStatus => ({
  role,
  state,
  port,
  pid: null,
  errorCode: null,
  message: null,
})

describe('serversUnavailable', () => {
  it('is null when both servers are ready', () => {
    expect(serversUnavailable({ ocr: status('ocr', 'ready'), translate: status('translate', 'ready') })).toBeNull()
  })

  it('names the server that is not ready', () => {
    expect(serversUnavailable({ ocr: status('ocr', 'starting'), translate: status('translate', 'ready') })).toMatchObject({
      code: 'SERVER_NOT_READY',
      message: expect.stringContaining('ocr'),
    })
    expect(serversUnavailable({ ocr: status('ocr', 'ready'), translate: null })?.message).toContain('translate')
  })
})

describe('effectivePort', () => {
  it('uses the fallback port from the status when present', () => {
    expect(effectivePort(status('ocr', 'ready', 19000), 18791)).toBe(19000)
    expect(effectivePort(status('ocr', 'ready', null), 18791)).toBe(18791)
    expect(effectivePort(null, 18791)).toBe(18791)
  })
})

describe('createModelClients', () => {
  it('reads ports and prompt settings from the current config on every call', async () => {
    let config = ConfigSchema.parse({})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })),
    )
    const clients = createModelClients(
      () => config,
      (role) => status(role, 'ready', role === 'ocr' ? 19001 : null),
    )

    await clients.ocr.recognize(Uint8Array.from([1, 2, 3]))
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://127.0.0.1:19001/v1/chat/completions')

    await clients.translator.translate({ sources: ['Hello'], index: 0 })
    expect(String(fetchSpy.mock.calls[1]![0])).toBe('http://127.0.0.1:18792/v1/chat/completions')
    const firstBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string)
    expect(firstBody.messages[0].content).toContain('Hello')

    config = ConfigSchema.parse({ translate: { promptVariant: 'baseline' } })
    await clients.translator.translate({ sources: ['A', 'Hello'], index: 1 })
    const secondBody = JSON.parse((fetchSpy.mock.calls[2]![1] as RequestInit).body as string)
    expect(secondBody.messages[0].content).not.toContain('【约束要求】')
    fetchSpy.mockRestore()
  })
})
