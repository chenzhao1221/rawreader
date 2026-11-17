import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The extension is a separate npm package. The desktop build, type checks and tests must not pick it up.
const root = join(import.meta.dirname, '..', '..', '..')
const read = (name: string): string => readFileSync(join(root, name), 'utf8')

describe('extension/ stays outside the desktop project', () => {
  it('is not part of the root tsconfig include lists', () => {
    for (const name of ['tsconfig.node.json', 'tsconfig.web.json']) {
      const config = JSON.parse(read(name)) as { include: string[] }
      for (const entry of config.include) {
        expect(entry, `${name} include`).not.toMatch(/^(\.\/)?extension/)
        // No catch-all pattern that would walk into extension/.
        expect(entry, `${name} include`).not.toMatch(/^(\*\*|\.\/?\*|\.\/?$)/)
      }
    }
    expect(JSON.parse(read('tsconfig.json')) as { files: string[] }).toMatchObject({ files: [] })
  })

  it('is not matched by the root vitest include patterns', async () => {
    const { default: config } = await import('../../../vitest.config')
    const include = config.test?.include ?? []
    expect(include.length).toBeGreaterThan(0)
    for (const pattern of include) expect(pattern.startsWith('src/') || pattern.startsWith('scripts/'), pattern).toBe(true)
  })

  it('is not listed in the electron-builder files', () => {
    const text = read('electron-builder.config.mjs')
    const files = /files:\s*\[([\s\S]*?)\n\s*\]/.exec(text)?.[1] ?? ''
    expect(files).toContain("'out/**'")
    expect(files).not.toMatch(/extension/)
  })

  it('has its own package and lockfile, and ignores keys and build output', () => {
    expect(existsSync(join(root, 'extension', 'package.json'))).toBe(true)
    const pkg = JSON.parse(read('extension/package.json')) as { license: string; private: boolean }
    expect(pkg).toMatchObject({ license: 'AGPL-3.0-only', private: true })
    const ignore = read('extension/.gitignore')
    for (const entry of ['node_modules/', '.output/', '.wxt/', '*.pem', '*.crx']) expect(ignore).toContain(entry)
    expect(read('extension/.npmrc')).toContain('registry.npmmirror.com')
  })
})
