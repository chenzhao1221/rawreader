import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { dirname } from 'node:path'
import type { GpuInfo, HardwareInfo } from '../../shared/ipc/contract'

/**
 * Reads the GPU names and their dedicated memory. `AdapterRAM` stops at 4 GB, so the registry
 * value (`HardwareInformation.qwMemorySize`, 64-bit) is preferred when the driver writes it.
 */
const GPU_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$keys = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*'",
  '$result = foreach ($a in (Get-CimInstance Win32_VideoController)) {',
  "  $key = $keys | Where-Object { $_.DriverDesc -eq $a.Name } | Select-Object -First 1",
  '  $vram = 0',
  "  if ($key -and $key.'HardwareInformation.qwMemorySize') { $vram = [int64]$key.'HardwareInformation.qwMemorySize' }",
  '  elseif ($a.AdapterRAM -gt 0) { $vram = [int64]$a.AdapterRAM }',
  '  [pscustomobject]@{ name = $a.Name; vramBytes = $vram }',
  '}',
  'ConvertTo-Json -InputObject @($result) -Compress',
].join('\n')

export interface HardwareSources {
  cpuThreads(): number
  totalRamBytes(): number
  /** Free bytes on the volume holding `path`; null when it cannot be read. */
  freeDiskBytes(path: string): Promise<number | null>
  gpus(): Promise<GpuInfo[]>
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

/** Tolerates a single object, an array, an empty result, and the BOM PowerShell may prepend. */
export function parseGpuJson(raw: string): GpuInfo[] {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (text === '') return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(data) ? data : [data]
  const gpus: GpuInfo[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const { name, vramBytes } = row as { name?: unknown; vramBytes?: unknown }
    if (typeof name !== 'string' || name.trim() === '') continue
    gpus.push({
      name: name.trim().slice(0, 200),
      vramBytes: typeof vramBytes === 'number' && Number.isFinite(vramBytes) && vramBytes > 0 ? vramBytes : null,
    })
  }
  return gpus
}

/** Walks up from `path` until a folder exists, so a missing models folder still yields a number. */
export async function freeDiskBytesOn(path: string): Promise<number | null> {
  let dir = path
  for (let depth = 0; depth < 8; depth++) {
    try {
      const stats = await statfs(dir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
  return null
}

async function gpus(): Promise<GpuInfo[]> {
  if (process.platform !== 'win32') return []
  try {
    return parseGpuJson(await runPowerShell(GPU_SCRIPT))
  } catch {
    return []
  }
}

export function systemSources(): HardwareSources {
  return {
    cpuThreads: () => cpus().length,
    totalRamBytes: () => totalmem(),
    freeDiskBytes: freeDiskBytesOn,
    gpus,
  }
}

export async function readHardware(diskPath: string, sources: HardwareSources = systemSources()): Promise<HardwareInfo> {
  const [free, adapters] = await Promise.all([sources.freeDiskBytes(diskPath), sources.gpus()])
  // The card that matters first, virtual display adapters (they report no memory) last.
  const gpus = [...adapters].sort((a, b) => (b.vramBytes ?? -1) - (a.vramBytes ?? -1))
  return {
    cpuThreads: sources.cpuThreads(),
    totalRamBytes: sources.totalRamBytes(),
    freeDiskBytes: free,
    gpus,
  }
}

/** Caches the first result: hardware does not change while the app runs. */
export function createHardwareProbe(diskPath: () => string, sources?: HardwareSources): { get(): Promise<HardwareInfo> } {
  let cached: Promise<HardwareInfo> | null = null
  return {
    get: () => {
      cached ??= readHardware(diskPath(), sources)
      return cached
    },
  }
}
