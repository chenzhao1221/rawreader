import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CudaStatus } from '../../shared/ipc/contract'
import type { Logger } from '../log/log'
import { DownloadError, downloadFile } from './download'
import type { FetchLike } from './download'

/** The only llama.cpp build with pinned CUDA assets. Other builds are refused, not guessed. */
export const CUDA_BUILD = 'b12318'

export interface CudaAsset {
  fileName: string
  url: string
  size: number
  sha256: string
}

/**
 * Official release assets. Size and sha256 come from the GitHub release API (`assets[].digest`) and were
 * confirmed with a HEAD request on 2026-05 (HTTP 200, same Content-Length). The CUDA runtime zip holds the
 * cudart/cublas DLLs the server needs on machines without a CUDA toolkit.
 */
export const CUDA_ASSETS: readonly CudaAsset[] = [
  {
    fileName: 'llama-b12318-bin-win-cuda-12.4-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12318/llama-b12318-bin-win-cuda-12.4-x64.zip',
    size: 317_258_181,
    sha256: '20281408c618dcd13080bc0b3deed250c413bbe6541421a1c989acf5a376e684',
  },
  {
    fileName: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12318/cudart-llama-bin-win-cuda-12.4-x64.zip',
    size: 391_443_627,
    sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
  },
]

export const SERVER_EXE = 'llama-server.exe'

export type CudaErrorCode =
  | 'UNSUPPORTED_BUILD'
  | 'UNREACHABLE'
  | 'ASSET_MISSING'
  | 'ASSET_CHANGED'
  | 'DOWNLOAD_FAILED'
  | 'EXTRACT_FAILED'
  | 'SERVER_MISSING'
  | 'CANCELLED'

export class CudaError extends Error {
  constructor(
    readonly code: CudaErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CudaError'
  }
}

/**
 * HEAD-verifies the release assets before the large download starts: each must answer 200 and, when the server
 * states a length, match the pinned size. An unreachable host is reported as `UNREACHABLE` (usually a proxy issue).
 */
export async function verifyAssetUrls(
  assets: readonly CudaAsset[],
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<void> {
  for (const asset of assets) {
    let response: Response
    try {
      response = await fetchFn(asset.url, { headers: {}, signal, method: 'HEAD' })
    } catch (error) {
      if (signal.aborted) throw new CudaError('CANCELLED', 'Cancelled')
      throw new CudaError('UNREACHABLE', `Cannot reach ${new URL(asset.url).host}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await response.body?.cancel().catch(() => {})
    if (response.status === 404) throw new CudaError('ASSET_MISSING', `${asset.fileName} was not found (HTTP 404)`)
    if (response.status !== 200) throw new CudaError('UNREACHABLE', `${asset.fileName}: HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > 0 && length !== asset.size) {
      throw new CudaError('ASSET_CHANGED', `${asset.fileName}: expected ${asset.size} bytes, server reports ${length}`)
    }
  }
}

/** `tar.exe` from Windows (bsdtar, reads zip). */
export function tarPath(systemRoot: string | undefined = process.env['SystemRoot']): string {
  return systemRoot ? join(systemRoot, 'System32', 'tar.exe') : 'tar.exe'
}

/** `tar.exe -xf <zip> -C <dir>`, spawned with an argument array and no shell. */
export function extractZip(zipPath: string, destDir: string, tar: string = tarPath()): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xf', zipPath, '-C', destDir], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    child.on('error', (error) => reject(new CudaError('EXTRACT_FAILED', `Cannot run tar.exe: ${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new CudaError('EXTRACT_FAILED', `tar.exe exited with code ${code}: ${stderr.trim()}`))
    })
  })
}

/** Finds the folder that holds llama-server.exe: the extraction root, or one folder below it. */
export async function findServerDir(root: string): Promise<string | null> {
  if (existsSync(join(root, SERVER_EXE))) return root
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(root, entry.name, SERVER_EXE))) return join(root, entry.name)
  }
  return null
}

export interface CudaInstallerOptions {
  /** `userData/llama/cuda-<build>` or the configured override. */
  getTargetDir: () => string
  /** Scratch folder for the zips (`userData/llama/downloads`). */
  getDownloadDir: () => string
  getBuild: () => string
  fetch: FetchLike
  /** Switches the backend to `cuda` once the build is in place. */
  onInstalled: () => void
  onChange: (status: CudaStatus) => void
  extract?: (zipPath: string, destDir: string) => Promise<void>
  assets?: readonly CudaAsset[]
  logger: Logger
  attemptsPerSource?: number
  retryDelayMs?: (retry: number) => number
}

/**
 * Downloads the CUDA llama.cpp build on demand (R12.2): HEAD check, two resumable downloads with sha256,
 * extraction into a staging folder, a `llama-server.exe` check, then an atomic rename into place and a
 * backend switch. Any failure leaves the current backend untouched. Needs the network (GitHub), which in
 * China usually means a proxy; `net.fetch` honours the system proxy.
 */
