import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { Config, DeepPartial } from '../../shared/config/schema'
import type { ModelsOverview } from '../../shared/ipc/contract'
import { deepMerge } from '../config/merge'
import { silentLogger } from '../log/log'
import { fixtureBytes, sha256Of, startTestServer } from './__fixtures__/http-server'
import type { TestServer } from './__fixtures__/http-server'
import { hashFile } from './download'
import type { ManifestEntry } from './manifest'
import { ModelService } from './service'
import type { ModelPickers } from './service'
import { FileVerifier } from './verify'
import type { VerifiedEntry } from './verify'

const bodies = {
  ocr: fixtureBytes(30_000, 11),
  ocrMmproj: fixtureBytes(20_000, 12),
  translator: fixtureBytes(40_000, 13),
}

function entry(role: 'ocr' | 'ocrMmproj' | 'translator', fileName: string): ManifestEntry {
  const body = bodies[role]
  return {
    role,
    fileName,
    size: body.byteLength,
    sha256: sha256Of(body),
    bundled: false,
    huggingface: { repo: 'org/repo', revision: 'rev1' },
    modelscope: { repo: 'org/repo-ms', revision: 'master' },
    displayName: fileName,
    license: 'Apache-2.0',
  }
}

const manifest = [entry('ocr', 'PaddleOCR-VL-1.5.gguf'), entry('ocrMmproj', 'PaddleOCR-VL-1.5-mmproj.gguf'), entry('translator', 'Index-Translate-2B.Q4_K_M.gguf')]

