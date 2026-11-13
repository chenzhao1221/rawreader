import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain, shell as electronShell } from 'electron'
import { appIdentity } from '../shared/app-identity'
import type { EventChannel } from '../shared/ipc/channels'
import type { EventPayload } from '../shared/ipc/contract'
import { createIdentityProvider } from './cache/identity'
import { createPipelineCache } from './cache/pipeline-cache'
import { openResultCache } from './cache/store'
import type { ResultCache } from './cache/store'
import { getConfig, initConfig, onConfigChanged, updateConfig } from './config/store'
import { registerSkeletonHandlers } from './ipc/handlers'
import { createIpcRegistrar } from './ipc/register'
import { resolveBinDir } from './llama/backend'
import { LlamaManager, llamaPaths } from './llama/manager'
import { loadLicenses, licenseSources } from './licenses'
import { hasHeadlessSmokeFlag, parseHeadlessSmokeArgs } from './headless/args'
import { runHeadlessSmoke } from './headless/run'
import { createLogger } from './log/log'
import { CUDA_BUILD, CudaInstaller } from './models/cuda'
import { hashFile } from './models/download'
import { createDialogPickers, netFetch } from './models/edge'
import { ModelService } from './models/service'
import { FileVerifier, createJsonMemoStore } from './models/verify'
import { createFontProvider } from './overlay/font'
import { initLogging, logsDirFor } from './log/setup'
import { createPipelineWiring } from './pipeline/wiring'
import type { PipelineWiring } from './pipeline/wiring'
import { SHUTDOWN_TIMEOUT_MS, createQuitGuard } from './shutdown'
import { isHttpUrl } from './window/address'
import { createBrowseView } from './window/browse-view'
import type { BrowseView } from './window/browse-view'
import { setupBrowseSession } from './window/session'
import { createShellWindow } from './window/shell-window'
import type { ShellWindow } from './window/shell-window'
import { createAppTray, showWindow } from './window/tray'
import type { AppTray } from './window/tray'

const log = createLogger('main')

// Headless runs (`--headless-smoke=<kind>`, development builds only) never reach any window code.
// This check must stay before `createShellWindow` and before the single-instance lock.
const headlessFlag = hasHeadlessSmokeFlag(process.argv)
const headlessArgs = headlessFlag && !app.isPackaged ? parseHeadlessSmokeArgs(process.argv) : null

if (headlessFlag && headlessArgs === null) {
  log.error('Unknown or disallowed --headless-smoke flag; exiting without opening a window')
  app.exit(2)
} else if (headlessArgs) {
  runHeadlessSmoke(headlessArgs)
} else {
  // The userData path must be set before `ready` (R1.2). Dev builds get a "-dev" suffix.
  app.setPath(
    'userData',
    join(app.getPath('appData'), appIdentity.userDataDirName + (app.isPackaged ? '' : '-dev')),
  )
  app.setName(appIdentity.productName)
  initLogging(logsDirFor(app.getPath('userData')))
}

let shell: ShellWindow | null = null
let browse: BrowseView | null = null
let manager: LlamaManager | null = null
let wiring: PipelineWiring | null = null
let openCache: ResultCache | null = null
let models: ModelService | null = null
let cuda: CudaInstaller | null = null
let disposeIpc: (() => void) | null = null
let tray: AppTray | null = null
/** Set once a real quit starts (tray "quit", OS shutdown); until then closing the window only hides it. */
let quitting = false

function sendToShell<E extends EventChannel>(channel: E, payload: EventPayload<E>): void {
  // Accessing `win.webContents` on a destroyed window throws, so check the window first.
  const win = shell?.win
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc.isDestroyed()) wc.send(channel, payload)
}

