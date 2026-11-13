import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CudaStatus } from '../../shared/ipc/contract'
import { silentLogger } from '../log/log'
import { sha256Of, startTestServer } from './__fixtures__/http-server'
import type { TestServer } from './__fixtures__/http-server'
import { makeZip } from './__fixtures__/zip'
import { CUDA_ASSETS, CUDA_BUILD, CudaInstaller, findServerDir, tarPath, verifyAssetUrls } from './cuda'
import type { CudaAsset } from './cuda'

const exeBytes = new TextEncoder().encode('fake llama-server')
const dllBytes = new TextEncoder().encode('fake cudart')
const mainZip = makeZip([
  { name: 'llama-server.exe', data: exeBytes },
  { name: 'ggml-cuda.dll', data: new TextEncoder().encode('fake cuda backend') },
])
const runtimeZip = makeZip([{ name: 'cudart64_12.dll', data: dllBytes }])

describe('CUDA assets', () => {
  it('pin the two official b12318 CUDA 12.4 zips with sha256 and size', () => {
    expect(CUDA_BUILD).toBe('b12318')
    expect(CUDA_ASSETS.map((a) => a.fileName)).toEqual(['llama-b12318-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'])
    for (const a of CUDA_ASSETS) {
      expect(a.url.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/b12318/')).toBe(true)
      expect(a.url.endsWith(a.fileName)).toBe(true)
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('builds the tar.exe path from SystemRoot', () => {
    expect(tarPath('C:\\Windows')).toBe(join('C:\\Windows', 'System32', 'tar.exe'))
    expect(tarPath(undefined)).toBe(process.env['SystemRoot'] ? tarPath(process.env['SystemRoot']) : 'tar.exe')
  })
})

describe('CUDA installer (local HTTP server, tiny zips only)', () => {
  let server: TestServer
  let dir: string
  let assets: CudaAsset[]
  let statuses: CudaStatus[]
  let installed: ReturnType<typeof vi.fn<() => void>>

  beforeAll(async () => {
    server = await startTestServer()
    server.route('/main.zip', mainZip)
    server.route('/runtime.zip', runtimeZip)
  })
  afterAll(async () => {
    await server.close()
  })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-cuda-'))
    statuses = []
    installed = vi.fn<() => void>()
    server.requests.length = 0
    assets = [
      { fileName: 'main.zip', url: `${server.baseUrl}/main.zip`, size: mainZip.byteLength, sha256: sha256Of(mainZip) },
      { fileName: 'runtime.zip', url: `${server.baseUrl}/runtime.zip`, size: runtimeZip.byteLength, sha256: sha256Of(runtimeZip) },
    ]
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const make = (over: { assets?: CudaAsset[]; build?: string; extract?: (zip: string, dest: string) => Promise<void> } = {}) =>
    new CudaInstaller({
      getTargetDir: () => join(dir, 'llama', 'cuda-b12318'),
      getDownloadDir: () => join(dir, 'llama', 'downloads'),
      getBuild: () => over.build ?? 'b12318',
      fetch: (url, init) => fetch(url, init),
      onInstalled: () => installed(),
      onChange: (s) => statuses.push(s),
      assets: over.assets ?? assets,
      logger: silentLogger,
      retryDelayMs: () => 0,
      attemptsPerSource: 1,
      ...(over.extract ? { extract: over.extract } : {}),
    })

  /** Extractor stub that writes the file names a real extraction would produce. */
  const fakeExtract = (files: Record<string, string>) => async (zip: string, dest: string): Promise<void> => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    for (const [name, content] of Object.entries(files)) {
      if (!zip.endsWith(name.split('::')[0] as string)) continue
      const file = name.split('::')[1] as string
      await mkdir(join(dest, file, '..'), { recursive: true })
      await writeFile(join(dest, file), content)
    }
  }

  it('HEAD-verifies, downloads both zips, extracts, installs and asks to switch the backend', async () => {
    const extracted: string[] = []
    const installer = make({
      extract: async (zip, dest) => {
        extracted.push(zip.split(/[\\/]/).pop() as string)
        await fakeExtract({ 'main.zip::llama-server.exe': 'exe', 'runtime.zip::cudart64_12.dll': 'dll' })(zip, dest)
      },
    })
    installer.start()
    await installer.whenDone()

    const target = join(dir, 'llama', 'cuda-b12318')
    expect(installer.getStatus()).toMatchObject({ state: 'ready', installed: true })
    expect(existsSync(join(target, 'llama-server.exe'))).toBe(true)
    expect(existsSync(join(target, 'cudart64_12.dll'))).toBe(true)
    expect(extracted).toEqual(['main.zip', 'runtime.zip'])
    expect(installed).toHaveBeenCalledTimes(1)
    // Staging and the zips are cleaned up.
    expect(existsSync(`${target}.staging`)).toBe(false)
    expect(existsSync(join(dir, 'llama', 'downloads', 'main.zip'))).toBe(false)
    // HEAD requests came first.
    expect(statuses.map((s) => s.state)).toEqual(expect.arrayContaining(['checking', 'downloading', 'extracting', 'ready']))
    expect(statuses.find((s) => s.state === 'downloading' && s.receivedBytes > 0)).toBeDefined()
  })

  it('stays on the current backend when the download fails (sha256 mismatch)', async () => {
    const installer = make({ assets: [{ ...assets[0]!, sha256: 'a'.repeat(64) }, assets[1]!] })
    installer.start()
    await installer.whenDone()
    expect(installer.getStatus()).toMatchObject({ state: 'error', errorCode: 'DOWNLOAD_FAILED', installed: false })
    expect(installed).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'llama', 'cuda-b12318'))).toBe(false)
  })

  it('fails with SERVER_MISSING when the archive has no llama-server.exe and leaves nothing behind', async () => {
    const installer = make({ extract: fakeExtract({ 'main.zip::readme.txt': 'x' }) })
    installer.start()
    await installer.whenDone()
    expect(installer.getStatus()).toMatchObject({ state: 'error', errorCode: 'SERVER_MISSING' })
    expect(installed).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'llama', 'cuda-b12318'))).toBe(false)
    expect(existsSync(join(dir, 'llama', 'cuda-b12318.staging'))).toBe(false)
  })

  it('reports a failed extraction', async () => {
    const installer = make({ extract: () => Promise.reject(new Error('tar.exe exploded')) })
    installer.start()
    await installer.whenDone()
    expect(installer.getStatus()).toMatchObject({ state: 'error', errorCode: 'EXTRACT_FAILED' })
  })

  it('refuses builds without pinned assets', async () => {
    const installer = make({ build: 'b99999' })
    installer.start()
    await installer.whenDone()
    expect(installer.getStatus()).toMatchObject({ state: 'error', errorCode: 'UNSUPPORTED_BUILD' })
    expect(server.requests).toEqual([])
  })

  it('cancel keeps the partial zip and returns to the absent state', async () => {
    server.route('/main.zip', mainZip, [{ kind: 'slow', chunk: 200, delayMs: 20 }])
    const installer = make()
    installer.start()
    while (!statuses.some((s) => s.state === 'downloading' && s.receivedBytes > 0)) await new Promise((r) => setTimeout(r, 10))
    installer.cancel()
    await installer.whenDone()
    expect(installer.getStatus().state).toBe('absent')
    expect(statSync(join(dir, 'llama', 'downloads', 'main.zip.part')).size).toBeGreaterThan(0)
    expect(installed).not.toHaveBeenCalled()
    server.route('/main.zip', mainZip)
  })

  it('reports a missing asset (404) and an unreachable host', async () => {
    const missing = make({ assets: [{ ...assets[0]!, url: `${server.baseUrl}/nope.zip` }, assets[1]!] })
    missing.start()
    await missing.whenDone()
    expect(missing.getStatus()).toMatchObject({ state: 'error', errorCode: 'ASSET_MISSING' })

    const unreachable = make({ assets: [{ ...assets[0]!, url: 'http://127.0.0.1:9/main.zip' }, assets[1]!] })
    unreachable.start()
    await unreachable.whenDone()
    expect(unreachable.getStatus()).toMatchObject({ state: 'error', errorCode: 'UNREACHABLE' })
  })

  it('is idle-ready when a CUDA build is already on disk', async () => {
    const installer = make({ extract: fakeExtract({ 'main.zip::llama-server.exe': 'exe' }) })
    installer.start()
    await installer.whenDone()
    expect(make().getStatus()).toMatchObject({ state: 'ready', installed: true })
    expect(readFileSync(join(dir, 'llama', 'cuda-b12318', 'llama-server.exe'), 'utf8')).toBe('exe')
  })
})

describe('verifyAssetUrls', () => {
  it('rejects a changed size', async () => {
    const server = await startTestServer()
    try {
      server.route('/a.zip', mainZip)
      const asset: CudaAsset = { fileName: 'a.zip', url: `${server.baseUrl}/a.zip`, size: mainZip.byteLength + 5, sha256: sha256Of(mainZip) }
      await expect(verifyAssetUrls([asset], (url, init) => fetch(url, init), new AbortController().signal)).rejects.toMatchObject({ code: 'ASSET_CHANGED' })
      await expect(verifyAssetUrls([{ ...asset, size: mainZip.byteLength }], (url, init) => fetch(url, init), new AbortController().signal)).resolves.toBeUndefined()
    } finally {
      await server.close()
    }
  })
})

describe('findServerDir', () => {
  it('finds llama-server.exe at the root or one folder below', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-find-'))
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      expect(await findServerDir(dir)).toBeNull()
      mkdirSync(join(dir, 'inner'))
      writeFileSync(join(dir, 'inner', 'llama-server.exe'), 'x')
      expect(await findServerDir(dir)).toBe(join(dir, 'inner'))
      writeFileSync(join(dir, 'llama-server.exe'), 'x')
      expect(await findServerDir(dir)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
