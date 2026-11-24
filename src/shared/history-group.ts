/** Day buckets of the history list. Shared by main (tests) and the shell UI; no Electron or Node APIs. */

export type HistoryGroupName = 'today' | 'yesterday' | 'earlier'

/** Day bucket of a visit, in the local time zone. */
export function historyGroup(at: number, now: number): HistoryGroupName {
  const startOfDay = (t: number): number => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const today = startOfDay(now)
  if (at >= today) return 'today'
  if (at >= startOfDay(today - 1)) return 'yesterday'
  return 'earlier'
}
