import type { Logger } from './log/log'

export interface QuitGuardOptions {
  /** Stops queues and servers and flushes state. Failures are logged, never block quitting. */
  shutdown: () => Promise<void>
  /** Called once shutdown finished (or failed): re-issues `app.quit()`. */
  quit: () => void
  /** Called when shutdown exceeds `timeoutMs`: `app.exit(0)`. */
  forceExit: () => void
  timeoutMs: number
  logger: Logger
}

/** Default hard limit for the whole shutdown sequence. */
export const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Returns a `before-quit` handler. The first call prevents the quit, runs
 * `shutdown()` and then calls `quit()` again; the second `before-quit` passes
 * through. A hard timeout forces the exit if shutdown hangs.
 */
export function createQuitGuard(options: QuitGuardOptions): (event: { preventDefault(): void }) => void {
  let phase: 'idle' | 'running' | 'done' = 'idle'
  return (event) => {
    if (phase === 'done') return
    event.preventDefault()
    if (phase === 'running') return
    phase = 'running'

    const timer = setTimeout(() => {
      if (phase !== 'running') return
      options.logger.error(`Shutdown did not finish within ${options.timeoutMs} ms; forcing exit`)
      phase = 'done'
      options.forceExit()
    }, options.timeoutMs)

    options
      .shutdown()
      .catch((error: unknown) => {
        options.logger.error(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        clearTimeout(timer)
        if (phase !== 'running') return
        phase = 'done'
        options.quit()
      })
  }
}
