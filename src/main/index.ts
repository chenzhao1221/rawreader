import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain, nativeTheme, net, safeStorage, shell as electronShell } from 'electron'
import { appIdentity } from '../shared/app-identity'
import { resolveTheme } from '../shared/theme'
import { FLAVOR } from '../shared/flavor'
import { INFOBAR_HEIGHT, MAX_TABS } from '../shared/constants'
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
import { createHardwareProbe } from './system/hardware'
import { FileVerifier, createJsonMemoStore } from './models/verify'
import { createFontProvider } from './overlay/font'
import { initLogging, logsDirFor } from './log/setup'
import { createPipelineWiring } from './pipeline/wiring'
import type { PipelineWiring } from './pipeline/wiring'
import { SHUTDOWN_TIMEOUT_MS, createQuitGuard } from './shutdown'
import { isHttpUrl } from './window/address'
import { setupBrowseSession } from './window/session'
import { applyWindowTheme, createShellWindow } from './window/shell-window'
import type { ShellWindow } from './window/shell-window'
import { restorePlan, shortcutFor } from './window/tab-order'
import { createTabManager } from './window/tabs'
import type { TabManager } from './window/tabs'
import type { BrowseView } from './window/browse-view'
import { GoogleTranslator } from './webtext/google'
import { AdBlock } from './adblock/adblock'
import { SecretStore } from './secrets/store'
import { WebTextService } from './webtext/service'
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
let tabs: TabManager | null = null
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
  // The lite package has no model files: start it on Gemini until the user finishes the setup wizard.
  if (FLAVOR === 'lite' && !getConfig().ui.setupDone && getConfig().translate.engine === 'local') {
    updateConfig({ translate: { engine: 'gemini' } })
  }
  const userDataDir = app.getPath('userData')
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const { runDir, logsDir } = llamaPaths(userDataDir)

  const browseSession = setupBrowseSession((notice) => sendToShell('shell:notice', notice))
  // Started before any tab exists; with a cached engine blocking is on by the time the first page loads, a cold
  // start downloads the lists in the background and the first page may load unfiltered.
  const adBlock = new AdBlock({
    session: browseSession,
    cachePath: join(userDataDir, 'adblock', 'engine.bin'),
    fetch: (url) => net.fetch(url),
    logger: createLogger('adblock'),
  })
  void adBlock.setEnabled(getConfig().ui.adBlock)
  const secrets = new SecretStore(join(userDataDir, 'secrets.json'), safeStorage)

  const themeNow = () => resolveTheme(getConfig().ui.theme, nativeTheme.shouldUseDarkColors)
  const shellWindow = createShellWindow(join(resourcesDir, 'icons', 'icon.png'), themeNow())
  shell = shellWindow
  const { win } = shellWindow
  // "Follow Windows": repaint the caption buttons when the system switches light/dark.
  nativeTheme.on('updated', () => applyWindowTheme(win, themeNow()))
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
    browseSession,
    env: modelEnv,
    workerPath: join(import.meta.dirname, 'detect-worker.js'),
    sendProgress: (progress) => sendToShell('pipeline:progress', progress),
    secrets: { get: (name) => secrets.get(name), has: (name) => secrets.has(name) },
    fetch: (url, init) => net.fetch(url, init),
    ...(resultCache
      ? { cache: createPipelineCache({ cache: resultCache, getIdentity: createIdentityProvider(getConfig, modelEnv), logger: cacheLogger }) }
      : {}),
    logger: createLogger('pipeline'),
  })
  wiring = pipelineWiring

  let panelOpen = false
  let barShown = false
  let savedSession = JSON.stringify(getConfig().ui.openTabs)
  const findTab = (id: number): BrowseView | undefined => tabs?.all().find((view) => view.webContentsId === id)
  const webText = new WebTextService({
    translator: new GoogleTranslator((url, init) => net.fetch(url, init)),
    getPrefs: () => getConfig().ui.webTranslate,
    setPrefs: (prefs) => {
      updateConfig({ ui: { webTranslate: { alwaysLangs: [...prefs.alwaysLangs], neverLangs: [...prefs.neverLangs], neverSites: [...prefs.neverSites] } } })
    },
    sendCommand: (tabId, command) => {
      const wc = findTab(tabId)?.webContents
      if (wc && !wc.isDestroyed()) wc.send('webtext:command', command)
    },
    sendBar: (bar) => {
      const shown = bar.state !== 'hidden'
      if (shown !== barShown) {
        barShown = shown
        tabs?.relayout()
      }
      sendToShell('webtext:bar', bar)
    },
    getActiveTabId: () => tabs?.active()?.webContentsId ?? null,
    getHost: (tabId) => {
      try {
        return new URL(findTab(tabId)?.getState().url ?? '').host
      } catch {
        return ''
      }
    },
    logger: createLogger('webtext'),
  })
  const tabManager = createTabManager({
    win,
    preloadPath: join(import.meta.dirname, '../preload/browse.cjs'),
    onActiveState: (state) => {
      sendToShell('browse:state', state)
      if (!win.isDestroyed()) win.setTitle(state.title ? `${state.title} - ${appIdentity.productName}` : appIdentity.productName)
    },
    onTabs: (state) => sendToShell('tabs:state', state),
    onNotice: (notice) => sendToShell('shell:notice', notice),
    // Written only when the URLs or the active tab change, not on every title or loading update.
    onSession: (urls, active) => {
      const next = JSON.stringify({ urls, active })
      if (next === savedSession) return
      savedSession = next
      updateConfig({ ui: { openTabs: { urls, active }, lastUrl: urls[active] ?? null } })
    },
    onTabCreated: (view) => {
      pipelineWiring.attachTab(view.webContents)
      const id = view.webContentsId
      view.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) webText.forget(id)
      })
    },
    onTabClosed: (view) => {
      pipelineWiring.detachTab(view.webContents)
      webText.forget(view.webContentsId)
    },
    onActiveChanged: (view) => {
      pipelineWiring.setActiveTab(view ? view.webContents : null)
      // The bar belongs to the tab: show the new tab's bar (or none).
      const bar = webText.barFor(view ? view.webContentsId : null)
      const shown = bar.state !== 'hidden'
      if (shown !== barShown) {
        barShown = shown
        tabs?.relayout()
      }
      sendToShell('webtext:bar', bar)
    },
    onFocusAddress: () => {
      sendToShell('shell:focus-address', {})
      if (!win.isDestroyed()) win.webContents.focus()
    },
    isPanelOpen: () => panelOpen,
    isQuitting: () => quitting,
    getExtraTop: () => (barShown ? INFOBAR_HEIGHT : 0),
  })
  tabs = tabManager
  win.webContents.on('before-input-event', (event, input) => {
    const shortcut = shortcutFor(input)
    if (!shortcut) return
    event.preventDefault()
    tabManager.shortcut(shortcut)
  })
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

  // Read once: CPU, RAM, free disk and GPUs do not change while the app runs.
  const hardwareProbe = createHardwareProbe(() => getConfig().models.dir ?? join(userDataDir, 'models'))

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
    isBrowse: (id) => tabManager.isTab(id),
  })
  disposeIpc = () => registrar.dispose()
  registerSkeletonHandlers(registrar, {
    getConfig,
    updateConfig,
    navigate: (url) => tabManager.navigate(url),
    go: (action) => tabManager.go(action),
    setBrowseVisible: (visible) => {
      panelOpen = !visible
      tabManager.setVisible(visible)
    },
    getTabs: () => tabManager.state(),
    newTab: (url) => {
      tabManager.open(url, true)
      // A blank tab is opened to type in: hand the caret to the address bar.
      if (url === null) {
        sendToShell('shell:focus-address', {})
        if (!win.isDestroyed()) win.webContents.focus()
      }
    },
    closeTab: (id) => tabManager.close(id),
    activateTab: (id) => tabManager.activate(id),
    getLlamaStatuses: () => llama.getStatuses(),
    controlLlama: (role, action) => llama.control(role, action),
    pageHello: (hello, senderId) => pipelineWiring.pageHello(hello, senderId),
    pageImages: (batch, senderId) => pipelineWiring.pageImages(batch, senderId),
    webTextPage: (page, senderId) => {
      void webText.pageReady(senderId, page)
    },
    webTextTranslate: async (request, senderId) => ({ translations: await webText.translate(senderId, request) }),
    webTextDone: ({ docId, state }, senderId) => webText.done(senderId, docId, state),
    getWebTextBar: () => webText.barFor(tabManager.active()?.webContentsId ?? null),
    webTextBarAction: (action) => webText.barAction(action),
    getSecretsStatus: () => secrets.status(),
    setSecret: (name, value) => {
      secrets.set(name, value)
      return secrets.status()
    },
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
    getHardware: () => hardwareProbe.get(),
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
    if (next.ui.adBlock !== previous.ui.adBlock) void adBlock.setEnabled(next.ui.adBlock)
    if (next.ui.theme !== previous.ui.theme) applyWindowTheme(win, themeNow())
  })

  await shellWindow.loaded.catch((error: unknown) => {
    log.error(`Shell renderer failed to load: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Reopen the tabs of the last session (R2.11), then hand the shell its initial state.
  const plan = restorePlan(getConfig().ui.openTabs, getConfig().ui.lastUrl, isHttpUrl, MAX_TABS)
  if (plan.urls.length === 0) tabManager.open(null, true)
  plan.urls.forEach((url, index) => tabManager.open(url, index === plan.active))
  sendToShell('tabs:state', tabManager.state())
  sendToShell('browse:state', tabManager.active()?.getState() ?? { url: '', title: '', canGoBack: false, canGoForward: false, loading: false })
  for (const status of llama.getStatuses()) sendToShell('llama:status', status)

  // Verify the model files in the background (sizes now, sha256 once per file).
  modelService.refresh()

  // Memory trace: one line per minute, so a growing process shows up in main.log.
  const MEMORY_WARN_MB = 3072
  const memoryTimer = setInterval(() => {
    const tabPids = new Map<number, string>()
    for (const view of tabManager.all()) {
      const wc = view.webContents
      if (wc.isDestroyed()) continue
      let host = ''
      try {
        host = new URL(wc.getURL()).host
      } catch {
        host = '(blank)'
      }
      tabPids.set(wc.getOSProcessId(), host)
    }
    const parts: string[] = []
    let totalMb = 0
    for (const metric of app.getAppMetrics()) {
      // privateBytes is reported in KB.
      const mb = Math.round((metric.memory.privateBytes ?? metric.memory.workingSetSize) / 1024)
      totalMb += mb
      const label = tabPids.get(metric.pid) ?? metric.name ?? metric.type
      parts.push(`${metric.type}:${label}=${mb}MB`)
      if (mb >= MEMORY_WARN_MB) log.warn(`High memory: ${metric.type} ${label} pid ${metric.pid} uses ${mb} MB`)
    }
    log.info(`memory total=${totalMb}MB tabs=${tabPids.size} ${parts.join(' ')}`)
  }, 60_000)
  memoryTimer.unref()

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
      tabs?.destroyAll()
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