export class CudaInstaller {
  private status: CudaStatus
  private controller: AbortController | null = null
  private running: Promise<void> | null = null

  constructor(private readonly options: CudaInstallerOptions) {
    this.status = this.idleStatus()
  }

  private assets(): readonly CudaAsset[] {
    return this.options.assets ?? CUDA_ASSETS
  }

  private idleStatus(): CudaStatus {
    const dir = this.options.getTargetDir()
    const installed = existsSync(join(dir, SERVER_EXE))
    return {
      state: installed ? 'ready' : 'absent',
      installed,
      receivedBytes: 0,
      totalBytes: this.assets().reduce((sum, a) => sum + a.size, 0),
      errorCode: null,
      message: null,
      dir,
    }
  }

  getStatus(): CudaStatus {
    if (this.running) return { ...this.status }
    // Re-read the disk when idle: the user may have installed or deleted the folder by hand.
    const idle = this.idleStatus()
    if (this.status.state === 'error' && !idle.installed) return { ...this.status, dir: idle.dir }
    return idle
  }

  isRunning(): boolean {
    return this.running !== null
  }

  /** Starts the install. Returns immediately; progress goes through `onChange`. */
  start(): CudaStatus {
    if (this.running) return this.getStatus()
    this.controller = new AbortController()
    this.running = this.run(this.controller.signal)
      .catch((error: unknown) => {
        const failure =
          error instanceof CudaError
            ? error
            : new CudaError('DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error))
        this.options.logger.error(`CUDA install failed: ${failure.code} ${failure.message}`)
        this.set({ state: failure.code === 'CANCELLED' ? 'absent' : 'error', errorCode: failure.code, message: failure.message })
      })
      .finally(() => {
        this.running = null
        this.controller = null
        this.options.onChange(this.getStatus())
      })
    return this.getStatus()
  }

  /** Stops the download. Partial zips stay so a later start resumes them. */
  cancel(): CudaStatus {
    this.controller?.abort()
    return this.getStatus()
  }

  /** Resolves when the running install (if any) has finished. Used by tests and shutdown. */
  async whenDone(): Promise<void> {
    await this.running
  }

  private set(patch: Partial<CudaStatus>): void {
    this.status = { ...this.status, ...patch }
    this.options.onChange({ ...this.status })
  }

  private async run(signal: AbortSignal): Promise<void> {
    const build = this.options.getBuild()
    if (build !== CUDA_BUILD) {
      throw new CudaError('UNSUPPORTED_BUILD', `CUDA assets are pinned for ${CUDA_BUILD}, not ${build}`)
    }
    const assets = this.assets()
    const total = assets.reduce((sum, a) => sum + a.size, 0)
    const targetDir = this.options.getTargetDir()
    const downloadDir = this.options.getDownloadDir()
    this.status = { ...this.idleStatus(), state: 'checking', totalBytes: total }
    this.set({})

    await verifyAssetUrls(assets, this.options.fetch, signal)

    const done = new Map<string, number>()
    this.set({ state: 'downloading', receivedBytes: 0 })
    const zips: string[] = []
    for (const asset of assets) {
      const destPath = join(downloadDir, asset.fileName)
      try {
        await downloadFile({
          spec: asset,
          sources: [{ source: 'github', url: asset.url }],
          destPath,
          fetch: this.options.fetch,
          signal,
          ...(this.options.attemptsPerSource !== undefined ? { attemptsPerSource: this.options.attemptsPerSource } : {}),
          ...(this.options.retryDelayMs ? { retryDelayMs: this.options.retryDelayMs } : {}),
          onProgress: (received) => {
            done.set(asset.fileName, received)
            this.status = { ...this.status, receivedBytes: [...done.values()].reduce((a, b) => a + b, 0) }
            this.options.onChange({ ...this.status })
          },
        })
      } catch (error) {
        if (error instanceof DownloadError && error.code === 'ABORTED') throw new CudaError('CANCELLED', 'Cancelled')
        throw new CudaError('DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error))
      }
      done.set(asset.fileName, asset.size)
      zips.push(destPath)
    }

    this.set({ state: 'extracting', receivedBytes: total })
    const staging = `${targetDir}.staging`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    const extract = this.options.extract ?? ((zip: string, dest: string) => extractZip(zip, dest))
    try {
      for (const zip of zips) await extract(zip, staging)
      const serverDir = await findServerDir(staging)
      if (!serverDir) throw new CudaError('SERVER_MISSING', `${SERVER_EXE} was not found after extraction`)
      await rm(targetDir, { recursive: true, force: true })
      await mkdir(join(targetDir, '..'), { recursive: true })
      await rename(serverDir, targetDir)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error instanceof CudaError ? error : new CudaError('EXTRACT_FAILED', error instanceof Error ? error.message : String(error))
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    for (const zip of zips) await rm(zip, { force: true }).catch(() => {})

    this.options.logger.info(`CUDA build installed in ${targetDir}`)
    this.set({ state: 'ready', installed: true, errorCode: null, message: null })
    this.options.onInstalled()
  }
}
