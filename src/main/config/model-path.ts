import { join } from 'node:path'
import type { Config } from '../../shared/config/schema'

export type ModelRole = 'detector' | 'ocr' | 'ocrMmproj' | 'translator'

/** Default file names inside the models folder (and the bundled detector folder). */
export const MODEL_FILE_NAMES: Readonly<Record<ModelRole, string>> = {
  detector: 'detector-v4-s_int8.onnx',
  ocr: 'PaddleOCR-VL-1.5.gguf',
  ocrMmproj: 'PaddleOCR-VL-1.5-mmproj.gguf',
  translator: 'Index-Translate-2B.Q4_K_M.gguf',
}

export interface MissingModel {
  missing: true
  expectedPath: string
}

/** An existing absolute path, or the place where the file is expected. */
export type ModelPathResult = string | MissingModel

export function isMissingModel(result: ModelPathResult): result is MissingModel {
  return typeof result !== 'string'
}

export interface ModelPathEnv {
  /** `app.getPath('userData')`. */
  userDataDir: string
  /** Folder holding bundled extraResources (`process.resourcesPath` when packaged). */
  resourcesDir: string
  exists: (path: string) => boolean
}

/**
 * Resolves the effective path of a model file. Order: explicit config path,
 * then `<models dir>/<default file name>`, then for the detector the bundled
 * copy. A missing file is reported with the path where it is expected. This
 * function never downloads anything.
 */
export function resolveModelPath(role: ModelRole, config: Config, env: ModelPathEnv): ModelPathResult {
  const fileName = MODEL_FILE_NAMES[role]
  const explicit = config.models.paths[role]
  if (explicit) {
    return env.exists(explicit) ? explicit : { missing: true, expectedPath: explicit }
  }

  const modelsDir = config.models.dir ?? join(env.userDataDir, 'models')
  const inModelsDir = join(modelsDir, fileName)
  if (env.exists(inModelsDir)) return inModelsDir

  if (role === 'detector') {
    const bundled = join(env.resourcesDir, 'detector', fileName)
    return env.exists(bundled) ? bundled : { missing: true, expectedPath: bundled }
  }
  return { missing: true, expectedPath: inModelsDir }
}
