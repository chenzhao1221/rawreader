import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { MODEL_FILE_NAMES, isMissingModel, resolveModelPath } from './model-path'

const userDataDir = join('C:', 'data')
const resourcesDir = join('C:', 'res')
const config = ConfigSchema.parse({})

function env(existing: string[]) {
  const set = new Set(existing)
  return { userDataDir, resourcesDir, exists: (p: string) => set.has(p) }
}

describe('resolveModelPath', () => {
  it('prefers the explicit path when the file exists', () => {
    const explicit = join('D:', 'mine', 'ocr.gguf')
    const cfg = ConfigSchema.parse({ models: { paths: { ocr: explicit } } })
    expect(resolveModelPath('ocr', cfg, env([explicit]))).toBe(explicit)
  })

  it('reports a missing explicit path as the expected path, without falling back', () => {
    const explicit = join('D:', 'mine', 'ocr.gguf')
    const cfg = ConfigSchema.parse({ models: { paths: { ocr: explicit } } })
    const fallback = join(userDataDir, 'models', MODEL_FILE_NAMES.ocr)
    expect(resolveModelPath('ocr', cfg, env([fallback]))).toEqual({ missing: true, expectedPath: explicit })
  })

  it('looks in <userData>/models by default', () => {
    const file = join(userDataDir, 'models', MODEL_FILE_NAMES.translator)
    expect(resolveModelPath('translator', config, env([file]))).toBe(file)
    expect(resolveModelPath('translator', config, env([]))).toEqual({ missing: true, expectedPath: file })
  })

  it('uses models.dir when set', () => {
    const dir = join('E:', 'models')
    const cfg = ConfigSchema.parse({ models: { dir } })
    const file = join(dir, MODEL_FILE_NAMES.ocrMmproj)
    expect(resolveModelPath('ocrMmproj', cfg, env([file]))).toBe(file)
  })

  it('falls back to the bundled detector', () => {
    const bundled = join(resourcesDir, 'detector', MODEL_FILE_NAMES.detector)
    expect(resolveModelPath('detector', config, env([bundled]))).toBe(bundled)
    const missing = resolveModelPath('detector', config, env([]))
    expect(isMissingModel(missing) && missing.expectedPath).toBe(bundled)
  })
})
