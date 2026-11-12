import { describe, expect, it } from 'vitest'
import { CRASH_WINDOW_MS, decideRestart } from './restart-policy'

describe('decideRestart', () => {
  it('backs off 2 s, 5 s, 15 s for the first three crashes', () => {
    let crashes: number[] = []
    const delays: number[] = []
    for (let i = 0; i < 3; i++) {
      const decision = decideRestart(crashes, 1_000 + i * 1_000)
      expect(decision.restart).toBe(true)
      if (decision.restart) delays.push(decision.delayMs)
      crashes = decision.crashes
    }
    expect(delays).toEqual([2_000, 5_000, 15_000])
  })

  it('gives up on the fourth crash inside five minutes', () => {
    const decision = decideRestart([1_000, 2_000, 3_000], 4_000)
    expect(decision.restart).toBe(false)
    expect(decision.crashes).toHaveLength(4)
  })

  it('forgets crashes older than the window', () => {
    const decision = decideRestart([0, 1_000, 2_000], CRASH_WINDOW_MS + 5_000)
    expect(decision).toEqual({ restart: true, delayMs: 2_000, crashes: [CRASH_WINDOW_MS + 5_000] })
  })

  it('keeps counting crashes just inside the window', () => {
    const decision = decideRestart([1, 2, 3], CRASH_WINDOW_MS)
    expect(decision.restart).toBe(false)
  })
})
