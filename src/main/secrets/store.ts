import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** Names of the stored secrets. */
export type SecretName = 'openai' | 'gemini' | 'bridge'
export const SECRET_NAMES: readonly SecretName[] = ['openai', 'gemini', 'bridge']

/** Secrets the shell UI may set or see (the bridge pairing code is managed by the bridge only). */
export type UserSecretName = Exclude<SecretName, 'bridge'>

/** The slice of Electron's `safeStorage` this module uses (DPAPI on Windows). */
export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * API keys, encrypted with the OS user's key (Electron safeStorage) and kept in one JSON file of
 * base64 blobs. Keys never go to the renderer, the config file or the logs; the shell only learns
 * whether a key is set.
 */
export class SecretStore {
  private cache: Partial<Record<SecretName, string>> | null = null

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
  ) {}

  get(name: SecretName): string | null {
    return this.load()[name] ?? null
  }

  has(name: SecretName): boolean {
    return (this.load()[name] ?? '').length > 0
  }

  status(): Record<UserSecretName, boolean> {
    return { openai: this.has('openai'), gemini: this.has('gemini') }
  }

  /** Saves a key, or removes it when `value` is empty. Throws when the OS cannot encrypt. */
  set(name: SecretName, value: string): void {
    const trimmed = value.trim()
    const next = { ...this.load() }
    if (trimmed) next[name] = trimmed
    else delete next[name]
    if (Object.keys(next).length > 0 && !this.cipher.isEncryptionAvailable()) {
      throw new Error('OS encryption is not available; the key was not saved')
    }
    const blobs: Record<string, string> = {}
    for (const [key, plain] of Object.entries(next)) {
      if (plain) blobs[key] = this.cipher.encryptString(plain).toString('base64')
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(blobs), { mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = next
  }

  private load(): Partial<Record<SecretName, string>> {
    if (this.cache) return this.cache
    const out: Partial<Record<SecretName, string>> = {}
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      for (const name of SECRET_NAMES) {
        const blob = raw[name]
        if (typeof blob !== 'string' || !this.cipher.isEncryptionAvailable()) continue
        try {
          out[name] = this.cipher.decryptString(Buffer.from(blob, 'base64'))
        } catch {
          // Encrypted by another Windows user or a broken file: treat as not set.
        }
      }
    } catch {
      // No file yet.
    }
    this.cache = out
    return out
  }
}