describe('ModelService', () => {
  let server: TestServer
  let dir: string
  let userData: string
  let config: Config
  let overviews: ModelsOverview[]
  let picked: { folder: string | null; file: string | null }
  let ready: ReturnType<typeof vi.fn<() => void>>

  beforeAll(async () => {
    server = await startTestServer()
    for (const e of manifest) {
      server.route(`/${e.huggingface.repo}/resolve/${e.huggingface.revision}/${e.fileName}`, bodies[e.role as keyof typeof bodies])
    }
  })
  afterAll(async () => {
    await server.close()
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-ms-'))
    userData = join(dir, 'userData')
    mkdirSync(userData, { recursive: true })
    config = ConfigSchema.parse({ models: { mirrors: { huggingface: server.baseUrl, modelscope: server.baseUrl } } })
    overviews = []
    picked = { folder: null, file: null }
    ready = vi.fn<() => void>()
    server.requests.length = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const make = () => {
    const memo: VerifiedEntry[] = []
    const pickers: ModelPickers = { pickFolder: () => Promise.resolve(picked.folder), pickFile: () => Promise.resolve(picked.file) }
    const service = new ModelService({
      getConfig: () => config,
      updateConfig: (patch: DeepPartial<Config>) => {
        config = ConfigSchema.parse(deepMerge(config as never, patch as never))
        return config
      },
      env: { userDataDir: userData, resourcesDir: join(dir, 'resources'), exists: existsSync },
      fetch: (url, init) => fetch(url, init),
      pickers,
      verifier: new FileVerifier({ memo: { load: () => Promise.resolve(memo), save: (e) => {
            memo.splice(0, memo.length, ...e)
            return Promise.resolve()
          },
        }, hash: hashFile }),
      listDir: (folder) => Promise.resolve(existsSync(folder) ? readdirSync(folder) : []),
      onChange: (o) => overviews.push(o),
      onModelsReady: () => ready(),
      logger: silentLogger,
      manifest,
      downloadOptions: { retryDelayMs: () => 0 },
    })
    return service
  }

  const settled = async (service: ModelService, predicate: (o: ModelsOverview) => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate(service.getOverview())) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('timed out')
  }

  it('lists missing files, their total size and the first-run state', () => {
    const o = make().getOverview()
    expect(o.items.map((i) => i.origin)).toEqual(['missing', 'missing', 'missing'])
    expect(o.missingBytes).toBe(30_000 + 20_000 + 40_000)
    expect(o.needsSetup).toBe(true)
    expect(o.downloadsAllowed).toBe(true)
    expect(o.modelsDir).toBe(join(userData, 'models'))
  })

  it('refuses to download in dev (autoDownload false) and shows no first-run panel', () => {
    config = ConfigSchema.parse({ models: { autoDownload: false, mirrors: { huggingface: server.baseUrl } } })
    const service = make()
    expect(service.getOverview().needsSetup).toBe(false)
    expect(service.download('start').notice).toEqual({ code: 'downloads-disabled' })
    expect(server.requests).toEqual([])
  })

  it('downloads the missing files into the models folder, verifies them and signals readiness', async () => {
    const service = make()
    expect(service.download('start').notice).toBeNull()
    await settled(service, (o) => o.items.every((i) => i.path !== null && i.download?.status === 'done'))
    const o = service.getOverview()
    expect(o.needsSetup).toBe(false)
    expect(o.items.every((i) => i.origin === 'models-dir' && i.check === 'ok')).toBe(true)
    for (const e of manifest) expect(new Uint8Array(readFileSync(join(userData, 'models', e.fileName)))).toEqual(bodies[e.role as keyof typeof bodies])
    expect(ready).toHaveBeenCalled()
    expect(service.download('start').notice).toEqual({ code: 'nothing-to-download' })
  })

  it('downloads only the requested role', async () => {
    const service = make()
    service.download('start', 'translator')
    await settled(service, (o) => o.items.find((i) => i.role === 'translator')?.path !== null)
    expect(service.getOverview().items.filter((i) => i.path !== null).map((i) => i.role)).toEqual(['translator'])
  })

  it('uses a picked file after the size check and verifies its hash in the background', async () => {
    const file = join(dir, 'my-ocr.gguf')
    writeFileSync(file, bodies.ocr)
    picked.file = file
    const service = make()
    const result = await service.pickFile('ocr')
    expect(result.notice).toBeNull()
    expect(config.models.paths.ocr).toBe(file)
    await settled(service, (o) => o.items.find((i) => i.role === 'ocr')?.check === 'ok')
    expect(service.getOverview().items.find((i) => i.role === 'ocr')).toMatchObject({ origin: 'config', path: file })
  })

  it('warns about a wrong size and applies the file only when the user confirms', async () => {
    const file = join(dir, 'wrong.gguf')
    writeFileSync(file, fixtureBytes(1234, 5))
    picked.file = file
    const service = make()
    const result = await service.pickFile('ocr')
    expect(result.notice).toEqual({ code: 'size-mismatch', role: 'ocr', path: file })
    expect(config.models.paths.ocr).toBeNull()

    await service.useFile('ocr', file)
    expect(config.models.paths.ocr).toBe(file)
    await settled(service, (o) => o.items.find((i) => i.role === 'ocr')?.check === 'size-mismatch')
  })

  it('flags a file of the right size with the wrong content after hashing', async () => {
    const file = join(dir, 'same-size.gguf')
    writeFileSync(file, fixtureBytes(bodies.ocr.byteLength, 99))
    picked.file = file
    const service = make()
    expect((await service.pickFile('ocr')).notice).toBeNull()
    await settled(service, (o) => o.items.find((i) => i.role === 'ocr')?.check === 'hash-mismatch')
  })

  it('reports a cancelled dialog without changing anything', async () => {
    const service = make()
    expect((await service.pickFile('ocr')).notice).toEqual({ code: 'canceled', role: 'ocr' })
    expect((await service.pickFolder()).notice).toEqual({ code: 'canceled' })
    expect(config.models.dir).toBeNull()
  })

  it('sets the models folder and finds files that are already there', async () => {
    const folder = join(dir, 'my-models')
    mkdirSync(folder)
    writeFileSync(join(folder, 'PaddleOCR-VL-1.5.gguf'), bodies.ocr)
    picked.folder = folder
    const service = make()
    await service.pickFolder()
    expect(config.models.dir).toBe(folder)
    expect(service.getOverview().items.find((i) => i.role === 'ocr')).toMatchObject({ origin: 'models-dir', path: join(folder, 'PaddleOCR-VL-1.5.gguf') })
    expect(service.getOverview().modelsDir).toBe(folder)
  })

  it('locates existing models in a folder and says so when there are none', async () => {
    const folder = join(dir, 'old-downloads')
    mkdirSync(folder)
    writeFileSync(join(folder, 'index-translate-2b.q4_k_m.gguf'), bodies.translator)
    picked.folder = folder
    const service = make()
    expect((await service.locateFolder()).notice).toBeNull()
    expect(config.models.paths.translator).toBe(join(folder, 'index-translate-2b.q4_k_m.gguf'))
    expect(config.models.paths.ocr).toBeNull()

    const empty = join(dir, 'empty')
    mkdirSync(empty)
    picked.folder = empty
    expect((await service.locateFolder()).notice).toEqual({ code: 'nothing-found' })
  })

  it('drops a stale explicit path when the file is downloaded instead', async () => {
    config = ConfigSchema.parse({
      models: { paths: { translator: join(dir, 'gone.gguf') }, mirrors: { huggingface: server.baseUrl, modelscope: server.baseUrl } },
    })
    const service = make()
    expect(service.getOverview().items.find((i) => i.role === 'translator')?.path).toBeNull()
    service.download('start', 'translator')
    await settled(service, (o) => o.items.find((i) => i.role === 'translator')?.path !== null)
    expect(config.models.paths.translator).toBeNull()
  })

  it('clears an explicit path', async () => {
    const file = join(dir, 'f.gguf')
    writeFileSync(file, bodies.ocr)
    picked.file = file
    const service = make()
    await service.pickFile('ocr')
    service.clearPath('ocr')
    expect(config.models.paths.ocr).toBeNull()
  })
})
