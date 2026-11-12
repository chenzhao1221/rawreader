import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { deepMerge, isPlainObject } from './merge'
import type { PlainObject } from './merge'

export interface OverlayOptions {
  /** Repository root. Relative paths in the overlay resolve against it. */
  rootDir: string
  /** Process environment; `RAWREADER_DEV_CONFIG` replaces the default overlay file. */
  env?: Record<string, string | undefined>
  /** Returns file text, or null when the file does not exist. Injected in tests. */
  readFile?: (path: string) => string | null
}

export interface OverlayResult {
  overlay: PlainObject
  /** Files that were applied, in order. */
  sources: string[]
  warnings: string[]
}

/** Config locations that hold filesystem paths. Only these are resolved against the repo root. */
const PATH_FIELDS: readonly (readonly string[])[] = [
  ['llama', 'binDirs', 'vulkan'],
  ['llama', 'binDirs', 'cuda'],
  ['llama', 'binDirs', 'custom'],
  ['models', 'dir'],
  ['models', 'paths', 'detector'],
  ['models', 'paths', 'ocr'],
  ['models', 'paths', 'ocrMmproj'],
  ['models', 'paths', 'translator'],
]

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Returns a copy of `overlay` with relative path fields made absolute. */
export function resolveOverlayPaths(overlay: PlainObject, rootDir: string): PlainObject {
  const out = structuredClone(overlay)
  for (const path of PATH_FIELDS) {
    let node: unknown = out
    for (let i = 0; i < path.length - 1; i++) {
      node = isPlainObject(node) ? node[path[i] as string] : undefined
    }
    const leaf = path[path.length - 1] as string
    if (isPlainObject(node) && typeof node[leaf] === 'string') {
      const value = node[leaf]
      node[leaf] = isAbsolute(value) ? value : resolve(rootDir, value)
    }
  }
  return out
}

/**
 * Loads the dev-only config overlay: `dev.config.json` (or the file named by
 * `RAWREADER_DEV_CONFIG`), then `dev.config.local.json` on top. The result is
 * applied in memory only and is never written back to the store.
 */
export function loadDevOverlay(options: OverlayOptions): OverlayResult {
  const { rootDir } = options
  const env = options.env ?? {}
  const readFile = options.readFile ?? defaultReadFile
  const warnings: string[] = []
  const sources: string[] = []
  let merged: PlainObject = {}

  const explicit = env['RAWREADER_DEV_CONFIG']
  const files: { path: string; required: boolean }[] = [
    { path: explicit ? resolve(rootDir, explicit) : join(rootDir, 'dev.config.json'), required: Boolean(explicit) },
    { path: join(rootDir, 'dev.config.local.json'), required: false },
  ]

  for (const file of files) {
    let text: string | null
    try {
      text = readFile(file.path)
    } catch (error) {
      warnings.push(`Cannot read dev config ${file.path}: ${(error as Error).message}`)
      continue
    }
    if (text === null) {
      if (file.required) warnings.push(`Dev config not found: ${file.path}`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      warnings.push(`Dev config is not valid JSON (${file.path}): ${(error as Error).message}`)
      continue
    }
    if (!isPlainObject(parsed)) {
      warnings.push(`Dev config must be a JSON object: ${file.path}`)
      continue
    }
    merged = deepMerge(merged, resolveOverlayPaths(parsed, rootDir))
    sources.push(file.path)
  }

  return { overlay: merged, sources, warnings }
}
