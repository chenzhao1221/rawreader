import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../shared/config/schema'
import type { Config } from '../../shared/config/schema'
import type { ServerStatus } from '../../shared/ipc/contract'
import { captureImage } from '../capture/capture'
import { deepMerge } from '../config/merge'
import { isMissingModel, resolveModelPath } from '../config/model-path'
import { loadDevOverlay } from '../config/overlay'
import { InProcessDetectService } from '../detect/service'
import { LlamaManager } from '../llama/manager'
import { getProcessInfo } from '../llama/win-process'
import type { Logger } from '../log/log'
import { TranslateClient } from '../translate/client'
import { Pipeline } from './scheduler'
import { createModelClients, serversUnavailable } from './services'
import { pipelineSettingsFrom } from './settings'
import type { ImageResult } from './types'

/**
 * Headless end-to-end smoke: real llama-servers (started through the process manager), real detector,
 * real OCR and translation on the synthetic SFW panel. No Electron, no window.
 *
 *   $env:RAWREADER_E2E = '1'; npx vitest run src/main/pipeline/smoke.e2e.test.ts
 *
 * Output goes to `.e2e-out/` (git-ignored): smoke.log, smoke-result.json and the llama-server logs.
 */
const root = join(import.meta.dirname, '../../..')
const outDir = join(root, '.e2e-out')
const logFile = join(outDir, 'smoke.log')
const panelPath = join(root, 'fixtures/smoke/panel.png')

const logger: Logger = {
  debug: () => {},
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
}

