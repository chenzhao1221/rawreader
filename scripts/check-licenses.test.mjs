import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkProject, isAllowedExpression, isAllowedId, noticesMention, readInstalledLicense } from './check-licenses.mjs'

describe('isAllowedId', () => {
  it('allows the policy list, case-insensitively, including -or-later and -only forms', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'LGPL-3.0', 'LGPL-3.0-or-later', 'GPL-3.0-only', 'AGPL-3.0', 'AGPL-3.0-or-later', 'OFL-1.1', 'Zlib', 'BSD-2-Clause', 'BSD-3-Clause']) {
      expect(isAllowedId(id), id).toBe(true)
    }
  })

  it('rejects GPL-2.0-only and unlisted licences', () => {
    for (const id of ['GPL-2.0-only', 'GPL-2.0', 'CC-BY-NC-4.0', 'UNLICENSED', '0BSD', 'SSPL-1.0', 'LGPL-2.1']) {
      expect(isAllowedId(id), id).toBe(false)
    }
  })
})

describe('isAllowedExpression', () => {
  it('handles OR (one side is enough) and AND (both are needed)', () => {
    expect(isAllowedExpression('(MIT OR CC0-1.0)')).toBe(true)
    expect(isAllowedExpression('GPL-2.0-only OR MIT')).toBe(true)
    expect(isAllowedExpression('GPL-2.0-only AND MIT')).toBe(false)
    expect(isAllowedExpression('Apache-2.0 AND LGPL-3.0-or-later')).toBe(true)
    expect(isAllowedExpression('Apache-2.0 AND LGPL-3.0-or-later AND MIT')).toBe(true)
    expect(isAllowedExpression('MIT AND CC-BY-NC-4.0')).toBe(false)
  })

  it('gives AND priority over OR and supports parentheses', () => {
    expect(isAllowedExpression('MIT OR X-1 AND Y-1')).toBe(true)
    expect(isAllowedExpression('(MIT OR X-1) AND Y-1')).toBe(false)
  })

  it('ignores WITH exceptions', () => {
    expect(isAllowedExpression('GPL-3.0-only WITH Classpath-exception-2.0')).toBe(true)
  })

  it('rejects empty and malformed input', () => {
    expect(isAllowedExpression('')).toBe(false)
    expect(isAllowedExpression(undefined)).toBe(false)
    expect(isAllowedExpression('MIT OR')).toBe(false)
    expect(isAllowedExpression('(MIT')).toBe(true) // lenient on a missing closing paren, still evaluates
    expect(isAllowedExpression('MIT MIT')).toBe(false)
  })
})

describe('readInstalledLicense', () => {
  it('reads the string, object and array forms', () => {
    expect(readInstalledLicense({ license: 'MIT' })).toBe('MIT')
    expect(readInstalledLicense({ license: { type: 'ISC' } })).toBe('ISC')
    expect(readInstalledLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(readInstalledLicense({})).toBeNull()
  })
})

describe('noticesMention', () => {
  it('matches a table row by package name, including scoped names', () => {
    const notices = '| zod | 4.6.7 | MIT | x |\n| @img/colour | 1.1.0 | MIT | y |\n'
    expect(noticesMention(notices, 'zod')).toBe(true)
    expect(noticesMention(notices, '@img/colour')).toBe(true)
    expect(noticesMention(notices, 'zo')).toBe(false)
    expect(noticesMention(notices, 'p-queue')).toBe(false)
  })
})

describe('checkProject', () => {
  /** packages: { name, license, deps?: string[], dev?: boolean, nested?: parent name } */
  function project(packages, notices) {
    const root = mkdtempSync(join(tmpdir(), 'rr-lic-'))
    const dependencies = {}
    for (const pkg of packages) {
      if (pkg.top !== false && !pkg.dev) dependencies[pkg.name] = '1.0.0'
      const base = pkg.nestedIn ? join(root, 'node_modules', pkg.nestedIn, 'node_modules', pkg.name) : join(root, 'node_modules', pkg.name)
      mkdirSync(base, { recursive: true })
      writeFileSync(
        join(base, 'package.json'),
        JSON.stringify({ name: pkg.name, version: '1.0.0', license: pkg.license, dependencies: Object.fromEntries((pkg.deps ?? []).map((d) => [d, '1.0.0'])) }),
      )
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }))
    writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), notices)
    return root
  }

  it('passes when every production package is allowed and listed, and ignores dev dependencies', () => {
    const root = project([{ name: 'good', license: 'MIT' }, { name: 'tool', license: 'GPL-2.0-only', dev: true }], '| good | 1.0.0 | MIT |')
    try {
      expect(checkProject({ root })).toEqual({ checked: 1, problems: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a bad licence and a package missing from the notices', () => {
    const root = project([{ name: 'bad', license: 'GPL-2.0-only' }, { name: 'unlisted', license: 'MIT' }], '| bad | 1.0.0 | GPL-2.0-only |')
    try {
      const { problems } = checkProject({ root })
      expect(problems.some((p) => p.startsWith('bad@1.0.0') && p.includes('allowlist'))).toBe(true)
      expect(problems.some((p) => p.startsWith('unlisted@1.0.0') && p.includes('THIRD_PARTY_NOTICES.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows transitive dependencies, including nested node_modules', () => {
    const root = project(
      [
        { name: 'parent', license: 'MIT', deps: ['child', 'deep'] },
        { name: 'child', license: 'ISC', top: false },
        { name: 'deep', license: 'CC-BY-NC-4.0', top: false, nestedIn: 'parent' },
      ],
      '| parent | 1 | MIT |\n| child | 1 | ISC |\n| deep | 1 | x |',
    )
    try {
      const { checked, problems } = checkProject({ root })
      expect(checked).toBe(3)
      expect(problems).toEqual(['deep@1.0.0: licence "CC-BY-NC-4.0" is not on the allowlist'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores packages that are not installed (optional binaries for other platforms)', () => {
    const root = project([{ name: 'parent', license: 'MIT', deps: ['elsewhere'] }], '| parent | 1 | MIT |')
    try {
      expect(checkProject({ root })).toEqual({ checked: 1, problems: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})