import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIDGE_ALLOWED_ORIGIN, BRIDGE_EXTENSION_ID, BRIDGE_PORTS } from '../../shared/bridge'

const root = join(import.meta.dirname, '..', '..', '..')
const keyFile = JSON.parse(readFileSync(join(root, 'extension', 'extension-key.json'), 'utf8')) as { key: string; extensionId: string }

/** Chrome derives the ID from the public key: sha256 of the DER, first 16 bytes, hex digits mapped to a-p. */
function idFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16))).join('')
}

describe('pinned extension identity', () => {
  it('derives the allowed extension ID from the public key in extension-key.json', () => {
    expect(idFromKey(keyFile.key)).toBe(BRIDGE_EXTENSION_ID)
    expect(keyFile.extensionId).toBe(BRIDGE_EXTENSION_ID)
    expect(BRIDGE_ALLOWED_ORIGIN).toBe(`chrome-extension://${BRIDGE_EXTENSION_ID}`)
  })

  it('uses the same port list as the extension', () => {
    const protocol = readFileSync(join(root, 'extension', 'src', 'lib', 'bridge', 'protocol.ts'), 'utf8')
    for (const port of BRIDGE_PORTS) expect(protocol).toContain(String(port))
    expect(BRIDGE_PORTS[0]).toBe(18793)
  })
})