import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import type { Logger } from '../log/log'
import { AdBlock, ENGINE_MAX_AGE_MS, isFresh } from './adblock'

vi.mock('@ghostery/adblocker-electron', () => {
  class ElectronBlocker {
    static fromPrebuiltAdsAndTracking = vi.fn()
    static deserialize = vi.fn()
    serialize = vi.fn(() => new Uint8Array([1, 2, 3]))
    enableBlockingInSession = vi.fn()
    disableBlockingInSession = vi.fn()
  }
  return { ElectronBlocker }
})

const Blocker = ElectronBlocker as unknown as {
  fromPrebuiltAdsAndTracking: ReturnType<typeof vi.fn>
  deserialize: ReturnType<typeof vi.fn>
}

/** Stand-in for the library engine: the blocker only calls these three methods. */
function engine(): ElectronBlocker {
  return new (ElectronBlocker as unknown as new () => ElectronBlocker)()
}

function collector(): Logger & { warns: string[] } {
  const warns: string[] = []
  return {
    warns,
    debug: () => {},
    info: () => {},
    warn: (message) => void warns.push(message),
    error: () => {},
  }
}

const session = {} as Session

describe('isFresh', () => {
  it('accepts an engine younger than the maximum age', () => {
    expect(isFresh(1000, 1000)).toBe(true)
    expect(isFresh(1000, 1000 + ENGINE_MAX_AGE_MS - 1)).toBe(true)
  })

  it('rejects an engine at or past the maximum age', () => {
    expect(isFresh(1000, 1000 + ENGINE_MAX_AGE_MS)).toBe(false)
  })

  it('rejects a timestamp in the future (clock skew)', () => {
    expect(isFresh(2000, 1000)).toBe(false)
  })
})

describe('AdBlock', () => {
  let dir: string
  let cachePath: string
  let logger: ReturnType<typeof collector>
  let now: number

  const create = (): AdBlock =>
    new AdBlock({
      session,
      cachePath,
      fetch: () => Promise.resolve(new Response('')),
      logger,
      now: () => now,
    })

  const writeCache = (bytes = new Uint8Array([9])): void => {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, bytes)
    // The cache is fresh as of now; tests that want a stale one call ageCache().
    now = statSync(cachePath).mtimeMs
  }

  /** Makes the cache older than the refresh window. */
  const ageCache = (ageMs = ENGINE_MAX_AGE_MS + 1): void => {
    now = statSync(cachePath).mtimeMs + ageMs
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-adblock-'))
    cachePath = join(dir, 'adblock', 'engine.bin')
    logger = collector()
    now = Date.now()
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('downloads the lists, writes the cache and attaches to the session', async () => {
    const fresh = engine()
    Blocker.fromPrebuiltAdsAndTracking.mockResolvedValue(fresh)

    await create().setEnabled(true)

    expect(Blocker.fromPrebuiltAdsAndTracking).toHaveBeenCalledTimes(1)
    expect(readFileSync(cachePath)).toEqual(Buffer.from(fresh.serialize() as Uint8Array))
    expect(fresh.enableBlockingInSession).toHaveBeenCalledWith(session)
  })

  it('uses a fresh cache without downloading', async () => {
    const cached = engine()
    writeCache()
    Blocker.deserialize.mockReturnValue(cached)

    await create().setEnabled(true)

    expect(Blocker.deserialize).toHaveBeenCalledTimes(1)
    expect(Blocker.fromPrebuiltAdsAndTracking).not.toHaveBeenCalled()
    expect(cached.enableBlockingInSession).toHaveBeenCalledWith(session)
  })

  it('refreshes a stale cache in the background', async () => {
    const downloaded = engine()
    writeCache()
    ageCache()
    Blocker.fromPrebuiltAdsAndTracking.mockResolvedValue(downloaded)

    await create().setEnabled(true)

    expect(Blocker.fromPrebuiltAdsAndTracking).toHaveBeenCalledTimes(1)
    expect(downloaded.enableBlockingInSession).toHaveBeenCalledWith(session)
  })

  it('keeps the stale engine when the refresh fails', async () => {
    const cached = engine()
    writeCache()
    ageCache()
    Blocker.deserialize.mockReturnValue(cached)
    Blocker.fromPrebuiltAdsAndTracking.mockRejectedValue(new Error('offline'))

    await create().setEnabled(true)

    expect(cached.enableBlockingInSession).toHaveBeenCalledWith(session)
    expect(logger.warns.some((line) => line.includes('cached ones'))).toBe(true)
  })

  it('stays off and warns when there is no cache and no network', async () => {
    Blocker.fromPrebuiltAdsAndTracking.mockRejectedValue(new Error('offline'))

    await create().setEnabled(true)

    // Nothing was built, so there is nothing to cache or attach.
    expect(() => statSync(cachePath)).toThrow()
    expect(Blocker.deserialize).not.toHaveBeenCalled()
    expect(logger.warns.some((line) => line.includes('unavailable'))).toBe(true)
  })

  it('detaches when switched off and re-attaches without downloading again', async () => {
    const blocker = engine()
    Blocker.fromPrebuiltAdsAndTracking.mockResolvedValue(blocker)
    const adBlock = create()

    await adBlock.setEnabled(true)
    await adBlock.setEnabled(false)
    expect(blocker.disableBlockingInSession).toHaveBeenCalledWith(session)

    await adBlock.setEnabled(true)
    expect(blocker.enableBlockingInSession).toHaveBeenCalledTimes(2)
    expect(Blocker.fromPrebuiltAdsAndTracking).toHaveBeenCalledTimes(1)
  })

  it('does not attach twice when enabled twice', async () => {
    const blocker = engine()
    Blocker.fromPrebuiltAdsAndTracking.mockResolvedValue(blocker)
    const adBlock = create()

    await adBlock.setEnabled(true)
    await adBlock.setEnabled(true)

    expect(blocker.enableBlockingInSession).toHaveBeenCalledTimes(1)
  })

  it('does not attach when switched off while the engine loads', async () => {
    const blocker = engine()
    let finish: (value: ElectronBlocker) => void = () => {}
    Blocker.fromPrebuiltAdsAndTracking.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const adBlock = create()

    const loading = adBlock.setEnabled(true)
    await adBlock.setEnabled(false)
    finish(blocker)
    await loading

    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled()
  })
})

/** Guards the cache path layout used by main: `<userData>/adblock/engine.bin`. */
describe('cache path', () => {
  it('creates the parent folder before writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-adblock-path-'))
    const cachePath = join(dir, 'nested', 'adblock', 'engine.bin')
    Blocker.fromPrebuiltAdsAndTracking.mockResolvedValue(engine())

    await new AdBlock({ session, cachePath, fetch: () => Promise.resolve(new Response('')), logger: collector() }).setEnabled(true)

    expect(statSync(dirname(cachePath)).isDirectory()).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
