import { join } from 'node:path'
import electronLog from 'electron-log/main'
import { setLogSink } from './log'
import { redactValue } from './redact'

/** Size at which electron-log rotates `main.log` to `main.old.log`. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

export const MAIN_LOG_FILE = 'main.log'

/**
 * Installs the electron-log sink: rotating file under `logsDir` plus console.
 * Call once, after `app.setPath('userData', ...)`. Messages are already
 * redacted by `createLogger`; the hook below is a second line of defence for
 * anything written to electron-log directly (for example caught exceptions).
 */
export function initLogging(logsDir: string): void {
  const file = electronLog.transports.file
  file.resolvePathFn = () => join(logsDir, MAIN_LOG_FILE)
  file.maxSize = LOG_MAX_BYTES
  file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} {level} {scope} {text}'
  file.level = 'debug'
  electronLog.transports.console.level = 'debug'

  electronLog.hooks.push((message) => ({
    ...message,
    data: message.data.map((item: unknown) => redactValue(item)),
  }))

  setLogSink({
    write(level, scope, message, meta) {
      electronLog.scope(scope)[level](message, ...meta)
    },
  })
}

/** Folder that holds the app log files (shared with the llama-server logs). */
export function logsDirFor(userDataDir: string): string {
  return join(userDataDir, 'logs')
}
