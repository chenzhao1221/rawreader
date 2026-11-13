import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { ServerRole, ServerStatus } from '../../shared/ipc/contract'
import { wantsServer } from '../llama/manager'
import { serversFor, serversUnavailable } from './services'

const status = (role: ServerRole, state: ServerStatus['state'], port: number | null = null): ServerStatus => ({
  role,
  state,
  port,
  pid: null,
  errorCode: null,
  message: null,
})

const configFor = (engine: 'local' | 'openai' | 'gemini') => ConfigSchema.parse({ translate: { engine } })

describe('serversFor', () => {
  it('matches the local servers each engine needs', () => {
    expect(serversFor('local')).toEqual(['ocr', 'translate'])
    expect(serversFor('openai')).toEqual(['ocr'])
    expect(serversFor('gemini')).toEqual([])
  })
})

describe('serversUnavailable', () => {
  it('asks for the OpenAI key before looking at the servers', () => {
    expect(serversUnavailable({ ocr: null, translate: null }, 'openai', () => false)).toMatchObject({ code: 'API_KEY_MISSING' })
  })

  it('asks for the Gemini key', () => {
    expect(serversUnavailable({ ocr: null, translate: null }, 'gemini', () => false)).toMatchObject({ code: 'API_KEY_MISSING' })
  })

  it('needs no local server in Gemini mode once a key is set', () => {
    expect(serversUnavailable({ ocr: status('ocr', 'error'), translate: status('translate', 'stopped') }, 'gemini', (name) => name === 'gemini')).toBeNull()
  })

  it('looks only at OCR for the OpenAI engine', () => {
    expect(serversUnavailable({ ocr: status('ocr', 'ready'), translate: null }, 'openai', () => true)).toBeNull()
    expect(serversUnavailable({ ocr: status('ocr', 'starting'), translate: status('translate', 'ready') }, 'openai', () => true)).toMatchObject({
      code: 'SERVER_NOT_READY',
      message: expect.stringContaining('ocr'),
    })
  })
})

describe('wantsServer', () => {
  it('starts nothing when autostart is off', () => {
    const config = ConfigSchema.parse({ llama: { ocr: { autostart: false }, translate: { autostart: false } } })

    expect(wantsServer('ocr', config)).toBe(false)
    expect(wantsServer('translate', config)).toBe(false)
  })

  it('starts neither server in Gemini mode', () => {
    expect(wantsServer('ocr', configFor('gemini'))).toBe(false)
    expect(wantsServer('translate', configFor('gemini'))).toBe(false)
  })

  it('starts only OCR for the OpenAI engine', () => {
    expect(wantsServer('ocr', configFor('openai'))).toBe(true)
    expect(wantsServer('translate', configFor('openai'))).toBe(false)
  })

  it('starts both servers for the local engine', () => {
    expect(wantsServer('ocr', configFor('local'))).toBe(true)
    expect(wantsServer('translate', configFor('local'))).toBe(true)
  })
})
