import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024

/**
 * Append-only log file with one rotated generation (`<file>.1`). When a write
 * would push the file past `maxBytes`, the current file replaces `<file>.1`
 * and a new file is started. Writes are synchronous: llama-server output is
 * low volume and this keeps ordering and shutdown simple.
 */
export class RotatingLog {
  private size: number

  constructor(
    private readonly path: string,
    private readonly maxBytes: number = DEFAULT_MAX_LOG_BYTES,
  ) {
    mkdirSync(dirname(path), { recursive: true })
    this.size = existsSync(path) ? statSync(path).size : 0
  }

  write(chunk: Buffer | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (data.length === 0) return
    if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotate()
    appendFileSync(this.path, data)
    this.size += data.length
  }

  private rotate(): void {
    const rotated = `${this.path}.1`
    rmSync(rotated, { force: true })
    renameSync(this.path, rotated)
    this.size = 0
  }
}
