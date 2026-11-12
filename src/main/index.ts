import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { appIdentity } from '../shared/app-identity'
import type { EventChannel } from '../shared/ipc/channels'
import type { EventPayload } from '../shared/ipc/contract'
import { getConfig, initConfig, onConfigChanged, updateConfig } from './config/store'
import { registerSkeletonHandlers } from './ipc/handlers'
import { createIpcRegistrar } from './ipc/register'
import { LlamaManager, llamaPaths } from './llama/manager'
import { createLogger } from './log/log'
import { SHUTDOWN_TIMEOUT_MS, createQuitGuard } from './shutdown'
import { isHttpUrl } from './window/address'
import { createBrowseView } from './window/browse-view'
import type { BrowseView } from './window/browse-view'
import { setupBrowseSession } from './window/session'
import { createShellWindow } from './window/shell-window'
import type { ShellWindow } from './window/shell-window'

const log = createLogger('main')

// The userData path must be set before `ready` (R1.2). Dev builds get a "-dev" suffix.
app.setPath(
  'userData',
  join(app.getPath('appData'), appIdentity.userDataDirName + (app.isPackaged ? '' : '-dev')),
)
app.setName(appIdentity.productName)

let shell: ShellWindow | null = null
let browse: BrowseView | null = null
let manager: LlamaManager | null = null
let disposeIpc: (() => void) | null = null

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

  setupBrowseSession((notice) => sendToShell('shell:notice', notice))

  const shellWindow = createShellWindow()
  shell = shellWindow
  const { win } = shellWindow

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

  const llama = new LlamaManager({
    getConfig,
    env: { userDataDir, resourcesDir, exists: existsSync },
    runDir,
    logsDir,
    onStatus: (status) => sendToShell('llama:status', status),
    logger: createLogger('llama'),
  })
  manager = llama

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
  })

  configService.onChanged((next, previous) => {
    sendToShell('config:changed', next)
    llama.handleConfigChange(next, previous)
  })

  await shellWindow.loaded.catch((error: unknown) => {
    log.error(`Shell renderer failed to load: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Hand the shell its initial state, then reopen the last page (R2.11).
  sendToShell('browse:state', browseView.getState())
  for (const status of llama.getStatuses()) sendToShell('llama:status', status)
  const lastUrl = getConfig().ui.lastUrl
  if (lastUrl && isHttpUrl(lastUrl)) browseView.navigate(lastUrl)

  // Servers start in the background; the window never waits for them.
  void llama
    .cleanOrphans()
    .then(() => llama.startAll())
    .catch((error: unknown) => {
      log.error(`Llama startup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the lock; it receives `second-instance` and focuses its window.
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = shell?.win
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('before-quit', createQuitGuard({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    logger: log,
    quit: () => app.quit(),
    forceExit: () => app.exit(0),
    shutdown: async () => {
      disposeIpc?.()
      await manager?.stopAll()
      browse?.destroy()
    },
  }))

  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      log.error(`Startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      app.quit()
    })
}
