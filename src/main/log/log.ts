export interface Logger {
  debug(message: string, ...meta: unknown[]): void
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

/**
 * Minimal console logger for the skeleton. A later slice replaces the body with
 * electron-log plus a redaction filter. Callers must never pass cookies, auth
 * headers or URLs with query strings.
 */
export function createLogger(scope: string): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta: unknown[]): void => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}`
    console[level === 'debug' ? 'log' : level](line, ...meta)
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
