/**
 * Local translation models the user can pick. All values were read on 2026-11-13 from the Hugging
 * Face API (`/api/models/<repo>` for the revision, `/tree/<revision>` for `size` and `lfs.oid`) and
 * cross-checked against the ModelScope file listing, which reports the same size and sha256.
 * Shared with the renderer for the settings and setup pages, so no Node imports here.
 */

export const TRANSLATOR_IDS = ['index-2b', 'hy-mt-1.8b', 'qwen3-4b', 'hy-mt-7b'] as const
export type TranslatorId = (typeof TRANSLATOR_IDS)[number]

export interface TranslatorOption {
  id: TranslatorId
  fileName: string
  /** Exact size in bytes. */
  size: number
  /** Lower-case hex sha256 of the whole file. */
  sha256: string
  huggingface: { repo: string; revision: string }
  modelscope: { repo: string; revision: string } | null
  /** Short Simplified Chinese name for the UI. */
  displayName: string
  /** One line for the UI: what it is good at. */
  note: string
  license: string
  /**
   * Video memory the translation server needs with this file, in bytes: measured for Index-2B
   * (1.47 GB with a 1.31 GB file, ctx 8192), the others estimated the same way (file + 12% + 0.2 GB).
   */
  vramBytes: number
}

const GB = 1024 ** 3
const vramFor = (size: number): number => Math.round(size * 1.12 + 0.2 * GB)

export const TRANSLATOR_OPTIONS: readonly TranslatorOption[] = [
  {
    id: 'index-2b',
    fileName: 'Index-Translate-2B.Q4_K_M.gguf',
    size: 1_312_164_352,
    sha256: '044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a',
    huggingface: { repo: 'IndexTeam/Index-Translate-2B-GGUF', revision: '3a0eca6ce931d88d00614d427ab3ed8ff0743902' },
    modelscope: { repo: 'IndexTeam/Index-Translate-2B-GGUF', revision: 'master' },
    displayName: 'Index-Translate 2B（默认）',
    note: 'B 站 Index 团队的翻译专用模型，小而快，日常够用。',
    license: 'Apache-2.0',
    vramBytes: 1_541_406_720, // measured 1.47 GB
  },
  {
    id: 'hy-mt-1.8b',
    fileName: 'HY-MT1.5-1.8B-Q4_K_M.gguf',
    size: 1_133_080_512,
    sha256: '4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7',
    huggingface: { repo: 'tencent/HY-MT1.5-1.8B-GGUF', revision: '265b2e615a7dc9b06c435dc878829ad99a512ba2' },
    modelscope: { repo: 'Tencent-Hunyuan/HY-MT1.5-1.8B-GGUF', revision: 'master' },
    displayName: '腾讯混元 HY-MT1.5 1.8B',
    note: '腾讯的翻译专用模型，比默认的略小，支持 33 种语言。',
    license: 'Tencent HY Community License（不适用于欧盟、英国、韩国）',
    vramBytes: vramFor(1_133_080_512),
  },
  {
    id: 'qwen3-4b',
    fileName: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    size: 2_497_281_120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    huggingface: { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: 'a06e946bb6b655725eafa393f4a9745d460374c9' },
    modelscope: { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: 'master' },
    displayName: '通义千问 Qwen3 4B',
    note: '通用对话模型，更懂上下文和梗，大一倍、慢一些。',
    license: 'Apache-2.0',
    vramBytes: vramFor(2_497_281_120),
  },
  {
    id: 'hy-mt-7b',
    fileName: 'HY-MT1.5-7B-Q4_K_M.gguf',
    size: 4_624_649_312,
    sha256: 'fc87637e4dd29547811a28170770c2ac17725fb7690b7c4aafa4f463c3e77568',
    huggingface: { repo: 'tencent/HY-MT1.5-7B-GGUF', revision: '126325496bc8e3575f1d8615b8ca951d8483f206' },
    modelscope: { repo: 'Tencent-Hunyuan/HY-MT1.5-7B-GGUF', revision: 'master' },
    displayName: '腾讯混元 HY-MT1.5 7B',
    note: '同系列的大号，翻得最好，要 8 GB 以上显存的显卡。',
    license: 'Tencent HY Community License（不适用于欧盟、英国、韩国）',
    vramBytes: vramFor(4_624_649_312),
  },
]

export function translatorOption(id: TranslatorId): TranslatorOption {
  return TRANSLATOR_OPTIONS.find((o) => o.id === id) ?? (TRANSLATOR_OPTIONS[0] as TranslatorOption)
}
