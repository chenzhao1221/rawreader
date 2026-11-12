import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { resolveBinDir, resolveServerExe } from './backend'

const userDataDir = join('C:', 'data')
const resourcesDir = join('C:', 'res')

function env(existing: string[] = []) {
  const set = new Set(existing)
  return { userDataDir, resourcesDir, exists: (p: string) => set.has(p) }
}

describe('resolveBinDir', () => {
  it('uses the bundled folder for vulkan by default', () => {
    expect(resolveBinDir(ConfigSchema.parse({}).llama, env())).toBe(join(resourcesDir, 'llama', 'vulkan'))
  })

  it('prefers a configured vulkan folder', () => {
    const llama = ConfigSchema.parse({ llama: { binDirs: { vulkan: 'D:\\bin' } } }).llama
    expect(resolveBinDir(llama, env())).toBe('D:\\bin')
  })

  it('uses userData/llama/cuda-<build> for cuda by default', () => {
    const llama = ConfigSchema.parse({ llama: { backend: 'cuda' } }).llama
    expect(resolveBinDir(llama, env())).toBe(join(userDataDir, 'llama', 'cuda-b12318'))
  })

  it('requires a folder for custom', () => {
    expect(resolveBinDir(ConfigSchema.parse({ llama: { backend: 'custom' } }).llama, env())).toBeNull()
    const llama = ConfigSchema.parse({ llama: { backend: 'custom', binDirs: { custom: 'E:\\llama' } } }).llama
    expect(resolveBinDir(llama, env())).toBe('E:\\llama')
  })
})

describe('resolveServerExe', () => {
  it('returns the executable when it exists', () => {
    const llama = ConfigSchema.parse({ llama: { binDirs: { vulkan: 'D:\\bin' } } }).llama
    const exe = join('D:\\bin', 'llama-server.exe')
    expect(resolveServerExe(llama, env([exe]))).toEqual({ ok: true, binDir: 'D:\\bin', exePath: exe })
  })

  it('reports BINARY_MISSING with the expected path', () => {
    const llama = ConfigSchema.parse({ llama: { binDirs: { vulkan: 'D:\\bin' } } }).llama
    const result = resolveServerExe(llama, env())
    expect(result).toMatchObject({ ok: false, code: 'BINARY_MISSING', expectedPath: join('D:\\bin', 'llama-server.exe') })
  })

  it('reports BINARY_MISSING for custom without a folder', () => {
    const llama = ConfigSchema.parse({ llama: { backend: 'custom' } }).llama
    expect(resolveServerExe(llama, env())).toMatchObject({ ok: false, code: 'BINARY_MISSING', expectedPath: null })
  })
})
