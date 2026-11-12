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
})
