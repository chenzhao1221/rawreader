import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretStore } from './store'
import type { Cipher } from './store'

/** Stands in for safeStorage: "encryption" is just the reversed bytes. */
function reversingCipher(available = true): Cipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].reverse()),
    decryptString: (encrypted) => Buffer.from([...encrypted].reverse()).toString('utf8'),
  }
}

let tempDir: string | null = null

function makeStore(cipher: Cipher = reversingCipher()) {
  tempDir = mkdtempSync(join(tmpdir(), 'rawreader-secrets-'))
  const path = join(tempDir, 'secrets.json')
  return { path, cipher, store: new SecretStore(path, cipher) }
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe('SecretStore', () => {
  it('stores and reports keys under each name', () => {
    const { store } = makeStore()

    store.set('openai', 'sk-openai')
    store.set('gemini', 'sk-gemini')

    expect(store.get('openai')).toBe('sk-openai')
    expect(store.get('gemini')).toBe('sk-gemini')
    expect(store.has('openai')).toBe(true)
    expect(store.status()).toEqual({ openai: true, gemini: true })
  })

  it('does not write plaintext to the file', () => {
    const { path, store } = makeStore()

    store.set('openai', 'sk-openai')

    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('sk-openai')
    expect(JSON.parse(raw)).toHaveProperty('openai')
  })

  it('reads the same file back through a new instance', () => {
    const { path, cipher, store } = makeStore()
    store.set('gemini', 'sk-gemini')

    expect(new SecretStore(path, cipher).get('gemini')).toBe('sk-gemini')
  })

  it('removes a key when set to an empty string', () => {
    const { store } = makeStore()
    store.set('openai', 'sk-openai')

    store.set('openai', '   ')

    expect(store.get('openai')).toBeNull()
    expect(store.has('openai')).toBe(false)
    expect(store.status()).toEqual({ openai: false, gemini: false })
  })

  it('throws and writes nothing when the OS cannot encrypt', () => {
    const { path, store } = makeStore(reversingCipher(false))

    expect(() => store.set('openai', 'sk-openai')).toThrow(/encryption/i)
    expect(existsSync(path)).toBe(false)
  })

  it('treats a corrupt file as no keys set', () => {
    const { path, store } = makeStore()
    writeFileSync(path, 'not json')

    expect(store.get('openai')).toBeNull()
    expect(store.has('gemini')).toBe(false)
    expect(store.status()).toEqual({ openai: false, gemini: false })
  })
})
