import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ManifestEntry } from './manifest'

/** Result of checking a model file against the manifest. */
export type FileCheck =
  | { status: 'ok' }
  | { status: 'size-mismatch'; actual: number; expected: number }
  | { status: 'hash-mismatch' }
  | { status: 'unreadable'; message: string }

/** Remembered outcome for one file: it is hashed once, and again only when size or mtime change. */
export const VerifiedEntrySchema = z.object({
  path: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  /** sha256 the file was compared against, so a changed manifest invalidates the memo. */
  expectedSha256: z.string(),
  ok: z.boolean(),
})
export type VerifiedEntry = z.infer<typeof VerifiedEntrySchema>

const MemoFileSchema = z.object({ version: z.literal(1), entries: z.array(VerifiedEntrySchema) })

export interface MemoStore {
  load(): Promise<VerifiedEntry[]>
  save(entries: VerifiedEntry[]): Promise<void>
}

/** JSON file store (`userData/models-verified.json`). Unreadable content is treated as empty. */
export function createJsonMemoStore(filePath: string): MemoStore {
  return {
    async load() {
      try {
        const parsed = MemoFileSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')))
        return parsed.success ? parsed.data.entries : []
      } catch {
        return []
      }
    },
    async save(entries) {
      await mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, entries }), 'utf8')
      await rename(tmp, filePath)
    },
  }
}

export interface VerifierDeps {
  memo: MemoStore
  /** sha256 of a file; aborts with the signal. */
  hash: (path: string, signal?: AbortSignal) => Promise<string>
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>
}

/**
 * Checks files the user supplied (or that were copied into the models folder) against the manifest.
 * The size check is immediate and needs no hashing; the sha256 runs in the background and its result is
 * remembered as `{ path, size, mtimeMs, ok }` so a multi-GB file is hashed once (design section 10).
 */
export class FileVerifier {
  private entries: Map<string, VerifiedEntry> | null = null
  private readonly inFlight = new Map<string, Promise<FileCheck>>()
  private readonly statFn: NonNullable<VerifierDeps['stat']>

  constructor(private readonly deps: VerifierDeps) {
    this.statFn = deps.stat ?? (async (path) => {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    })
  }

  private async memo(): Promise<Map<string, VerifiedEntry>> {
    if (!this.entries) this.entries = new Map((await this.deps.memo.load()).map((e) => [e.path, e]))
    return this.entries
  }

  /** Size only. Cheap enough to run synchronously with a UI action. */
  async checkSize(entry: Pick<ManifestEntry, 'size'>, path: string): Promise<FileCheck> {
    try {
      const { size } = await this.statFn(path)
      return size === entry.size ? { status: 'ok' } : { status: 'size-mismatch', actual: size, expected: entry.size }
    } catch (error) {
      return { status: 'unreadable', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Returns the remembered result when the file is unchanged, else null. */
  async remembered(entry: Pick<ManifestEntry, 'size' | 'sha256'>, path: string): Promise<FileCheck | null> {
    try {
      const { size, mtimeMs } = await this.statFn(path)
      const known = (await this.memo()).get(path)
      if (known && known.size === size && known.mtimeMs === mtimeMs && known.expectedSha256 === entry.sha256) {
        return known.ok ? { status: 'ok' } : { status: 'hash-mismatch' }
      }
    } catch {
      return null
    }
    return null
  }

  /** Size, then memo, then a full hash. Calls for the same path share one run. */
  check(entry: Pick<ManifestEntry, 'size' | 'sha256'>, path: string, signal?: AbortSignal): Promise<FileCheck> {
    const existing = this.inFlight.get(path)
    if (existing) return existing
    const run = this.run(entry, path, signal).finally(() => this.inFlight.delete(path))
    this.inFlight.set(path, run)
    return run
  }

  private async run(entry: Pick<ManifestEntry, 'size' | 'sha256'>, path: string, signal?: AbortSignal): Promise<FileCheck> {
    const sizeCheck = await this.checkSize(entry, path)
    if (sizeCheck.status !== 'ok') return sizeCheck
    const remembered = await this.remembered(entry, path)
    if (remembered) return remembered
    try {
      const before = await this.statFn(path)
      const digest = await this.deps.hash(path, signal)
      const ok = digest === entry.sha256
      const memo = await this.memo()
      memo.set(path, { path, size: before.size, mtimeMs: before.mtimeMs, expectedSha256: entry.sha256, ok })
      await this.deps.memo.save([...memo.values()]).catch(() => {})
      return ok ? { status: 'ok' } : { status: 'hash-mismatch' }
    } catch (error) {
      return { status: 'unreadable', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Records a file that was just downloaded and verified by the downloader, so it is not hashed again. */
  async markVerified(entry: Pick<ManifestEntry, 'size' | 'sha256'>, path: string): Promise<void> {
    try {
      const { size, mtimeMs } = await this.statFn(path)
      const memo = await this.memo()
      memo.set(path, { path, size, mtimeMs, expectedSha256: entry.sha256, ok: true })
      await this.deps.memo.save([...memo.values()])
    } catch {
      // Not remembering is harmless: the file is hashed on the next check.
    }
  }
}