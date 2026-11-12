import { redactText, redactValue } from './redact'

export interface Logger {
  debug(message: string, ...meta: unknown[]): void
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Where finished (already redacted) log lines go. */
export interface LogSink {
  write(level: LogLevel, scope: string, message: string, meta: unknown[]): void
}

/** Default sink until `initLogging()` installs the file sink: plain console output. */
const consoleSink: LogSink = {
  write(level, scope, message, meta) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}`
    console[level === 'debug' ? 'log' : level](line, ...meta)
  },
}

let sink: LogSink = consoleSink

/** Replaces the active sink. `setup.ts` installs the electron-log sink; tests install a collector. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink
}

/**
 * Creates a scoped logger. Every message and meta value is redacted before it
 * reaches the sink: URLs lose query strings, cookie and authorization values
 * are replaced, data URLs are summarised.
 */
export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, meta: unknown[]): void => {
    sink.write(level, scope, redactText(message), meta.map((item) => redactValue(item)))
  }
  return {
    debug: (message, ...meta) => write('debug', message, meta),
    info: (message, ...meta) => write('info', message, meta),
    warn: (message, ...meta) => write('warn', message, meta),
    error: (message, ...meta) => write('error', message, meta),
  }
}

/** A logger that discards everything. Used in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
