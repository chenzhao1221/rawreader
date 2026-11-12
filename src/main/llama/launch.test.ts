import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { buildArgs, launchFingerprint, resolveLaunch } from './launch'

const bin = 'D:\\bin'
const exe = join(bin, 'llama-server.exe')
const files = {
  ocr: 'D:\\m\\ocr.gguf',
  ocrMmproj: 'D:\\m\\mmproj.gguf',
  translator: 'D:\\m\\tr.gguf',
}
const config = ConfigSchema.parse({
  llama: { binDirs: { vulkan: bin } },
  models: { paths: files },
})

function env(existing: string[]) {
  const set = new Set(existing)
  return { userDataDir: 'C:\\data', resourcesDir: 'C:\\res', exists: (p: string) => set.has(p) }
}

describe('resolveLaunch', () => {
  it('resolves both roles when every file exists', () => {
    const all = env([exe, ...Object.values(files)])
    const ocr = resolveLaunch('ocr', config, all)
    const translate = resolveLaunch('translate', config, all)
    expect(ocr.ok && ocr.spec.paths).toEqual({ ocr: files.ocr, ocrMmproj: files.ocrMmproj })
    expect(translate.ok && translate.spec.paths).toEqual({ translator: files.translator })
    expect(ocr.ok && ocr.spec.cwd).toBe(bin)
  })

  it('reports BINARY_MISSING before looking at models', () => {
    const result = resolveLaunch('ocr', config, env(Object.values(files)))
    expect(result).toMatchObject({ ok: false, code: 'BINARY_MISSING' })
  })

  it('reports MODEL_MISSING with the expected path', () => {
    const result = resolveLaunch('translate', config, env([exe]))
    expect(result).toMatchObject({ ok: false, code: 'MODEL_MISSING' })
    expect(!result.ok && result.message).toContain(files.translator)
  })

  it('needs both OCR files', () => {
    const result = resolveLaunch('ocr', config, env([exe, files.ocr]))
    expect(!result.ok && result.message).toContain(files.ocrMmproj)
  })
})

describe('buildArgs', () => {
  it('uses the effective port instead of the configured one', () => {
    const result = resolveLaunch('translate', config, env([exe, ...Object.values(files)]))
    if (!result.ok) throw new Error('expected ok')
    const args = buildArgs(result.spec, 20005)
    expect(args[args.indexOf('--port') + 1]).toBe('20005')
    expect(buildArgs(result.spec)[buildArgs(result.spec).indexOf('--port') + 1]).toBe('18792')
  })
})

describe('launchFingerprint', () => {
  it('changes with launch-relevant settings only', () => {
    const base = launchFingerprint('ocr', config)
    expect(launchFingerprint('ocr', ConfigSchema.parse({ ...config, ui: { autoTranslate: true } }))).toBe(base)
    expect(launchFingerprint('ocr', ConfigSchema.parse({ ...config, llama: { ...config.llama, ocr: { ...config.llama.ocr, autostart: false } } }))).toBe(base)
    expect(launchFingerprint('ocr', ConfigSchema.parse({ ...config, llama: { ...config.llama, ocr: { ...config.llama.ocr, ctxSize: 2048 } } }))).not.toBe(base)
    expect(launchFingerprint('ocr', ConfigSchema.parse({ ...config, llama: { ...config.llama, backend: 'cuda' } }))).not.toBe(base)
  })

  it('keeps roles independent', () => {
    const changed = ConfigSchema.parse({ ...config, llama: { ...config.llama, translate: { ...config.llama.translate, ctxSize: 4096 } } })
    expect(launchFingerprint('ocr', changed)).toBe(launchFingerprint('ocr', config))
    expect(launchFingerprint('translate', changed)).not.toBe(launchFingerprint('translate', config))
  })
})
