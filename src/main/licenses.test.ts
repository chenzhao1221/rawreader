import { describe, expect, it } from 'vitest'
import { licenseSources, loadLicenses } from './licenses'

describe('licenseSources', () => {
  it('reads from the repository in dev', () => {
    const sources = licenseSources({ isPackaged: false, appPath: 'C:\\repo', resourcesPath: 'C:\\x' })
    expect(sources.map((s) => s.id)).toEqual(['app', 'notices', 'font'])
    expect(sources[0]?.path).toBe('C:\\repo\\LICENSE')
    expect(sources[2]?.path).toBe('C:\\repo\\resources\\fonts\\OFL.txt')
  })

  it('reads from resources/licenses when packaged', () => {
    const sources = licenseSources({ isPackaged: true, appPath: 'C:\\app.asar', resourcesPath: 'C:\\Apps\\RawReader\\resources' })
    expect(sources.map((s) => s.path)).toEqual([
      'C:\\Apps\\RawReader\\resources\\licenses\\LICENSE',
      'C:\\Apps\\RawReader\\resources\\licenses\\THIRD_PARTY_NOTICES.md',
      'C:\\Apps\\RawReader\\resources\\licenses\\NotoSansSC-OFL.txt',
    ])
  })
})

describe('loadLicenses', () => {
  it('returns the text and a note for missing files', async () => {
    const result = await loadLicenses(
      [
        { id: 'a', title: 'A', path: 'a.txt' },
        { id: 'b', title: 'B', path: 'b.txt' },
      ],
      (path) => (path === 'a.txt' ? Promise.resolve('AAA') : Promise.reject(new Error('ENOENT'))),
    )
    expect(result.documents[0]).toEqual({ id: 'a', title: 'A', text: 'AAA' })
    expect(result.documents[1]?.text).toContain('File not found')
  })
})