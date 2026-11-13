import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../ipc/contract'
import { API_TARGET, LOCAL_TARGET, largestVram, localRolesFor, planEngine } from './plan'

const GB = 1024 ** 3

function hardware(partial: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    cpuThreads: 16,
    totalRamBytes: 32 * GB,
    freeDiskBytes: 200 * GB,
    gpus: [{ name: 'Test GPU', vramBytes: 8 * GB }],
    ...partial,
  }
}

describe('planEngine', () => {
  it('recommends local models on a 16 GB / 8 GB VRAM machine', () => {
    expect(planEngine('local', hardware(), 3.1 * GB)).toEqual({ verdict: 'recommended', reasons: [], shortfallBytes: null })
  })

  it('marks local as workable when RAM or VRAM is only at the minimum', () => {
    const plan = planEngine('local', hardware({ totalRamBytes: 8 * GB, gpus: [{ name: 'g', vramBytes: 4 * GB }] }), 3.1 * GB)
    expect(plan.verdict).toBe('workable')
    expect(plan.reasons).toEqual(['ram-tight', 'vram-tight'])
  })

  it('blocks local without a dedicated GPU', () => {
    const plan = planEngine('local', hardware({ gpus: [{ name: 'iGPU', vramBytes: null }] }), 3.1 * GB)
    expect(plan.verdict).toBe('blocked')
    expect(plan.reasons).toContain('vram-low')
  })

  it('blocks local when RAM is below the minimum', () => {
    const plan = planEngine('local', hardware({ totalRamBytes: 4 * GB }), 3.1 * GB)
    expect(plan.verdict).toBe('blocked')
    expect(plan.reasons).toContain('ram-low')
  })

  it('needs less memory for an API translator', () => {
    const low = hardware({ totalRamBytes: API_TARGET.minRamBytes, gpus: [{ name: 'iGPU', vramBytes: null }] })
    expect(planEngine('openai', low, 1.8 * GB).verdict).toBe('workable')
    expect(planEngine('local', low, 3.1 * GB).verdict).toBe('blocked')
  })

  it('always recommends Gemini, which downloads nothing', () => {
    const weak = hardware({ totalRamBytes: 4 * GB, gpus: [], freeDiskBytes: 1 * GB })
    expect(planEngine('gemini', weak, 0)).toEqual({ verdict: 'recommended', reasons: [], shortfallBytes: null })
  })

  it('blocks every engine when the disk is too small and reports the shortfall', () => {
    const plan = planEngine('local', hardware({ freeDiskBytes: 1 * GB }), 3.1 * GB)
    expect(plan.verdict).toBe('blocked')
    expect(plan.reasons).toEqual(['disk-short'])
    expect(plan.shortfallBytes).toBeCloseTo(2.1 * GB, 0)
  })

  it('ignores the disk when its size is unknown', () => {
    expect(planEngine('local', hardware({ freeDiskBytes: null }), 3.1 * GB).verdict).toBe('recommended')
  })
})

describe('largestVram', () => {
  it('uses the biggest adapter and treats unknown memory as zero', () => {
    expect(
      largestVram(
        hardware({
          gpus: [
            { name: 'iGPU', vramBytes: null },
            { name: 'dGPU', vramBytes: 6 * GB },
          ],
        }),
      ),
    ).toBe(6 * GB)
    expect(largestVram(hardware({ gpus: [] }))).toBe(0)
  })
})

describe('localRolesFor', () => {
  it('lists what each engine runs locally', () => {
    expect(localRolesFor('local')).toEqual(['ocr', 'ocrMmproj', 'translator'])
    expect(localRolesFor('openai')).toEqual(['ocr', 'ocrMmproj'])
    expect(localRolesFor('gemini')).toEqual([])
  })

  it('keeps the local requirement above the API requirement', () => {
    expect(LOCAL_TARGET.minVramBytes).toBeGreaterThan(0)
    expect(LOCAL_TARGET.recommendedRamBytes).toBeGreaterThanOrEqual(API_TARGET.recommendedRamBytes)
  })
})
