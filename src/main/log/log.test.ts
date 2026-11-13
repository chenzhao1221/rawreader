import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, setLogSink } from './log'

describe('createLogger', () => {
  afterEach(() => setLogSink(null))

  it('redacts messages and meta before they reach the sink', () => {
    const lines: Array<{ level: string; scope: string; message: string; meta: unknown[] }> = []
    setLogSink({ write: (level, scope, message, meta) => lines.push({ level, scope, message, meta }) })

    const log = createLogger('capture')
    log.warn('fetch failed for https://cdn.example.com/p/1.jpg?token=SECRET', {
      headers: { Cookie: 'sid=1' },
      referer: 'https://site.example/read?id=9',
    })

    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line?.scope).toBe('capture')
    expect(line?.level).toBe('warn')
    expect(JSON.stringify(line)).not.toContain('SECRET')
    expect(JSON.stringify(line)).not.toContain('sid=1')
    expect(JSON.stringify(line)).not.toContain('id=9')
  })

  it('never writes a full page URL when a config:update result or error is logged', () => {
    const lines: string[] = []
    setLogSink({ write: (level, scope, message, meta) => lines.push(JSON.stringify({ level, scope, message, meta })) })
    const pageUrl = 'https://example.com/secret/chapter/99?x=1#p2'
    const log = createLogger('ipc')

    // The effective config returned by config:update carries the last visited page in ui.lastUrl.
    const result = { ok: true, value: { ui: { autoTranslate: true, lastUrl: pageUrl } } }
    log.debug('config:update result', result)
    log.info('config:update result ' + JSON.stringify(result))
    log.error('Handler for "config:update" failed: ' + new Error('bad page ' + pageUrl).message, new Error(pageUrl))
    log.warn('navigated', { pageUrl, referer: pageUrl })

    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(line).not.toContain('/secret')
      expect(line).not.toContain('chapter/99')
      expect(line).not.toContain('x=1')
      expect(line).not.toContain('#p2')
      expect(line).not.toContain(pageUrl)
      // The origin is still there, which is what we want to keep for debugging.
      expect(line).toContain('https://example.com/')
    }
  })
})
