import { mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { HistoryEntry, HistoryList } from '../../shared/ipc/contract'
import type { Logger } from '../log/log'
import {
  HISTORY_DUPLICATE_WINDOW_MS,
  HISTORY_MAX_ENTRIES,
  HISTORY_SAME_CHAPTER_WINDOW_MS,
  cleanTouch,
  searchWords,
} from './record'
import type { CleanTouch, HistoryTouch } from './record'

export interface HistoryStoreOptions {
  logger: Logger
  /** Clock, injected in tests. */
  now?: () => number
  /** Entry cap; the entries with the oldest last visit go first. */
  maxEntries?: number
}

interface Row {
  id: number
  url: string
  title: string
  site: string
  series: string
  chapter: string
  first_at: number
  last_at: number
  visits: number
}

const toEntry = (row: Row): HistoryEntry => ({
  id: row.id,
  url: row.url,
  title: row.title,
  site: row.site,
  series: row.series,
  chapter: row.chapter,
  firstVisitedAt: row.first_at,
  lastVisitedAt: row.last_at,
  visits: row.visits,
})

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Escapes LIKE wildcards so a search for "100%" finds the text. */
const likePattern = (word: string): string => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * The reading history: one SQLite row per page address (or per chapter, for sites that tell series and chapter).
 * It lives in the app's own data folder and never leaves the machine. Every method swallows SQLite errors: a
 * broken history must never get in the way of reading.
 */
export class HistoryStore {
  private closed = false

  constructor(
    private readonly db: Database.Database,
    private readonly options: HistoryStoreOptions,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        site TEXT NOT NULL,
        series TEXT NOT NULL,
        chapter TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        visits INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_last ON history(last_at);
    `)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Records one visit. Returns true when the stored data changed. */
  touch(input: HistoryTouch): boolean {
    return this.touchMany([input]) > 0
  }

  /** Records visits in one transaction. Returns how many changed the stored data or were new. */
  touchMany(inputs: readonly HistoryTouch[]): number {
    if (this.closed) return 0
    const now = this.now()
    const cleaned = inputs.map((input) => cleanTouch(input, now)).filter((c): c is CleanTouch => c !== null)
    if (cleaned.length === 0) return 0
    try {
      let changed = 0
      this.db.transaction(() => {
        // Oldest first, so a backlog from the extension ends with the right last-visit time.
        for (const clean of [...cleaned].sort((a, b) => a.at - b.at)) if (this.apply(clean)) changed++
        this.trim()
      })()
      return changed
    } catch (error) {
      this.options.logger.warn(`History write failed: ${describe(error)}`)
      return 0
    }
  }

  private apply(c: CleanTouch): boolean {
    const same = this.db.prepare('SELECT * FROM history WHERE url = ?').get(c.url) as Row | undefined
    if (same) return this.updateSame(same, c)
    // A refresh completes an entry that exists; it never brings back one the user deleted.
    if (c.refresh) return false
    const chapter = c.series && c.chapter
      ? (this.db
          .prepare('SELECT * FROM history WHERE site = ? AND series = ? AND chapter = ? AND ABS(? - last_at) <= ? ORDER BY last_at DESC LIMIT 1')
          .get(c.site, c.series, c.chapter, c.at, HISTORY_SAME_CHAPTER_WINDOW_MS) as Row | undefined)
      : undefined
    if (chapter) {
      this.db
        .prepare('UPDATE history SET url = ?, title = ?, last_at = MAX(last_at, ?), visits = visits + 1 WHERE id = ?')
        .run(c.url, c.title || chapter.title, c.at, chapter.id)
      return true
    }
    this.db
      .prepare('INSERT INTO history (url, title, site, series, chapter, first_at, last_at, visits) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(c.url, c.title, c.site, c.series, c.chapter, c.at, c.at)
    return true
  }

  private updateSame(row: Row, c: CleanTouch): boolean {
    const newTitle = c.title && c.title !== row.title ? c.title : row.title
    const newSeries = c.series || row.series
    const newChapter = c.chapter || row.chapter
    const countsAsVisit = !c.refresh && c.at - row.last_at >= HISTORY_DUPLICATE_WINDOW_MS
    if (!countsAsVisit) {
      if (newTitle === row.title && newSeries === row.series && newChapter === row.chapter) return false
      this.db.prepare('UPDATE history SET title = ?, series = ?, chapter = ? WHERE id = ?').run(newTitle, newSeries, newChapter, row.id)
      return true
    }
    this.db
      .prepare('UPDATE history SET title = ?, series = ?, chapter = ?, last_at = ?, visits = visits + 1 WHERE id = ?')
      .run(newTitle, newSeries, newChapter, c.at, row.id)
    return true
  }

  private trim(): void {
    const max = this.options.maxEntries ?? HISTORY_MAX_ENTRIES
    this.db.prepare('DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY last_at DESC, id DESC LIMIT -1 OFFSET ?)').run(max)
  }

  /** Newest first. Every word of `query` has to appear in the title, address, site or series. */
  list(query: string, limit: number, offset: number): HistoryList {
    if (this.closed) return { entries: [], total: 0 }
    try {
      const words = searchWords(query)
      const where = words.map(() => "(lower(title || ' ' || url || ' ' || site || ' ' || series) LIKE ? ESCAPE '\\')").join(' AND ')
      const clause = where ? `WHERE ${where}` : ''
      const params = words.map(likePattern)
      const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM history ${clause}`).get(...params) as { n: number }).n
      const rows = this.db
        .prepare(`SELECT * FROM history ${clause} ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Row[]
      return { entries: rows.map(toEntry), total }
    } catch (error) {
      this.options.logger.warn(`History read failed: ${describe(error)}`)
      return { entries: [], total: 0 }
    }
  }

  count(): number {
    return this.list('', 1, 0).total
  }

  /** Deletes one entry. Returns the number of entries left. */
  remove(id: number): number {
    if (!this.closed) {
      try {
        this.db.prepare('DELETE FROM history WHERE id = ?').run(id)
      } catch (error) {
        this.options.logger.warn(`History delete failed: ${describe(error)}`)
      }
    }
    return this.count()
  }

  /** Deletes everything and shrinks the file. */
  clear(): void {
    if (this.closed) return
    try {
      this.db.exec('DELETE FROM history')
      this.db.exec('VACUUM')
    } catch (error) {
      this.options.logger.warn(`History clear failed: ${describe(error)}`)
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

/**
 * Opens (creating if needed) the history database at `dbPath`. A file that cannot be opened is moved aside once
 * and recreated. Returns `null` when the history cannot be used at all (the app runs without it).
 */
export function openHistoryStore(dbPath: string, options: HistoryStoreOptions): HistoryStore | null {
  mkdirSync(dirname(dbPath), { recursive: true })
  const attempt = (): HistoryStore => {
    const db = new Database(dbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      return new HistoryStore(db, options)
    } catch (error) {
      db.close()
      throw error
    }
  }
  try {
    return attempt()
  } catch (first) {
    options.logger.warn(`History database unusable (${describe(first)}); moving it aside and starting empty`)
    try {
      renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`)
      return attempt()
    } catch (second) {
      options.logger.error(`History disabled: ${describe(second)}`)
      return null
    }
  }
}
