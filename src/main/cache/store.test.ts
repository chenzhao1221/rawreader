import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log/log'
import type { UnitResult } from '../pipeline/types'
import { EVICT_TARGET_RATIO, isCacheable, openResultCache, toCachedImage } from './store'
import type { ResultCache } from './store'

const box = { x1: 1, y1: 2, x2: 30, y2: 40, confidence: 0.9 }
const unit = (patch: Partial<UnitResult> = {}): UnitResult => ({
  kind: 'bubble',
  bubbleOnly: false,
  drawBox: box,
  ocrBox: box,
  ocrText: 'こんにちは',
  translation: '你好',
  status: 'ok',
  ...patch,
})
const image = (n = 1) => ({ width: 800, height: 1100, units: Array.from({ length: n }, () => unit()) })

describe('ResultCache', () => {
  let dir: string
  let maxBytes: number
  let cache: ResultCache
  let clock: number

  const open = (): ResultCache => {
    const c = openResultCache(join(dir, 'cache', 'cache.db'), { getMaxBytes: () => maxBytes, logger: silentLogger, now: () => clock++ })
    if (!c) throw new Error('cache did not open')
    return c
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-cache-'))
    maxBytes = 2 * 1024 ** 3
    clock = 1000
    cache = open()
  })
  afterEach(() => {
    cache.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('returns what was stored and misses for unknown keys', () => {
    expect(cache.get('k1')).toBeNull()
    expect(cache.put('k1', 'hash1', image(2))).toBe(true)
    const hit = cache.get('k1')
    expect(hit?.width).toBe(800)
    expect(hit?.units).toHaveLength(2)
    expect(hit?.units[0]?.translation).toBe('你好')
  })

  it('stores JSON only: no image bytes or extra fields reach the file', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const polluted = { ...image(1), bytes: png, units: [{ ...unit(), ocrPng: png, secret: 'cookie=abc' }] }
    cache.put('k1', 'hash1', polluted as never)
    const stored = toCachedImage(polluted as never)
    expect(Object.keys(stored).sort()).toEqual(['height', 'units', 'v', 'width'])
    expect(Object.keys(stored.units[0] as object).sort()).toEqual(
      ['bubbleOnly', 'drawBox', 'kind', 'ocrBox', 'ocrText', 'status', 'translation'].sort(),
    )
    cache.close()
    const raw = readFileSync(join(dir, 'cache', 'cache.db')).toString('latin1')
    expect(raw).not.toContain('PNG')
    expect(raw).not.toContain('cookie=abc')
    cache = open()
  })

  it('tracks size and replaces a key without double counting', () => {
    cache.put('k1', 'h', image(1))
    const one = cache.stats()
    cache.put('k1', 'h', image(1))
    expect(cache.stats()).toEqual(one)
    cache.put('k2', 'h2', image(1))
    expect(cache.stats().entries).toBe(2)
    expect(cache.stats().bytes).toBeGreaterThan(one.bytes)
  })

  it('evicts least recently used rows down to 90 % of the cap', () => {
    cache.put('probe', 'h', image(1))
    const rowBytes = cache.stats().bytes
    cache.clear()
    maxBytes = rowBytes * 10
    for (let i = 0; i < 10; i++) cache.put(`k${i}`, `h${i}`, image(1))
    expect(cache.stats().entries).toBe(10)
    // Touch k0 so k1 becomes the oldest.
    expect(cache.get('k0')).not.toBeNull()
    cache.put('k10', 'h10', image(1))
    const stats = cache.stats()
    expect(stats.bytes).toBeLessThanOrEqual(Math.floor(maxBytes * EVICT_TARGET_RATIO))
    expect(cache.get('k10')).not.toBeNull()
    expect(cache.get('k0')).not.toBeNull()
    expect(cache.get('k1')).toBeNull()
    expect(cache.get('k2')).toBeNull()
  })

  it('never evicts the row it just wrote, and skips rows bigger than the cap', () => {
    maxBytes = 50
    expect(cache.put('big', 'h', image(3))).toBe(false)
    expect(cache.stats().entries).toBe(0)
  })

  it('does not store when the cap is 0', () => {
    maxBytes = 0
    expect(cache.put('k', 'h', image(1))).toBe(false)
  })

  it('clear deletes everything and shrinks the file', () => {
    for (let i = 0; i < 300; i++) cache.put(`k${i}`, `h${i}`, image(4))
    const before = statSync(join(dir, 'cache', 'cache.db')).size
    cache.clear()
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 })
    expect(cache.get('k1')).toBeNull()
    cache.close()
    expect(statSync(join(dir, 'cache', 'cache.db')).size).toBeLessThan(before)
    cache = open()
  })

  it('persists across reopen and recomputes the total', () => {
    cache.put('k1', 'h', image(2))
    const bytes = cache.stats().bytes
    cache.close()
    cache = open()
    expect(cache.stats()).toEqual({ entries: 1, bytes })
    expect(cache.get('k1')?.units).toHaveLength(2)
  })

  it('treats a row with an invalid payload as a miss and removes it', () => {
    cache.put('k1', 'h', image(1))
    cache.close()
    const raw = new Database(join(dir, 'cache', 'cache.db'))
    raw.prepare('UPDATE results SET payload = ?').run('{"v":2,"nope":true}')
    raw.close()
    cache = open()
    expect(cache.get('k1')).toBeNull()
    expect(cache.stats().entries).toBe(0)
  })

  it('moves an unreadable database file aside and starts empty', () => {
    cache.close()
    writeFileSync(join(dir, 'cache', 'cache.db'), 'this is not a sqlite file at all, just text'.repeat(50))
    cache = open()
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 })
    expect(cache.put('k', 'h', image(1))).toBe(true)
  })
})

describe('isCacheable', () => {
  it('caches clean results and results without text', () => {
    expect(isCacheable(image(2))).toBe(true)
    expect(isCacheable({ ...image(1), units: [unit({ status: 'no-text', ocrText: '', translation: '' })] })).toBe(true)
    expect(isCacheable({ ...image(0) })).toBe(true)
  })

  it('does not cache results with failed or echoed units', () => {
    for (const status of ['ocr-failed', 'translate-failed', 'echo'] as const) {
      expect(isCacheable({ ...image(1), units: [unit({ status })] })).toBe(false)
    }
  })
})