function write(level: string, message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}`
  appendFileSync(logFile, `${line}\n`)
  console.log(line)
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe('headless smoke: detect -> OCR -> translate on fixtures/smoke/panel.png', () => {
  let config: Config
  let manager: LlamaManager
  const statuses: Record<string, ServerStatus> = {}
  const seenPids = new Set<number>()
  const env = {
    userDataDir: join(outDir, 'userData'),
    resourcesDir: join(root, 'resources'),
    exists: existsSync,
  }

  beforeAll(() => {
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(join(outDir, 'userData', 'run'), { recursive: true })
    mkdirSync(join(outDir, 'userData', 'logs'), { recursive: true })
    const overlay = loadDevOverlay({ rootDir: root, env: {} })
    config = ConfigSchema.parse(deepMerge({}, overlay.overlay))
    write('INFO', `config: backend=${config.llama.backend} ocrPort=${config.llama.ocr.port} translatePort=${config.llama.translate.port}`)
    manager = new LlamaManager({
      getConfig: () => config,
      env,
      runDir: join(env.userDataDir, 'run'),
      logsDir: join(env.userDataDir, 'logs'),
      onStatus: (status) => {
        statuses[status.role] = status
        if (status.pid !== null) seenPids.add(status.pid)
        write('INFO', `llama ${status.role}: ${status.state}${status.errorCode ? ` ${status.errorCode}` : ''} pid=${status.pid ?? '-'} port=${status.port ?? '-'}`)
      },
      logger,
    })
  })

  afterAll(async () => {
    // Always stop what this test started, even when an assertion failed.
    await manager?.stopAll()
  }, 60_000)

  it('runs the whole pipeline and leaves no server behind', async () => {
    const bytes = new Uint8Array(readFileSync(panelPath))

    // 1. Start both servers through the process manager.
    await manager.startAll()
    await waitFor(() => statuses['ocr']?.state === 'ready' && statuses['translate']?.state === 'ready', 240_000, 'both servers ready')
    expect(serversUnavailable({ ocr: statuses['ocr'] ?? null, translate: statuses['translate'] ?? null })).toBeNull()

    // 2. Pipeline with the real detector (in-process; the same code as the utility-process worker).
    const detectorPath = resolveModelPath('detector', config, env)
    if (isMissingModel(detectorPath)) throw new Error(`detector missing: ${detectorPath.expectedPath}`)
    write('INFO', `detector: ${detectorPath}`)
    const delivered: ImageResult[] = []
    const failures: string[] = []
    const clients = createModelClients(() => config, (role) => manager.getStatus(role))
    const pipeline = new Pipeline({
      settings: () => pipelineSettingsFrom(config),
      capture: (request) =>
        captureImage(
          { getLoadedBytes: () => Promise.resolve(bytes), fetchBytes: () => Promise.reject(new Error('fetch must not be used')) },
          request,
        ),
      detect: new InProcessDetectService(detectorPath),
      ocr: clients.ocr,
      translator: clients.translator,
      serversUnavailable: () => serversUnavailable({ ocr: manager.getStatus('ocr'), translate: manager.getStatus('translate') }),
      onResult: (_subscriber, result) => delivered.push(result),
      onFailure: (_subscriber, failure) => failures.push(`${failure.code}: ${failure.message}`),
      onProgress: () => {},
      logger,
    })
    pipeline.setEnabled(true)
    pipeline.beginDocument('smoke-doc-0001', 'https://smoke.local/chapter')

    const started = Date.now()
    pipeline.submit({
      docId: 'smoke-doc-0001',
      pageUrl: 'https://smoke.local/chapter',
      images: [{ elId: 'rr1', url: 'https://smoke.local/panel.png', naturalW: 800, naturalH: 1100, distance: 0 }],
    })
    await pipeline.whenIdle()
    const wallMs = Date.now() - started
    await pipeline.dispose()

    expect(failures).toEqual([])
    expect(delivered).toHaveLength(1)
    const result = delivered[0] as ImageResult

    // 3. Report boxes, OCR text and translations.
    const round = (b: { x1: number; y1: number; x2: number; y2: number }): number[] => [b.x1, b.y1, b.x2, b.y2].map(Math.round)
    for (const [index, unit] of result.units.entries()) {
      write('INFO', `unit ${index}: kind=${unit.kind} bubbleOnly=${unit.bubbleOnly} draw=${JSON.stringify(round(unit.drawBox))} ocrBox=${JSON.stringify(round(unit.ocrBox))} status=${unit.status}`)
      write('INFO', `unit ${index}: OCR  ${JSON.stringify(unit.ocrText)}`)
      write('INFO', `unit ${index}: ZH   ${JSON.stringify(unit.translation)}`)
    }
    write('INFO', `timings: ${JSON.stringify(result.timings)} wall=${wallMs}ms`)

    // 4. Prompt comparison on the same OCR text: context on / off / baseline (information for the report).
    const sources = result.units.map((u) => u.ocrText)
    const variants: Array<[string, Partial<{ promptVariant: 'lmt' | 'baseline'; contextUnits: number }>]> = [
      ['lmt+context3', { promptVariant: 'lmt', contextUnits: 3 }],
      ['lmt-nocontext', { promptVariant: 'lmt', contextUnits: 0 }],
      ['baseline', { promptVariant: 'baseline', contextUnits: 0 }],
    ]
    const comparison: Record<string, Array<{ translation: string; echo: boolean; retriedBare: boolean }>> = {}
    for (const [name, override] of variants) {
      const client = new TranslateClient({
        getPort: () => manager.getStatus('translate').port ?? config.llama.translate.port,
        model: config.llama.translate.alias,
        targetLang: config.translate.targetLang,
        promptVariant: override.promptVariant ?? 'lmt',
        contextUnits: override.contextUnits ?? 3,
      })
      comparison[name] = []
      for (let index = 0; index < sources.length; index++) {
        const r = await client.translate({ sources, index })
        comparison[name]!.push(r.ok ? { translation: r.translation, echo: r.echo, retriedBare: r.retriedBare } : { translation: `ERROR ${r.error.code}`, echo: false, retriedBare: false })
        write('INFO', `variant ${name} #${index}: ${JSON.stringify(comparison[name]![index])}`)
      }
    }

    writeFileSync(
      join(outDir, 'smoke-result.json'),
      JSON.stringify({ image: { width: result.width, height: result.height, hash: result.hash }, units: result.units, timings: result.timings, wallMs, comparison }, null, 2),
    )

    expect(result.units.length).toBeGreaterThan(0)
    expect(result.units.some((u) => u.ocrText.trim().length > 0)).toBe(true)
    expect(result.units.some((u) => /[\u4e00-\u9fff]/.test(u.translation))).toBe(true)

    // 5. Stop the servers and prove they are gone.
    await manager.stopAll()
    expect(seenPids.size).toBeGreaterThan(0)
    for (const pid of seenPids) {
      expect(await getProcessInfo(pid)).toBeNull()
      write('INFO', `pid ${pid}: gone`)
    }
    for (const port of [config.llama.ocr.port, config.llama.translate.port]) {
      expect(await portIsOpen(port)).toBe(false)
      write('INFO', `port ${port}: free`)
    }
  }, 600_000)
})
