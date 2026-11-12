import { spawn } from 'node:child_process'

/**
 * Windows process helpers. The app only ever signals a PID it spawned and
 * recorded itself. Image-name based kills are forbidden everywhere (a test
 * greps src/ for the switch), because they would hit other users' processes.
 */

export interface ProcessInfo {
  /** Full path of the executable, or null when Windows does not expose it. */
  exePath: string | null
  /** Creation time as an ISO-8601 UTC string. */
  startTime: string
}

/** Throws unless `pid` is a positive safe integer. Called before every use of a PID. */
export function assertPid(pid: unknown): asserts pid is number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Invalid PID: expected a positive integer')
  }
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** taskkill exit code when the PID does not exist. */
const TASKKILL_NOT_FOUND = 128

/**
 * Kills `pid` and its whole process tree with `taskkill /PID <pid> /T /F`.
 * A PID that no longer exists counts as success. Refuses PIDs 1 to 4 and the
 * app's own PID.
 */
export async function killTree(pid: number): Promise<void> {
  assertPid(pid)
  if (pid <= 4 || pid === process.pid) throw new Error('Refusing to kill a protected PID')
  const result = await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], 15_000)
  if (result.code !== 0 && result.code !== TASKKILL_NOT_FOUND) {
    throw new Error(`taskkill failed for PID ${pid} (exit ${result.code}): ${result.stderr.trim()}`)
  }
}

/** Parses the JSON printed by the CIM query in `getProcessInfo`. Pure; exported for tests. */
export function parseProcessInfo(stdout: string): ProcessInfo | null {
  const text = stdout.trim()
  if (text === '') return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record['Start'] !== 'string' || record['Start'] === '') return null
  const exe = record['ExecutablePath']
  return { exePath: typeof exe === 'string' && exe !== '' ? exe : null, startTime: record['Start'] }
}

/**
 * Looks up a live process by PID through CIM. Returns null when no such
 * process exists. The PID is the only interpolated value and is validated first.
 */
export async function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  assertPid(pid)
  const script =
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ` +
    `Select-Object ProcessId,ExecutablePath,@{n='Start';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ` +
    'ConvertTo-Json -Compress'
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 20_000)
  if (result.code !== 0) throw new Error(`Process query failed for PID ${pid}: ${result.stderr.trim()}`)
  return parseProcessInfo(result.stdout)
}
