import { createHash } from 'node:crypto'

/** Content hash of captured image bytes (lower-case hex sha256). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
