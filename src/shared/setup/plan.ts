import type { HardwareInfo } from '../ipc/contract'

export type SetupEngine = 'local' | 'openai' | 'gemini'

/** 推荐 / 能用但慢 / 带不动 */
export type SetupVerdict = 'recommended' | 'workable' | 'blocked'

export type SetupReason = 'vram-low' | 'vram-tight' | 'ram-low' | 'ram-tight' | 'disk-short'

export interface EnginePlan {
  verdict: SetupVerdict
  reasons: SetupReason[]
  /** Free disk shortfall in bytes when the models do not fit. */
  shortfallBytes: number | null
}

const GB = 1024 ** 3

/**
 * Requirements come from the model files themselves (see MODEL_MANIFEST) plus the memory
 * llama-server needs on top:
 * - local: OCR 0.94 GB + vision projector 0.88 GB + translator 1.31 GB = 3.1 GB of weights,
 *   two servers with a 4K context each.
 * - openai: the OCR pair only, 1.8 GB.
 * Below the minimum, Windows spills the model into shared memory and every bubble crawls.
 *
 * Measured 2026-11-13 on an RX 7700 XT (Vulkan, -ngl 99, ctx 4096/8192, --cache-ram 256):
 * OCR server 2.6 GB RAM / 1.8 GB VRAM, translation server 2.5 GB RAM / 1.5 GB VRAM, so 3.3 GB VRAM
 * and 5.1 GB RAM for both, plus about 1.5 GB for the app itself.
 */
export const LOCAL_TARGET = {
  // A 4 GB card reports slightly less than 4 GiB (an RX 560 says 4_293_918_720 bytes), so the minimum sits below it.
  minVramBytes: 3.5 * GB,
  recommendedVramBytes: 6 * GB,
  minRamBytes: 8 * GB,
  recommendedRamBytes: 16 * GB,
}
export const API_TARGET = { minRamBytes: 6 * GB, recommendedRamBytes: 12 * GB }

export function largestVram(hardware: HardwareInfo): number {
  let largest = 0
  for (const gpu of hardware.gpus) {
    if (gpu.vramBytes !== null && gpu.vramBytes > largest) largest = gpu.vramBytes
  }
  return largest
}

/**
 * Judges one translation engine against the detected hardware. A disk shortfall always blocks,
 * everything else is a soft call: the UI still lets the user force a blocked engine.
 */
export function planEngine(engine: SetupEngine, hardware: HardwareInfo, diskNeedBytes: number): EnginePlan {
  if (hardware.freeDiskBytes !== null && diskNeedBytes > hardware.freeDiskBytes) {
    return { verdict: 'blocked', reasons: ['disk-short'], shortfallBytes: diskNeedBytes - hardware.freeDiskBytes }
  }
  if (engine === 'gemini') return { verdict: 'recommended', reasons: [], shortfallBytes: null }

  const target = engine === 'local' ? LOCAL_TARGET : API_TARGET
  const reasons: SetupReason[] = []
  if (hardware.totalRamBytes < target.minRamBytes) reasons.push('ram-low')
  else if (hardware.totalRamBytes < target.recommendedRamBytes) reasons.push('ram-tight')

  if (engine === 'local') {
    const vram = largestVram(hardware)
    if (vram < LOCAL_TARGET.minVramBytes) reasons.push('vram-low')
    else if (vram < LOCAL_TARGET.recommendedVramBytes) reasons.push('vram-tight')
  }

  const blocked = reasons.some((reason) => reason.endsWith('-low'))
  return {
    verdict: blocked ? 'blocked' : reasons.length > 0 ? 'workable' : 'recommended',
    reasons,
    shortfallBytes: null,
  }
}

/** Model roles each engine runs locally. The detector always ships with the app. */
export function localRolesFor(engine: SetupEngine): readonly ('ocr' | 'ocrMmproj' | 'translator')[] {
  if (engine === 'gemini') return []
  if (engine === 'openai') return ['ocr', 'ocrMmproj']
  return ['ocr', 'ocrMmproj', 'translator']
}
