export type PlainObject = Record<string, unknown>

export function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Deep-merges `patch` over `base` and returns a new object. Plain objects merge
 * recursively. Arrays, primitives and `null` replace the base value. `undefined`
 * patch values are ignored. Neither input is mutated.
 */
export function deepMerge(base: PlainObject, patch: PlainObject): PlainObject {
  const out: PlainObject = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (value === undefined) continue
    const existing = out[key]
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value)
    } else if (isPlainObject(value)) {
      out[key] = deepMerge({}, value)
    } else {
      out[key] = Array.isArray(value) ? [...(value as unknown[])] : value
    }
  }
  return out
}
