import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { killTree } from '../llama/win-process'

const root = join(import.meta.dirname, '../../..')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

export interface ElectronSmokeRun<R> {
  code: number | null
  pid: number
  output: string
  report: R
  reportPath: string
}

/**
 * Test helper: launches the built app with `--headless-smoke=<kind>` (no window, or one hidden window for
 * `overlay`), waits for it to exit and returns the JSON report. Kills the process tree by PID on timeout.
 */
export function runElectronSmoke<R>(kind: string, timeoutMs = 150_000): Promise<ElectronSmokeRun<R>> {
  const reportPath = join(root, '.e2e-out', `${kind}-smoke.json`)
  rmSync(reportPath, { force: true })
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    const child = spawn(electronExe, ['.', `--headless-smoke=${kind}`], {
      cwd: root,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pid = child.pid
    if (pid === undefined) {
      reject(new Error('electron did not start'))
      return
    }
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const timer = setTimeout(() => {
      output += '\n[harness] timeout; killing the process tree\n'
      void killTree(pid)
    }, timeoutMs)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!existsSync(reportPath)) {
        reject(new Error(`No report was written (exit code ${code}).\n${output}`))
        return
      }
      resolve({ code, pid, output, report: JSON.parse(readFileSync(reportPath, 'utf8')) as R, reportPath })
    })
  })
}