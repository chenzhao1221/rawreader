import { mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { Logger } from '../log/log'
import type { ImageResult } from '../pipeline/types'

const BboxSchema = z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), confidence: z.number() })

const UnitSchema = z.object({
  kind: z.enum(['bubble', 'free']),
  bubbleOnly: z.boolean(),
  drawBox: BboxSchema,
  ocrBox: BboxSchema,
  ocrText: z.string(),
  translation: z.string(),
  status: z.enum(['ok', 'no-text', 'ocr-failed', 'translate-failed', 'echo']),
})

/** What is stored per image: boxes, OCR text, translation, flags and the natural size. Never image bytes. */
export const CachedImageSchema = z.object({
  v: z.literal(1),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  units: z.array(UnitSchema),
})
export type CachedImage = z.infer<typeof CachedImageSchema>

export type CachedImageInput = Pick<ImageResult, 'width' | 'height' | 'units'>

/** Fraction of the cap the cache is trimmed to when an insert pushes it over (design section 12). */
export const EVICT_TARGET_RATIO = 0.9

/** Per-row bookkeeping added to the payload size (key, hash, three integers, index entry). */
const ROW_OVERHEAD_BYTES = 160

/** A result is stored only when no unit failed, so a later visit can retry failures instead of replaying them. */
export function isCacheable(result: CachedImageInput): boolean {
  return result.units.every((unit) => unit.status === 'ok' || unit.status === 'no-text')
}

/** Builds the JSON payload. Only whitelisted fields are copied, so nothing else can leak into the file. */
export function toCachedImage(result: CachedImageInput): CachedImage {
  return {
    v: 1,
    width: result.width,
    height: result.height,
    units: result.units.map((unit) => ({
      kind: unit.kind,
      bubbleOnly: unit.bubbleOnly,
      drawBox: { ...unit.drawBox },
      ocrBox: { ...unit.ocrBox },
      ocrText: unit.ocrText,
      translation: unit.translation,
      status: unit.status,
    })),
  }
}

export interface ResultCacheOptions {
  /** Current cap in bytes; read on every insert so a settings change applies at once. 0 disables storing. */
  getMaxBytes: () => number
  logger: Logger
  /** Monotonic clock for LRU order. Injected in tests. */
  now?: () => number
}

export interface CacheStats {
  entries: number
  bytes: number
}

/**
 * SQLite result cache (design section 12): one JSON row per (image content, language, models, prompt).
 * LRU by `last_access`. Inserting past the cap evicts the least recently used rows until the total is
 * under 90 % of the cap. Every method swallows SQLite errors and degrades to "no cache": a broken cache must
 * never fail an image.
 */
export class ResultCache {
  private totalBytes = 0
  private lastTick = 0
  private closed = false

  constructor(
    private readonly db: Database.Database,
    private readonly options: ResultCacheOptions,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        key TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_access INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS results_lru ON results(last_access);
    `)
    this.totalBytes = this.sumBytes()
  }

  /** Strictly increasing time value, so two operations in the same millisecond keep their order. */
  private tick(): number {
    const now = (this.options.now ?? Date.now)()
    this.lastTick = Math.max(now, this.lastTick + 1)
    return this.lastTick
  }

  private sumBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM results').get() as { total: number }
    return row.total
  }

  get(key: string): CachedImage | null {
    if (this.closed) return null
    try {
      const row = this.db.prepare('SELECT payload FROM results WHERE key = ?').get(key) as { payload: string } | undefined
      if (!row) return null
      const parsed = CachedImageSchema.safeParse(JSON.parse(row.payload))
      if (!parsed.success) {
        this.deleteKey(key)
        return null
      }
      this.db.prepare('UPDATE results SET last_access = ? WHERE key = ?').run(this.tick(), key)
      return parsed.data
    } catch (error) {
      this.options.logger.warn(`Cache read failed: ${describe(error)}`)
      return null
    }
  }

  put(key: string, contentHash: string, result: CachedImageInput): boolean {
    const maxBytes = this.options.getMaxBytes()
    if (this.closed || maxBytes <= 0) return false
    try {
      const payload = JSON.stringify(toCachedImage(result))
      const bytes = Buffer.byteLength(payload) + Buffer.byteLength(key) + ROW_OVERHEAD_BYTES
      if (bytes > maxBytes) return false
      const now = this.tick()
      const write = this.db.transaction(() => {
        const previous = this.db.prepare('SELECT bytes FROM results WHERE key = ?').get(key) as { bytes: number } | undefined
        if (previous) this.totalBytes -= previous.bytes
        this.db
          .prepare(
            `INSERT INTO results (key, content_hash, payload, bytes, created_at, last_access)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, bytes = excluded.bytes, last_access = excluded.last_access`,
          )
          .run(key, contentHash, payload, bytes, now, now)
        this.totalBytes += bytes
        if (this.totalBytes > maxBytes) this.evict(Math.floor(maxBytes * EVICT_TARGET_RATIO), key)
      })
      write()
      return true
    } catch (error) {
      this.options.logger.warn(`Cache write failed: ${describe(error)}`)
      return false
    }
  }

  /** Deletes least recently used rows until the total is at most `target`. The row just written is kept. */
  private evict(target: number, keep: string): void {
    const select = this.db.prepare('SELECT key, bytes FROM results WHERE key != ? ORDER BY last_access ASC, rowid ASC LIMIT 200')
    const remove = this.db.prepare('DELETE FROM results WHERE key = ?')
    let removed = 0
    while (this.totalBytes > target) {
      const batch = select.all(keep) as Array<{ key: string; bytes: number }>
      if (batch.length === 0) break
      for (const row of batch) {
        remove.run(row.key)
        this.totalBytes -= row.bytes
        removed++
        if (this.totalBytes <= target) break
      }
    }
    if (removed > 0) this.options.logger.info(`Cache evicted ${removed} entries; now ${this.totalBytes} bytes`)
  }

  private deleteKey(key: string): void {
    const row = this.db.prepare('SELECT bytes FROM results WHERE key = ?').get(key) as { bytes: number } | undefined
    if (!row) return
    this.db.prepare('DELETE FROM results WHERE key = ?').run(key)
    this.totalBytes -= row.bytes
  }

  stats(): CacheStats {
    if (this.closed) return { entries: 0, bytes: 0 }
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS entries FROM results').get() as { entries: number }
      return { entries: row.entries, bytes: this.totalBytes }
    } catch {
      return { entries: 0, bytes: 0 }
    }
  }

  /** "Clear cache": delete every row, then VACUUM so the file shrinks. */
  clear(): void {
    if (this.closed) return
    try {
      this.db.exec('DELETE FROM results')
      this.db.exec('VACUUM')
      this.totalBytes = 0
    } catch (error) {
      this.options.logger.warn(`Cache clear failed: ${describe(error)}`)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Opens (creating if needed) the cache database at `dbPath` in WAL mode. A file that cannot be opened is
 * moved aside once and recreated. Returns `null` when the cache cannot be used at all (the app runs without it).
 */
export function openResultCache(dbPath: string, options: ResultCacheOptions): ResultCache | null {
  mkdirSync(dirname(dbPath), { recursive: true })
  const attempt = (): ResultCache => {
    const db = new Database(dbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      return new ResultCache(db, options)
    } catch (error) {
      db.close()
      throw error
    }
  }
  try {
    return attempt()
  } catch (first) {
    options.logger.warn(`Cache database unusable (${describe(first)}); moving it aside and starting empty`)
    try {
      renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`)
      return attempt()
    } catch (second) {
      options.logger.error(`Cache disabled: ${describe(second)}`)
      return null
    }
  }
}