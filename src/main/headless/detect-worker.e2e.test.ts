import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getProcessInfo } from '../llama/win-process'
import { runElectronSmoke } from './electron-runner'

/**
 * Headless Electron smoke of the detection utility process. Launches the built app with
 * `--headless-smoke=detect-worker`: no window, no llama-server. Needs `out/` (npm run build).
 *
 *   npm run smoke:detect-worker
 *
 * Report: `.e2e-out/detect-worker-smoke.json` (git-ignored).
 */
interface Report {
  ok: boolean
  reason: string | null
  electronPid: number
  workerPid: number | null
  workerExited: boolean
  unitCount: number
  bubbleOnlyCount: number
  exitCode: number
}

describe('headless Electron detect-worker smoke', () => {
  it('forks the built worker, detects bubbles on the SFW panel and leaves no process behind', async () => {
    expect(existsSync(join(import.meta.dirname, '../../../out/main/detect-worker.js')), 'run npm run build first').toBe(true)
    const run = await runElectronSmoke<Report>('detect-worker')
    console.log(run.output.trim())
    console.log(JSON.stringify(run.report, null, 2))

    expect(run.report.reason).toBeNull()
    expect(run.report.ok).toBe(true)
    expect(run.code).toBe(0)
    // The panel has three bubbles.
    expect(run.report.unitCount).toBeGreaterThanOrEqual(3)
    expect(run.report.workerExited).toBe(true)

    // Nothing started by the run may survive.
    expect(await getProcessInfo(run.pid)).toBeNull()
    if (run.report.workerPid !== null) expect(await getProcessInfo(run.report.workerPid)).toBeNull()
  }, 200_000)
})