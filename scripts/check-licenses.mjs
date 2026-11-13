// Licence gate for production dependencies (requirements R15.6, tech.md "Dependency policy").
//
//   node scripts/check-licenses.mjs
//
// Walks the installed production dependency tree (package.json dependencies, recursively) and fails (exit 1) when
// a licence expression is not on the allowlist or when a package is missing from THIRD_PARTY_NOTICES.md.
// Dev dependencies and optional binaries for other platforms are not part of that tree.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Normalised SPDX ids that are allowed. `BSD-*` is handled by prefix. MPL-2.0 (file-level copyleft, GPL-compatible
 * through its section 3.3) is allowed for the Ghostery ad blocker, used unmodified. */
export const ALLOWED = new Set(['MIT', 'ISC', 'APACHE-2.0', 'LGPL-3.0', 'GPL-3.0', 'AGPL-3.0', 'OFL-1.1', 'ZLIB', 'MPL-2.0'])
/** Forbidden even though a looser rule might match (tech.md: GPL-2.0-only is forbidden). */
export const FORBIDDEN = new Set(['GPL-2.0', 'GPL-2.0-ONLY'])

/** `LGPL-3.0-or-later` -> `LGPL-3.0`, `Apache-2.0` -> `APACHE-2.0`; `GPL-2.0-only` stays `GPL-2.0-ONLY`. */
export function normalizeId(id) {
  const upper = id.trim().toUpperCase()
  if (FORBIDDEN.has(upper)) return upper
  return upper.replace(/-OR-LATER$/, '').replace(/-ONLY$/, '').replace(/\+$/, '')
}

export function isAllowedId(id) {
  const normalized = normalizeId(id)
  if (FORBIDDEN.has(normalized)) return false
  return ALLOWED.has(normalized) || normalized.startsWith('BSD-')
}

/** Splits an SPDX expression into `(`, `)`, `AND`, `OR` and ids. `X WITH exception` keeps only `X`. */
function tokenize(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toUpperCase() === 'WITH') {
      i++ // skip the exception id
      continue
    }
    out.push(tokens[i])
  }
  return out
}

/**
 * Evaluates an SPDX expression: `A OR B` needs one allowed side, `A AND B` needs both, parentheses group,
 * AND binds tighter than OR. An empty or malformed expression is not allowed.
 */
export function isAllowedExpression(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return false
  const tokens = tokenize(expression)
  let pos = 0
  const parseOr = () => {
    let value = parseAnd()
    while (tokens[pos]?.toUpperCase() === 'OR') {
      pos++
      const rhs = parseAnd()
      value = value || rhs
    }
    return value
  }
  const parseAnd = () => {
    let value = parsePrimary()
    while (tokens[pos]?.toUpperCase() === 'AND') {
      pos++
      const rhs = parsePrimary()
      value = value && rhs
    }
    return value
  }
  const parsePrimary = () => {
    const token = tokens[pos++]
    if (token === undefined) return false
    if (token === '(') {
      const value = parseOr()
      if (tokens[pos] === ')') pos++
      return value
    }
    return isAllowedId(token)
  }
  const result = parseOr()
  return pos === tokens.length ? result : false
}

/** Licence string of an installed package, from its package.json. */
export function readInstalledLicense(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l) => l.type ?? l).join(' OR ')
  return null
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when the notices file has a table row that starts with this package name. */
export function noticesMention(notices, name) {
  return new RegExp(`\\|\\s*${escapeRegExp(name)}\\s*\\|`).test(notices)
}

/** Finds `<name>` the way Node resolves it: in `<dir>/node_modules`, then in each parent folder up to the root. */
function resolveInstalled(fromDir, name, root) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root || dirname(dir) === dir) return null
    dir = dirname(dir)
  }
}

/**
 * Walks the production dependency closure from the root package.json through the INSTALLED tree
 * (`dependencies` plus `optionalDependencies` that are present). Dev dependencies and optional
 * binaries for other platforms are not part of it, so they are neither checked nor shipped.
 * @returns {Map<string, { name: string, version: string, license: string | null }>} keyed by package dir
 */
export function productionClosure(root) {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const found = new Map()
  const queue = Object.keys(rootManifest.dependencies ?? {}).map((name) => ({ name, from: root }))
  while (queue.length > 0) {
    const { name, from } = queue.pop()
    const dir = resolveInstalled(from, name, root)
    if (!dir || found.has(dir)) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    found.set(dir, { name: manifest.name ?? name, version: manifest.version ?? '?', license: readInstalledLicense(manifest) })
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) }
    for (const dep of Object.keys(deps)) queue.push({ name: dep, from: dir })
  }
  return found
}

/**
 * Checks the production dependency closure against the allowlist and THIRD_PARTY_NOTICES.md.
 * @param {{ root: string }} options
 * @returns {{ checked: number, problems: string[] }}
 */
export function checkProject({ root }) {
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const problems = []
  const closure = productionClosure(root)
  const listed = new Set()
  for (const pkg of closure.values()) {
    if (!isAllowedExpression(pkg.license ?? '')) {
      problems.push(`${pkg.name}@${pkg.version}: licence "${pkg.license ?? 'unknown'}" is not on the allowlist`)
    }
    if (!listed.has(pkg.name)) {
      listed.add(pkg.name)
      if (!noticesMention(notices, pkg.name)) problems.push(`${pkg.name}@${pkg.version}: missing from THIRD_PARTY_NOTICES.md`)
    }
  }
  return { checked: closure.size, problems }
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { checked, problems } = checkProject({ root })
  if (problems.length > 0) {
    console.error(`Licence check failed (${problems.length} problem(s)):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`Licence check passed: ${checked} production package(s) checked.`)
}
