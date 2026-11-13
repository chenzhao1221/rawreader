import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app, utilityProcess } from 'electron'
import { ConfigSchema } from '../../shared/config/schema'
import { deepMerge } from '../config/merge'
import { isMissingModel, resolveModelPath } from '../config/model-path'
import { loadDevOverlay } from '../config/overlay'
import { createLogger } from '../log/log'
import { runDetectWorkerSmoke } from './detect-worker-smoke'
import { runOverlaySmoke } from './overlay-smoke'
import type { SmokeWorker } from './detect-worker-smoke'
import type { HeadlessSmokeArgs } from './args'

const log = createLogger('headless')

/**
 * Entry of `--headless-smoke=<kind>`. Starts no llama-server and shows no window.
 * - `detect-worker`: no window at all. Forks the built detection worker (`out/main/detect-worker.js`)
 *   and detects bubbles on `fixtures/smoke/panel.png`.
 * - `overlay`: one HIDDEN window (`show: false`) that exercises the real overlay renderer.
 * Writes a JSON report and exits with code 0 (ok) or 1 (failure). Development builds only.
 */
export function runHeadlessSmoke(args: HeadlessSmokeArgs): void {
  const root = app.getAppPath()
  // Keep the smoke away from the real user data folders and from the single-instance lock.
  app.setPath('userData', join(root, '.e2e-out', 'smoke-userData'))
  const outFile = args.outFile
    ? isAbsolute(args.outFile)
      ? args.outFile
      : resolve(root, args.outFile)
    : join(root, '.e2e-out', `${args.kind}-smoke.json`)

  const finish = (code: number, report: Record<string, unknown>): void => {
    try {
      mkdirSync(dirname(outFile), { recursive: true })
      writeFileSync(outFile, JSON.stringify({ ...report, electronPid: process.pid, exitCode: code }, null, 2), 'utf8')
    } catch (error) {
      log.error(`Cannot write the smoke report: ${error instanceof Error ? error.message : String(error)}`)
    }
    app.exit(code)
  }

  app
    .whenReady()
    .then(async () => {
      if (args.kind === 'overlay') {
        const report = await runOverlaySmoke({ root })
        finish(report['ok'] === true ? 0 : 1, report)
        return
      }
      const config = ConfigSchema.parse(deepMerge({}, loadDevOverlay({ rootDir: root, env: {} }).overlay))
      const modelPath = resolveModelPath(
        'detector',
        config,
        { userDataDir: app.getPath('userData'), resourcesDir: join(root, 'resources'), exists: existsSync },
      )
      if (isMissingModel(modelPath)) {
        finish(1, { ok: false, reason: `Detector model not found at ${modelPath.expectedPath}` })
        return
      }
      const workerPath = join(root, 'out', 'main', 'detect-worker.js')
      if (!existsSync(workerPath)) {
        finish(1, { ok: false, reason: `Detect worker is not built: ${workerPath} (run npm run build)` })
        return
      }
      const imageBytes = new Uint8Array(readFileSync(join(root, 'fixtures', 'smoke', 'panel.png')))
      const report = await runDetectWorkerSmoke({
        fork: () => utilityProcess.fork(workerPath, [], { serviceName: 'detector-smoke', stdio: 'ignore' }) as unknown as SmokeWorker,
        modelPath,
        imageBytes,
        logger: log,
        timeoutMs: 120_000,
      })
      finish(report.ok ? 0 : 1, { ...report, modelPath })
    })
    .catch((error: unknown) => {
      finish(1, { ok: false, reason: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    })
}
