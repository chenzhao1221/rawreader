import { describe, expect, it } from 'vitest'
import { hasHeadlessSmokeFlag, parseHeadlessSmokeArgs } from './args'

describe('parseHeadlessSmokeArgs', () => {
  it('returns null without the flag', () => {
    expect(parseHeadlessSmokeArgs(['electron.exe', '.'])).toBeNull()
  })

  it('parses the detect-worker kind and an output file', () => {
    expect(parseHeadlessSmokeArgs(['electron.exe', '.', '--headless-smoke=detect-worker'])).toEqual({
      kind: 'detect-worker',
      outFile: null,
    })
    expect(parseHeadlessSmokeArgs(['x', '--headless-smoke=detect-worker', '--smoke-out=C:\\tmp\\r.json'])).toEqual({
      kind: 'detect-worker',
      outFile: 'C:\\tmp\\r.json',
    })
  })

  it('rejects unknown kinds but still reports the flag as present', () => {
    expect(parseHeadlessSmokeArgs(['x', '--headless-smoke=other'])).toBeNull()
    expect(hasHeadlessSmokeFlag(['x', '--headless-smoke=other'])).toBe(true)
    expect(hasHeadlessSmokeFlag(['x'])).toBe(false)
  })
})
