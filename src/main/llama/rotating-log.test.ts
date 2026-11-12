import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RotatingLog } from './rotating-log'

describe('RotatingLog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-log-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends and creates missing folders', () => {
    const path = join(dir, 'sub', 'llama-ocr.log')
    const log = new RotatingLog(path, 100)
    log.write('hello ')
    log.write(Buffer.from('world'))
    expect(readFileSync(path, 'utf8')).toBe('hello world')
  })

  it('rotates to <file>.1 when the cap would be exceeded and keeps a single old generation', () => {
    const path = join(dir, 'llama-ocr.log')
    const log = new RotatingLog(path, 20)
    log.write('aaaaaaaaaaaa') // 12
    log.write('bbbbbbbbbbbb') // would be 24 -> rotate
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('aaaaaaaaaaaa')
    expect(readFileSync(path, 'utf8')).toBe('bbbbbbbbbbbb')
    log.write('cccccccccccc') // rotate again, replacing .1
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('bbbbbbbbbbbb')
    expect(readFileSync(path, 'utf8')).toBe('cccccccccccc')
    expect(existsSync(`${path}.2`)).toBe(false)
  })

  it('continues from the size of an existing file', () => {
    const path = join(dir, 'llama-ocr.log')
    new RotatingLog(path, 20).write('xxxxxxxxxxxxxxx') // 15
    const second = new RotatingLog(path, 20)
    second.write('yyyyyyyyyy') // 25 -> rotate
    expect(statSync(`${path}.1`).size).toBe(15)
    expect(readFileSync(path, 'utf8')).toBe('yyyyyyyyyy')
  })
})
