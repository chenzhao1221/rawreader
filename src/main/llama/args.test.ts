import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import { buildOcrArgs, buildTranslateArgs } from './args'

const config = ConfigSchema.parse({})
const ocrPaths = { ocr: 'C:\\m\\PaddleOCR-VL-1.5.gguf', ocrMmproj: 'C:\\m\\PaddleOCR-VL-1.5-mmproj.gguf' }
const translatePaths = { translator: 'C:\\m\\Index-Translate-2B.Q4_K_M.gguf' }

describe('buildOcrArgs', () => {
  it('reproduces the WorkBuddy OCR launch flags', () => {
    expect(buildOcrArgs(config.llama.ocr, ocrPaths)).toEqual([
      '-m', 'C:\\m\\PaddleOCR-VL-1.5.gguf',
      '--mmproj', 'C:\\m\\PaddleOCR-VL-1.5-mmproj.gguf',
      '--host', '127.0.0.1',
      '--port', '18791',
      '--ctx-size', '4096',
      '-np', '1',
      '-ngl', '99',
      '--alias', 'PaddleOCR-VL-1.5',
    ])
  })

  it('omits --flash-attn for auto and emits it for on/off', () => {
    expect(buildOcrArgs(config.llama.ocr, ocrPaths)).not.toContain('--flash-attn')
    const on = buildOcrArgs({ ...config.llama.ocr, flashAttn: 'on' }, ocrPaths)
    expect(on).toContain('--flash-attn')
    expect(on[on.indexOf('--flash-attn') + 1]).toBe('on')
    const off = buildOcrArgs({ ...config.llama.ocr, flashAttn: 'off' }, ocrPaths)
    expect(off[off.indexOf('--flash-attn') + 1]).toBe('off')
  })

  it('uses the effective port override and appends extra args last', () => {
    const args = buildOcrArgs({ ...config.llama.ocr, extraArgs: ['--threads', '4'] }, ocrPaths, 20001)
    expect(args[args.indexOf('--port') + 1]).toBe('20001')
    expect(args.slice(-2)).toEqual(['--threads', '4'])
  })

  it('always binds to 127.0.0.1', () => {
    const args = buildOcrArgs(config.llama.ocr, ocrPaths)
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1')
  })

  it('rejects --host and --port in extraArgs even if validation was bypassed', () => {
    expect(() => buildOcrArgs({ ...config.llama.ocr, extraArgs: ['--host', '0.0.0.0'] }, ocrPaths)).toThrow(/--host/)
    expect(() => buildOcrArgs({ ...config.llama.ocr, extraArgs: ['--port=1234'] }, ocrPaths)).toThrow(/--port/)
  })
})

describe('buildTranslateArgs', () => {
  it('reproduces the WorkBuddy translation launch flags', () => {
    expect(buildTranslateArgs(config.llama.translate, translatePaths)).toEqual([
      '-m', 'C:\\m\\Index-Translate-2B.Q4_K_M.gguf',
      '--host', '127.0.0.1',
      '--port', '18792',
      '--temp', '0',
      '-ngl', '99',
      '--ctx-size', '8192',
      '-np', '1',
      '--flash-attn', 'on',
      '--reasoning', 'off',
      '--alias', 'Index-Translate-2B',
    ])
  })

  it('omits --flash-attn when set to auto', () => {
    const args = buildTranslateArgs({ ...config.llama.translate, flashAttn: 'auto' }, translatePaths)
    expect(args).not.toContain('--flash-attn')
    expect(args).toContain('--reasoning')
  })

  it('rejects --host and --port in extraArgs', () => {
    expect(() => buildTranslateArgs({ ...config.llama.translate, extraArgs: ['--port', '1'] }, translatePaths)).toThrow()
  })
})
