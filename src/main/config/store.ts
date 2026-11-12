import { app } from 'electron'
import type { Config, DeepPartial } from '../../shared/config/schema'
import { createLogger } from '../log/log'
import { loadDevOverlay } from './overlay'
import { ConfigService } from './service'
import type { ConfigBackend, ConfigListener } from './service'

const log = createLogger('config')

let service: ConfigService | null = null

/**
 * Creates the config service on top of electron-store. Call once, after
 * `app.setPath('userData', ...)`. In unpackaged builds the dev overlay
 * (dev.config.json, dev.config.local.json, RAWREADER_DEV_CONFIG) is applied
 * in memory only.
 */
export async function initConfig(): Promise<ConfigService> {
  if (service) return service

  // Loaded dynamically: electron-store imports `electron`, which is unavailable in unit tests.
  const { default: Store } = await import('electron-store')
  const store = new Store<Record<string, unknown>>({
    name: 'config',
    cwd: app.getPath('userData'),
  })
  const backend: ConfigBackend = {
    read: () => store.store,
    write: (value) => {
      store.store = value as unknown as Record<string, unknown>
    },
  }

  let overlay: Record<string, unknown> = {}
  if (!app.isPackaged) {
    const loaded = loadDevOverlay({ rootDir: app.getAppPath(), env: process.env })
    for (const warning of loaded.warnings) log.warn(warning)
    if (loaded.sources.length > 0) log.info(`Applied dev config overlay (${loaded.sources.length} file(s))`)
    overlay = loaded.overlay
  }

  service = new ConfigService({ backend, overlay, logger: log })
  return service
}

function requireService(): ConfigService {
  if (!service) throw new Error('Config is not initialised; call initConfig() first')
  return service
}

export function getConfig(): Config {
  return requireService().get()
}

/** Validates and persists a patch, then notifies listeners (which broadcast `config:changed`). */
export function updateConfig(patch: DeepPartial<Config>): Config {
  return requireService().update(patch)
}

export function onConfigChanged(listener: ConfigListener): () => void {
  return requireService().onChanged(listener)
}
