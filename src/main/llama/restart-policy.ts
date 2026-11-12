/** Crashes older than this no longer count toward the restart limit. */
export const CRASH_WINDOW_MS = 5 * 60 * 1000

/** Maximum automatic restarts inside the window. The next crash ends in `CRASH_LOOP`. */
export const MAX_RESTARTS = 3

/** Delay before restart attempt 1, 2 and 3. */
export const BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000]

export type RestartDecision =
  | { restart: true; delayMs: number; crashes: number[] }
  | { restart: false; crashes: number[] }

/**
 * Decides what to do after an unexpected exit at time `now`.
 * `previousCrashes` are timestamps of earlier unexpected exits. At most
 * `MAX_RESTARTS` restarts happen per `CRASH_WINDOW_MS`.
 */
export function decideRestart(previousCrashes: readonly number[], now: number): RestartDecision {
  const crashes = [...previousCrashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
  if (crashes.length > MAX_RESTARTS) return { restart: false, crashes }
  const delayMs = BACKOFF_MS[crashes.length - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 15_000
  return { restart: true, delayMs, crashes }
}
