import { join } from 'node:path'
import type { Config, DeepPartial } from '../../shared/config/schema'
import { translatorOption } from '../../shared/models/translators'

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

/** File name of a role for the current config: the translator follows `models.translator`. */
export function modelFileName(role: ModelRole, config: Config): string {
  return role === 'translator' ? translatorOption(config.models.translator).fileName : MODEL_FILE_NAMES[role]
}

/**
 * A file the user (or the dev config) pinned for a role. Translator paths are kept per model:
 * `models.translatorPaths[<id>]`, and the older `models.paths.translator` still counts for the default model.
 */
export function explicitModelPath(role: ModelRole, config: Config): string | null {
  if (role !== 'translator') return config.models.paths[role]
  const id = config.models.translator
  return config.models.translatorPaths[id] ?? (id === 'index-2b' ? config.models.paths.translator : null)
}

/** The config patch that pins (or, with null, unpins) `path` for a role. */
export function explicitPathPatch(role: ModelRole, config: Config, path: string | null): DeepPartial<Config> {
  if (role === 'translator' && config.models.translator !== 'index-2b') {
    return { models: { translatorPaths: { [config.models.translator]: path } } }
  }
  return { models: { paths: { [role]: path } } }
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
  const fileName = modelFileName(role, config)
  const explicit = explicitModelPath(role, config)
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
  // The full package ships the default models next to the app (resources/models).
  const bundledModel = join(env.resourcesDir, 'models', fileName)
  if (env.exists(bundledModel)) return bundledModel
  return { missing: true, expectedPath: inModelsDir }
}