async function bootstrap(): Promise<void> {
  const configService = await initConfig()
  const userDataDir = app.getPath('userData')
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const { runDir, logsDir } = llamaPaths(userDataDir)

  const browseSession = setupBrowseSession((notice) => sendToShell('shell:notice', notice))

  const shellWindow = createShellWindow(join(resourcesDir, 'icons', 'icon.png'))
  shell = shellWindow
  const { win } = shellWindow
  win.on('closed', () => log.info('Shell window closed'))

  tray = createAppTray({
    iconPath: join(resourcesDir, 'icons', 'tray.png'),
    getWindow: () => (win.isDestroyed() ? null : win),
    quit: () => app.quit(),
  })
  // Windows logoff/shutdown does not emit before-quit; let the close through so the OS is not blocked.
  win.on('session-end', () => {
    quitting = true
  })
  // Closing the window hides it to the tray; the models keep running. Only a real quit closes it.
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
    log.info('Shell window hidden to the tray')
    if (!getConfig().ui.trayHintShown) {
      tray?.showHint()
      updateConfig({ ui: { trayHintShown: true } })
    }
  })

  const browseView = createBrowseView({
    win,
    preloadPath: join(import.meta.dirname, '../preload/browse.cjs'),
    onState: (state) => {
      sendToShell('browse:state', state)
      win.setTitle(state.title ? `${state.title} - ${appIdentity.productName}` : appIdentity.productName)
    },
    onNotice: (notice) => sendToShell('shell:notice', notice),
    onNavigated: (url) => {
      updateConfig({ ui: { lastUrl: url } })
    },
  })
  browse = browseView
  browseView.onDestroyed(() => log.info('Browse view webContents destroyed'))

  const llama = new LlamaManager({
    getConfig,
    env: { userDataDir, resourcesDir, exists: existsSync },
    runDir,
    logsDir,
    onStatus: (status) => sendToShell('llama:status', status),
    logger: createLogger('llama'),
  })
  manager = llama

  const modelEnv = { userDataDir, resourcesDir, exists: existsSync }
  const cacheLogger = createLogger('cache')
  const resultCache = openResultCache(join(userDataDir, 'cache', 'cache.db'), {
    getMaxBytes: () => getConfig().cache.maxBytes,
    logger: cacheLogger,
  })
  openCache = resultCache
  const pipelineWiring = createPipelineWiring({
    getConfig,
    getServerStatus: (role) => llama.getStatus(role),
    browseWebContents: browseView.webContents,
    browseSession,
    env: modelEnv,
    workerPath: join(import.meta.dirname, 'detect-worker.js'),
    sendProgress: (progress) => sendToShell('pipeline:progress', progress),
    sendPageConfig: (config) => {
      const target = browseView.webContents
      if (!target.isDestroyed()) target.send('page:config', config)
    },
    sendOverlay: (payload) => {
      const target = browseView.webContents
      if (!target.isDestroyed()) target.send('overlay:result', payload)
    },
    ...(resultCache
      ? { cache: createPipelineCache({ cache: resultCache, getIdentity: createIdentityProvider(getConfig, modelEnv), logger: cacheLogger }) }
      : {}),
    logger: createLogger('pipeline'),
  })
  wiring = pipelineWiring
  const getOverlayFont = createFontProvider(resourcesDir, (path) => readFile(path))

  const modelService = new ModelService({
    getConfig,
    updateConfig,
    env: modelEnv,
    fetch: netFetch,
    pickers: createDialogPickers(() => (shellWindow.win.isDestroyed() ? null : shellWindow.win)),
    verifier: new FileVerifier({ memo: createJsonMemoStore(join(userDataDir, 'models-verified.json')), hash: hashFile }),
    listDir: (dir) => readdir(dir).catch(() => []),
    onChange: (overview) => sendToShell('models:changed', overview),
    // Files arrived: servers that reported MODEL_MISSING start without a restart of the app.
    onModelsReady: () => void llama.startMissing(),
    logger: createLogger('models'),
  })
  models = modelService

  const cudaInstaller = new CudaInstaller({
    getTargetDir: () =>
      resolveBinDir({ ...getConfig().llama, backend: 'cuda' }, { userDataDir, resourcesDir }) ??
      join(userDataDir, 'llama', `cuda-${CUDA_BUILD}`),
    getDownloadDir: () => join(userDataDir, 'llama', 'downloads'),
    getBuild: () => getConfig().llama.build,
    fetch: netFetch,
    // Switching the backend restarts both servers with the new binary (R12.3).
    onInstalled: () => {
      updateConfig({ llama: { backend: 'cuda' } })
    },
    onChange: (status) => sendToShell('cuda:changed', status),
    logger: createLogger('cuda'),
  })
  cuda = cudaInstaller

  const licenseDocs = licenseSources({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })

  const registrar = createIpcRegistrar(ipcMain, {
    shell: () => (shellWindow.win.isDestroyed() ? null : shellWindow.webContentsId),
    browse: () => browseView.webContentsId,
  })
  disposeIpc = () => registrar.dispose()
  registerSkeletonHandlers(registrar, {
    getConfig,
    updateConfig,
    navigate: (url) => browseView.navigate(url),
    go: (action) => browseView.go(action),
    setBrowseVisible: (visible) => browseView.setVisible(visible),
    getLlamaStatuses: () => llama.getStatuses(),
    controlLlama: (role, action) => llama.control(role, action),
    pageHello: (hello) => pipelineWiring.pageHello(hello),
    pageImages: (batch) => pipelineWiring.pageImages(batch),
    getOverlayFont,
    getModelsOverview: () => modelService.getOverview(),
    modelsDownload: (action, role) => modelService.download(action, role),
    modelsPickFolder: () => modelService.pickFolder(),
    modelsLocateFolder: () => modelService.locateFolder(),
    modelsPickFile: (role) => modelService.pickFile(role),
    modelsUseFile: (role, path) => modelService.useFile(role, path),
    modelsClearPath: (role) => modelService.clearPath(role),
    getCudaStatus: () => cudaInstaller.getStatus(),
    cudaDownload: (action) => (action === 'start' ? cudaInstaller.start() : cudaInstaller.cancel()),
    getLicenses: () => loadLicenses(licenseDocs, (path) => readFile(path, 'utf8')),
    getCacheStats: () => resultCache?.stats() ?? { entries: 0, bytes: 0 },
    clearCache: () => {
      resultCache?.clear()
      pipelineWiring.clearResults()
      return resultCache?.stats() ?? { entries: 0, bytes: 0 }
    },
    openLogFolder: async () => {
      const error = await electronShell.openPath(logsDir)
      if (error) log.warn(`Cannot open the log folder: ${error}`)
    },
  })

  configService.onChanged((next, previous) => {
    sendToShell('config:changed', next)
    llama.handleConfigChange(next, previous)
    pipelineWiring.onConfigChanged(next)
  })

  await shellWindow.loaded.catch((error: unknown) => {
    log.error(`Shell renderer failed to load: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Hand the shell its initial state, then reopen the last page (R2.11).
  sendToShell('browse:state', browseView.getState())
  for (const status of llama.getStatuses()) sendToShell('llama:status', status)
  const lastUrl = getConfig().ui.lastUrl
  if (lastUrl && isHttpUrl(lastUrl)) browseView.navigate(lastUrl)

  // Verify the model files in the background (sizes now, sha256 once per file).
  modelService.refresh()

  // Servers start in the background; the window never waits for them.
  void llama
    .cleanOrphans()
    .then(() => llama.startAll())
    .catch((error: unknown) => {
      log.error(`Llama startup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}

if (headlessFlag) {
  // Headless run: no lock, no window, no quit handlers (the smoke exits with app.exit).
} else if (!app.requestSingleInstanceLock()) {
  // Another instance owns the lock; it receives `second-instance` and focuses its window.
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow(shell?.win ?? null)
  })

  // Registered before the quit guard so the window's close handler lets the close through.
  app.on('before-quit', () => {
    quitting = true
  })

  // Exit code: closing the window only hides it to the tray. The tray's "quit" calls app.quit(), which
  // runs shutdown() through the guard and exits 0 with both llama-server PIDs gone.
  // app.exit() is only used by the hard timeout.
  app.on('before-quit', createQuitGuard({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    logger: log,
    quit: () => app.quit(),
    forceExit: () => app.exit(0),
    shutdown: async () => {
      disposeIpc?.()
      models?.dispose()
      cuda?.cancel()
      await wiring?.dispose()
      openCache?.close()
      openCache = null
      await manager?.stopAll()
      browse?.destroy()
      tray?.destroy()
      tray = null
    },
  }))

  app.on('window-all-closed', () => {
    log.info('All windows closed; quitting')
    app.quit()
  })

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      log.error(`Startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      app.quit()
    })
}
