import { ConfigSchema } from '../../shared/config/schema'
import type { Config, DeepPartial } from '../../shared/config/schema'
import type { Logger } from '../log/log'
import { deepMerge } from './merge'
import type { PlainObject } from './merge'
import { sanitizeConfig } from './sanitize'

/** Persistence for the stored (non-overlay) config. Backed by electron-store in the app. */
export interface ConfigBackend {
  read(): unknown
  write(value: Config): void
}

export type ConfigListener = (next: Config, previous: Config) => void

export interface ConfigServiceOptions {
  backend: ConfigBackend
  /** Dev-only overlay. Applied in memory over the stored config and never persisted. */
  overlay?: PlainObject
  logger: Logger
}

/**
 * Holds the stored config and the effective config (stored + dev overlay).
 * Pure: no Electron imports, so it is unit-tested directly.
 */
export class ConfigService {
  private readonly backend: ConfigBackend
  private readonly overlay: PlainObject
  private readonly logger: Logger
  private readonly listeners = new Set<ConfigListener>()
  private stored: Config
  private effective: Config

  constructor(options: ConfigServiceOptions) {
    this.backend = options.backend
    this.overlay = options.overlay ?? {}
    this.logger = options.logger

    const loaded = sanitizeConfig(this.backend.read())
    for (const warning of loaded.warnings) this.logger.warn(warning)
    this.stored = loaded.config
    this.effective = this.computeEffective()
  }

  /** The effective config: stored values with the dev overlay on top. */
  get(): Config {
    return this.effective
  }

  /**
   * Merges `patch` into the stored config, validates, persists and notifies
   * listeners. Overlay values are never written to the store. Returns the new
   * effective config.
   */
  update(patch: DeepPartial<Config>): Config {
    const merged = deepMerge(this.stored as unknown as PlainObject, patch as PlainObject)
    const parsed = ConfigSchema.safeParse(merged)
    if (!parsed.success) {
      throw new Error(`Config update rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    }
    this.stored = parsed.data
    this.backend.write(this.stored)

    const previous = this.effective
    this.effective = this.computeEffective()
    if (JSON.stringify(previous) !== JSON.stringify(this.effective)) {
      for (const listener of this.listeners) {
        try {
          listener(this.effective, previous)
        } catch (error) {
          this.logger.error(`Config listener failed: ${(error as Error).message}`)
        }
      }
    }
    return this.effective
  }

  /** Subscribes to effective-config changes. Returns an unsubscribe function. */
  onChanged(listener: ConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private computeEffective(): Config {
    if (Object.keys(this.overlay).length === 0) return this.stored
    const merged = deepMerge(this.stored as unknown as PlainObject, this.overlay)
    const result = sanitizeConfig(merged)
    for (const warning of result.warnings) this.logger.warn(`Dev overlay: ${warning}`)
    return result.config
  }
}
