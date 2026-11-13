// Runs a headless Electron smoke without any manual step.
//
//   npm run smoke:detect-worker     forks the detection worker; no window at all
//   npm run smoke:overlay           drives the overlay renderer in a HIDDEN window (show: false)
//
// Neither smoke starts a llama-server. Each npm script builds first. This script runs the vitest wrapper with
// RAWREADER_E2E=1; the wrapper launches `electron . --headless-smoke=<kind>` and checks the JSON report in
// .e2e-out/<kind>-smoke.json and that no process is left behind.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const kinds = { 'detect-worker': 'src/main/headless/detect-worker.e2e.test.ts', overlay: 'src/main/headless/overlay.e2e.test.ts' }
const kind = process.argv[2] ?? 'detect-worker'
const testFile = kinds[kind]
if (!testFile) {
  console.error(`Unknown smoke "${kind}". Use one of: ${Object.keys(kinds).join(', ')}`)
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vitestEntry = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const result = spawnSync(process.execPath, [vitestEntry, 'run', testFile], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, RAWREADER_E2E: '1' },
})
process.exit(result.status ?? 1)