/** Result of reading a limited body. */
export type LimitedBody = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too-large' }

/**
 * Reads a web stream into one buffer and stops as soon as more than `maxBytes`
 * arrive, so a huge or endless response cannot fill memory (R4.4).
 */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredLength?: number | null,
): Promise<LimitedBody> {
  if (declaredLength != null && declaredLength > maxBytes) {
    await body?.cancel().catch(() => {})
    return { ok: false, reason: 'too-large' }
  }
  if (body === null) return { ok: true, bytes: new Uint8Array(0) }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return { ok: false, reason: 'too-large' }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

/** Decodes a `data:` URL into bytes. Returns `null` for malformed input. */
export function decodeDataUrl(url: string): Uint8Array | null {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma === -1) return null
  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  try {
    if (/;base64$/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'))
    return new Uint8Array(Buffer.from(decodeURIComponent(payload), 'latin1'))
  } catch {
    return null
  }
}
