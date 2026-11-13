import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Session } from 'electron'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import type { Logger } from '../log/log'

/** Filter lists are refreshed after this long; an older engine is still used when the download fails. */
export const ENGINE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

export interface AdBlockOptions {
  session: Session
  /** Where the compiled filter engine is kept between runs. */
  cachePath: string
  fetch: (url: string) => Promise<Response>
  logger: Logger
  /** Clock, for tests. */
  now?: () => number
}

/** Fresh enough to use without downloading, or too old. Exported for tests. */
export function isFresh(mtimeMs: number, now: number, maxAgeMs = ENGINE_MAX_AGE_MS): boolean {
  return now - mtimeMs >= 0 && now - mtimeMs < maxAgeMs
}

/**
 * Ad and tracker blocking for the browse session with the Ghostery engine (uBlock Origin / EasyList
 * filter lists). Network requests to ad hosts are cancelled and ad elements are hidden by a small
 * preload the library registers on the session. Can be switched on and off at run time.
 */
export class AdBlock {
  private blocker: ElectronBlocker | null = null
  private loading: Promise<ElectronBlocker | null> | null = null
  private enabled = false
  /** Blocking is attached to the session right now. */
  private attached = false

  constructor(private readonly options: AdBlockOptions) {}

  /** Turns blocking on or off. The first "on" loads the engine (from the cache or the network). */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (!enabled) {
      this.detach()
      return
    }
    const blocker = await this.load()
    // Switched off again while loading.
    if (!blocker || !this.enabled || this.attached) return
    blocker.enableBlockingInSession(this.options.session)
    this.attached = true
    this.options.logger.info('Ad blocking on')
  }

  private detach(): void {
    if (!this.blocker || !this.attached) return
    this.blocker.disableBlockingInSession(this.options.session)
    this.attached = false
    this.options.logger.info('Ad blocking off')
  }

  private load(): Promise<ElectronBlocker | null> {
    if (this.blocker) return Promise.resolve(this.blocker)
    this.loading ??= this.loadEngine().then((blocker) => {
      this.blocker = blocker
      this.loading = null
      return blocker
    })
    return this.loading
  }

  private async loadEngine(): Promise<ElectronBlocker | null> {
    const { cachePath, logger } = this.options
    const now = (this.options.now ?? Date.now)()
    const cached = await this.readCache()
    if (cached && isFresh(cached.mtimeMs, now)) return cached.blocker

    try {
      const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking((url: string) => this.options.fetch(url))
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, blocker.serialize())
      logger.info('Ad-block filter lists downloaded')
      return blocker
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (cached) {
        logger.warn(`Ad-block lists could not be refreshed (${reason}); using the cached ones`)
        return cached.blocker
      }
      logger.warn(`Ad blocking unavailable: lists could not be downloaded (${reason})`)
      return null
    }
  }

  private async readCache(): Promise<{ blocker: ElectronBlocker; mtimeMs: number } | null> {
    try {
      const info = await stat(this.options.cachePath)
      const bytes = await readFile(this.options.cachePath)
      return { blocker: ElectronBlocker.deserialize(new Uint8Array(bytes)), mtimeMs: info.mtimeMs }
    } catch {
      // Missing, unreadable or from another library version: download again.
      return null
    }
  }
}
