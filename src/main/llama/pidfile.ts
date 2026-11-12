import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { z } from 'zod'
import type { ServerRole } from '../../shared/ipc/contract'
import type { ProcessInfo } from './win-process'

export const PidFileSchema = z.object({
  pid: z.number().int().positive(),
  /** ISO-8601 UTC creation time of the process, as reported by `getProcessInfo`. */
  startTime: z.string().min(1),
  exePath: z.string().min(1),
  port: z.number().int().min(1).max(65535),
})
export type PidFile = z.infer<typeof PidFileSchema>

const PID_FILE_PATTERN = /^llama-[a-z]+\.pid\.json$/

export function pidFilePath(runDir: string, role: ServerRole): string {
  return join(runDir, `llama-${role}.pid.json`)
}

export async function writePidFile(runDir: string, role: ServerRole, data: PidFile): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await writeFile(pidFilePath(runDir, role), JSON.stringify(PidFileSchema.parse(data)), 'utf8')
}

export async function deletePidFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** Lists pid files in `runDir`. A missing folder yields an empty list. */
export async function listPidFiles(runDir: string): Promise<string[]> {
  try {
    const names = await readdir(runDir)
    return names.filter((name) => PID_FILE_PATTERN.test(name)).map((name) => join(runDir, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Reads and validates a pid file. Returns null when it is missing or invalid. */
export async function readPidFile(path: string): Promise<PidFile | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = PidFileSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function normalizeExePath(path: string): string {
  return win32.normalize(path).toLowerCase()
}

function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isNaN(ta) || Number.isNaN(tb) ? a === b : ta === tb
}

/**
 * Decides whether the process found for a recorded PID is the one the app
 * spawned earlier. It must be alive, have the same creation time (a reused PID
 * has a different one) and the same executable path. Anything else is not ours
 * and must not be killed.
 */
export function shouldKillOrphan(file: PidFile, info: ProcessInfo | null): boolean {
  if (info === null) return false
  if (info.exePath === null) return false
  if (!sameInstant(info.startTime, file.startTime)) return false
  return normalizeExePath(info.exePath) === normalizeExePath(file.exePath)
}
