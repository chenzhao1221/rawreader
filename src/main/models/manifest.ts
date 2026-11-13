import { MODEL_FILE_NAMES } from '../config/model-path'
import type { ModelRole } from '../config/model-path'

export type DownloadSource = 'huggingface' | 'modelscope'

export interface ManifestEntry {
  role: ModelRole
  fileName: string
  /** Exact size in bytes. */
  size: number
  /** Lower-case hex sha256 of the whole file (Hugging Face LFS oid; ModelScope reports the same value). */
  sha256: string
  /** True for files shipped inside the installer. They are never downloaded unless the user removes them. */
  bundled: boolean
  huggingface: { repo: string; /** Commit hash the sha256 and size were read from. */ revision: string }
  /** ModelScope repo with the same file, or null when there is none (no fallback for that file). */
  modelscope: { repo: string; revision: string } | null
  /** Short Simplified Chinese name for the UI. */
  displayName: string
  /** Licence of the model weights, for the notices. */
  license: string
}

/**
 * Pinned model files. Values were read on 2026-05 from the Hugging Face API through hf-mirror.com
 * (`/api/models/<repo>/tree/<revision>`: `size` and `lfs.oid`) and cross-checked against the ModelScope
 * file listing (`/api/v1/models/<repo>/repo/files`), which reports identical sha256 values for the three GGUF files.
 * The detector is not on ModelScope (record not found), so it has no fallback; it ships in the installer.
 */
export const MODEL_MANIFEST: readonly ManifestEntry[] = [
  {
    role: 'detector',
    fileName: MODEL_FILE_NAMES.detector,
    size: 11_120_765,
    sha256: '5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79',
    bundled: true,
    huggingface: { repo: 'ogkalu/comic-text-and-bubble-detector', revision: '16e8a622f91fabc6b5b65c96d32d1183f8843546' },
    modelscope: null,
    displayName: '气泡检测模型',
    license: 'Apache-2.0',
  },
  {
    role: 'ocr',
    fileName: MODEL_FILE_NAMES.ocr,
    size: 935_768_992,
    sha256: '299051d54faa065abc505cc39b8383ea338fd3020c775ea3e0ba514a7022328c',
    bundled: false,
    huggingface: { repo: 'PaddlePaddle/PaddleOCR-VL-1.5-GGUF', revision: 'cc977c16989848c264d813ec1705cb181b7a21ee' },
    modelscope: { repo: 'PaddlePaddle/PaddleOCR-VL-1.5-GGUF', revision: 'master' },
    displayName: '文字识别模型',
    license: 'Apache-2.0',
  },
  {
    role: 'ocrMmproj',
    fileName: MODEL_FILE_NAMES.ocrMmproj,
    size: 881_770_496,
    sha256: 'e7f1a72400fba517046f90d964e2fa0f4dac7781ee3b1bc5d2022f5f8cecbd87',
    bundled: false,
    huggingface: { repo: 'PaddlePaddle/PaddleOCR-VL-1.5-GGUF', revision: 'cc977c16989848c264d813ec1705cb181b7a21ee' },
    modelscope: { repo: 'PaddlePaddle/PaddleOCR-VL-1.5-GGUF', revision: 'master' },
    displayName: '文字识别视觉投影',
    license: 'Apache-2.0',
  },
  {
    role: 'translator',
    fileName: MODEL_FILE_NAMES.translator,
    size: 1_312_164_352,
    sha256: '044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a',
    bundled: false,
    huggingface: { repo: 'IndexTeam/Index-Translate-2B-GGUF', revision: '3a0eca6ce931d88d00614d427ab3ed8ff0743902' },
    modelscope: { repo: 'IndexTeam/Index-Translate-2B-GGUF', revision: 'master' },
    displayName: '翻译模型',
    license: 'Apache-2.0',
  },
]

export function manifestEntry(role: ModelRole): ManifestEntry {
  const entry = MODEL_MANIFEST.find((e) => e.role === role)
  if (!entry) throw new Error(`No manifest entry for ${role}`)
  return entry
}

/** Roles a user must have before translation can start (the detector ships with the app). */
export const REQUIRED_DOWNLOAD_ROLES: readonly ModelRole[] = MODEL_MANIFEST.filter((e) => !e.bundled).map((e) => e.role)

export interface Mirrors {
  huggingface: string
  modelscope: string
}

export interface SourceUrl {
  source: DownloadSource
  url: string
}

function trimSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

/** Download URLs in the order they are tried: Hugging Face mirror first, ModelScope as fallback. */
export function sourceUrlsFor(entry: ManifestEntry, mirrors: Mirrors): SourceUrl[] {
  const file = encodeURIComponent(entry.fileName)
  const urls: SourceUrl[] = [
    {
      source: 'huggingface',
      url: `${trimSlash(mirrors.huggingface)}/${entry.huggingface.repo}/resolve/${entry.huggingface.revision}/${file}`,
    },
  ]
  if (entry.modelscope) {
    urls.push({
      source: 'modelscope',
      url: `${trimSlash(mirrors.modelscope)}/models/${entry.modelscope.repo}/resolve/${entry.modelscope.revision}/${file}`,
    })
  }
  return urls
}