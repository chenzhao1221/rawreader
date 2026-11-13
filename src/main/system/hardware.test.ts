import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freeDiskBytesOn, parseGpuJson, readHardware } from './hardware'
import type { HardwareSources } from './hardware'

describe('parseGpuJson', () => {
  it('reads a list, a single object and the PowerShell BOM', () => {
    expect(parseGpuJson('\uFEFF[{"name":"A","vramBytes":8},{"name":"B","vramBytes":null}]')).toEqual([
      { name: 'A', vramBytes: 8 },
      { name: 'B', vramBytes: null },
    ])
    expect(parseGpuJson('{"name":"A","vramBytes":0}')).toEqual([{ name: 'A', vramBytes: null }])
  })

  it('returns nothing for empty or broken output', () => {
    expect(parseGpuJson('')).toEqual([])
    expect(parseGpuJson('not json')).toEqual([])
    expect(parseGpuJson('null')).toEqual([])
    expect(parseGpuJson('[{"vramBytes":4},{"name":"  "}]')).toEqual([])
  })

  it('drops non-numeric or negative memory', () => {
    expect(parseGpuJson('[{"name":"A","vramBytes":"8"},{"name":"B","vramBytes":-1}]')).toEqual([
      { name: 'A', vramBytes: null },
      { name: 'B', vramBytes: null },
    ])
  })
})

describe('readHardware', () => {
  it('combines the sources and tolerates an unreadable disk', async () => {
    const sources: HardwareSources = {
      cpuThreads: () => 16,
      totalRamBytes: () => 32,
      freeDiskBytes: async () => null,
      gpus: async () => [{ name: 'GPU', vramBytes: 6 }],
    }
    await expect(readHardware('C:\\models', sources)).resolves.toEqual({
      cpuThreads: 16,
      totalRamBytes: 32,
      freeDiskBytes: null,
      gpus: [{ name: 'GPU', vramBytes: 6 }],
    })
  })
})

describe('freeDiskBytesOn', () => {
  it('falls back to an existing parent folder', async () => {
    const missing = join(tmpdir(), 'rawreader-does-not-exist', 'models')
    const bytes = await freeDiskBytesOn(missing)
    expect(bytes === null || bytes > 0).toBe(true)
  })
})
