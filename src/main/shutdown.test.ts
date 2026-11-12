import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { silentLogger } from './log/log'
import { createQuitGuard } from './shutdown'

describe('createQuitGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(shutdown: () => Promise<void>) {
    const quit = vi.fn()
    const forceExit = vi.fn()
    const guard = createQuitGuard({ shutdown, quit, forceExit, timeoutMs: 10_000, logger: silentLogger })
    return { guard, quit, forceExit }
  }

  it('prevents the first quit, shuts down, quits again and lets the second pass', async () => {
    const shutdown = vi.fn(() => Promise.resolve())
    const { guard, quit, forceExit } = setup(shutdown)

    const first = { preventDefault: vi.fn() }
    guard(first)
    expect(first.preventDefault).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)

    const second = { preventDefault: vi.fn() }
    guard(second)
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(forceExit).not.toHaveBeenCalled()
  })

  it('runs shutdown only once when quit is requested repeatedly while it runs', async () => {
    let finish: () => void = () => {}
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const { guard, quit } = setup(shutdown)

    const a = { preventDefault: vi.fn() }
    const b = { preventDefault: vi.fn() }
    guard(a)
    guard(b)
    expect(a.preventDefault).toHaveBeenCalled()
    expect(b.preventDefault).toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()

    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('still quits when shutdown fails', async () => {
    const { guard, quit } = setup(() => Promise.reject(new Error('boom')))
    guard({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('never forces the exit (exit code stays 0) when shutdown finishes before the timeout', async () => {
    const { guard, quit, forceExit } = setup(() => new Promise<void>((resolve) => setTimeout(resolve, 4_000)))
    guard({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(quit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(forceExit).not.toHaveBeenCalled()
  })

  it('forces the exit after the hard timeout and does not quit afterwards', async () => {
    let finish: () => void = () => {}
    const { guard, quit, forceExit } = setup(() => new Promise<void>((resolve) => (finish = resolve)))
    guard({ preventDefault: vi.fn() })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(forceExit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(forceExit).toHaveBeenCalledTimes(1)

    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).not.toHaveBeenCalled()
  })
})
