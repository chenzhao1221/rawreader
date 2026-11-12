import { dirname } from 'node:path'
import type {
  Config,
  OcrServerConfig,
  TranslateServerConfig,
} from '../../shared/config/schema'
import type { LlamaErrorCode, ServerRole } from '../../shared/ipc/contract'
import { isMissingModel, resolveModelPath } from '../config/model-path'
import type { ModelPathEnv } from '../config/model-path'
import { buildOcrArgs, buildTranslateArgs } from './args'
import type { OcrPaths, TranslatePaths } from './args'
import { resolveServerExe } from './backend'

export type LaunchSpec =
  | {
      role: 'ocr'
      exePath: string
      cwd: string
      cfg: OcrServerConfig
      paths: OcrPaths
      startupTimeoutMs: number
    }
  | {
      role: 'translate'
      exePath: string
      cwd: string
      cfg: TranslateServerConfig
      paths: TranslatePaths
      startupTimeoutMs: number
    }

export type LaunchResolution =
  | { ok: true; spec: LaunchSpec }
  | { ok: false; code: Extract<LlamaErrorCode, 'BINARY_MISSING' | 'MODEL_MISSING'>; message: string }

/**
 * Resolves everything needed to spawn one server: the executable for the
 * selected backend and the model files for the role. Pure apart from the
 * injected `exists`. Never downloads anything.
 */
export function resolveLaunch(role: ServerRole, config: Config, env: ModelPathEnv): LaunchResolution {
  const exe = resolveServerExe(config.llama, env)
  if (!exe.ok) return { ok: false, code: exe.code, message: exe.message }

  const common = { exePath: exe.exePath, cwd: dirname(exe.exePath), startupTimeoutMs: config.llama.startupTimeoutMs }

  if (role === 'ocr') {
    const model = resolveModelPath('ocr', config, env)
    if (isMissingModel(model)) {
      return { ok: false, code: 'MODEL_MISSING', message: `OCR model not found at ${model.expectedPath}` }
    }
    const mmproj = resolveModelPath('ocrMmproj', config, env)
    if (isMissingModel(mmproj)) {
      return { ok: false, code: 'MODEL_MISSING', message: `OCR projector not found at ${mmproj.expectedPath}` }
    }
    return { ok: true, spec: { role, ...common, cfg: config.llama.ocr, paths: { ocr: model, ocrMmproj: mmproj } } }
  }

  const translator = resolveModelPath('translator', config, env)
  if (isMissingModel(translator)) {
    return {
      ok: false,
      code: 'MODEL_MISSING',
      message: `Translation model not found at ${translator.expectedPath}`,
    }
  }
  return { ok: true, spec: { role, ...common, cfg: config.llama.translate, paths: { translator } } }
}

/** Builds the argument list for `spec` using the effective `port`. */
export function buildArgs(spec: LaunchSpec, port: number = spec.cfg.port): string[] {
  return spec.role === 'ocr' ? buildOcrArgs(spec.cfg, spec.paths, port) : buildTranslateArgs(spec.cfg, spec.paths, port)
}

/**
 * Stable string of every config value that affects how a role's server is
 * launched. A change in this string means the server must restart.
 * `autostart` is excluded on purpose.
 */
export function launchFingerprint(role: ServerRole, config: Config): string {
  const { autostart: _autostart, ...server } = config.llama[role]
  return JSON.stringify({
    backend: config.llama.backend,
    build: config.llama.build,
    binDirs: config.llama.binDirs,
    startupTimeoutMs: config.llama.startupTimeoutMs,
    server,
    modelsDir: config.models.dir,
    modelPaths: role === 'ocr'
      ? [config.models.paths.ocr, config.models.paths.ocrMmproj]
      : [config.models.paths.translator],
  })
}
