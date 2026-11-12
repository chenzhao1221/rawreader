import { ConfigSchema } from '../../shared/config/schema'
import type { Config } from '../../shared/config/schema'
import { isPlainObject } from './merge'
import type { PlainObject } from './merge'

export interface SanitizeResult {
  config: Config
  warnings: string[]
}

const MAX_PASSES = 64

function deletePath(root: PlainObject, path: readonly string[]): void {
  let node: unknown = root
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(node)) return
    node = node[path[i] as string]
  }
  if (isPlainObject(node)) delete node[path[path.length - 1] as string]
}

/**
 * Parses stored config with field-level fallback. Every invalid field is
 * dropped and re-defaulted by the schema, and one warning per field is
 * returned. Issues inside arrays drop the whole array.
 */
export function sanitizeConfig(raw: unknown): SanitizeResult {
  const warnings: string[] = []
  let current: PlainObject = {}
  if (isPlainObject(raw)) {
    current = structuredClone(raw)
  } else if (raw !== undefined && raw !== null) {
    warnings.push('Stored config is not an object; using defaults')
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = ConfigSchema.safeParse(current)
    if (result.success) return { config: result.data, warnings }

    const seen = new Set<string>()
    for (const issue of result.error.issues) {
      const full = issue.path.map((p) => String(p))
      const arrayIndex = issue.path.findIndex((p) => typeof p === 'number')
      const path = arrayIndex === -1 ? full : full.slice(0, arrayIndex)
      const key = path.join('.')
      if (seen.has(key)) continue
      seen.add(key)

      if (path.length === 0) {
        current = {}
        warnings.push(`Invalid config root: ${issue.message}; using defaults`)
      } else {
        deletePath(current, path)
        warnings.push(`Invalid config value at "${key}": ${issue.message}; using default`)
      }
    }
  }

  warnings.push('Config could not be repaired; using defaults')
  return { config: ConfigSchema.parse({}), warnings }
}
