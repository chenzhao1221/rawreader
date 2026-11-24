/**
 * Headless module-resolution check for a packed app.asar.
 * Run with Electron as Node so asar + asar.unpacked are visible:
 *
 *   ELECTRON_RUN_AS_NODE=1 RawReader.exe scripts/verify-asar-modules.mjs <path-to-app.asar>
 *
 * Does not load out/main/index.js (that would start the app and may open windows).
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const asar = process.argv[2]
if (!asar) {
  console.error('Usage: ELECTRON_RUN_AS_NODE=1 RawReader.exe scripts/verify-asar-modules.mjs <app.asar>')
  process.exit(2)
}
if (!fs.existsSync(asar)) {
  console.error('app.asar not found:', asar)
  process.exit(2)
}

const asarPkg = path.join(asar, 'package.json')
const req = createRequire(asarPkg)
const builtins = new Set(builtinModules)
const rootPkg = JSON.parse(fs.readFileSync(asarPkg, 'utf8'))

function findPkgDir(name, fromFile) {
  const r = createRequire(fromFile)
  for (const spec of [`${name}/package.json`, name]) {
    try {
      const resolved = r.resolve(spec)
      if (spec.endsWith('/package.json')) return path.dirname(resolved)
      let dir = path.dirname(resolved)
      while (true) {
        const pj = path.join(dir, 'package.json')
        if (fs.existsSync(pj)) {
          try {
            if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return dir
          } catch {}
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {}
  }
  let dir = path.dirname(fromFile)
  while (true) {
    const cand = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const needed = new Map()
const missing = []

function walk(name, fromFile, via) {
  if (!name || builtins.has(name) || name.startsWith('node:')) return
  if (needed.has(name)) return
  const dir = findPkgDir(name, fromFile)
  if (!dir) {
    missing.push({ name, via })
    return
  }
  needed.set(name, dir)
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const next = path.join(dir, 'package.json')
  for (const dep of Object.keys(j.dependencies || {})) walk(dep, next, name)
  for (const dep of Object.keys(j.optionalDependencies || {})) {
    if (findPkgDir(dep, next)) walk(dep, next, `${name} (optional)`)
  }
}

for (const name of Object.keys(rootPkg.dependencies || {})) walk(name, asarPkg, 'package.json')

if (missing.length) {
  console.error('ERR_MODULE_NOT_FOUND (resolve):')
  for (const m of missing) console.error(`  - ${m.name} (via ${m.via})`)
  process.exit(1)
}

const importFailures = []
const toImport = [
  '@ghostery/adblocker-electron',
  'tldts-experimental',
  'sharp',
  'onnxruntime-node',
  'better-sqlite3',
  'zod',
  'p-queue',
  'electron-store',
  'electron-log',
]

for (const name of toImport) {
  try {
    let href
    try {
      href = pathToFileURL(req.resolve(name)).href
    } catch {
      const pj = req.resolve(`${name}/package.json`)
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
      const entry = j.module || j.main || (j.exports && j.exports['.'])
      const entryPath = typeof entry === 'string' ? entry : entry && (entry.import || entry.require || entry.default)
      if (!entryPath || typeof entryPath !== 'string') {
        console.log('SKIP import (no entry)', name)
        continue
      }
      href = pathToFileURL(path.join(path.dirname(pj), entryPath)).href
    }
    await import(href)
    console.log('OK import', name)
  } catch (e) {
    importFailures.push({ name, step: 'import', error: e && e.stack ? e.stack : String(e) })
    console.error('FAIL import', name, e)
  }
}

if (importFailures.length) {
  console.error('ERR_MODULE_NOT_FOUND or import failure:')
  for (const f of importFailures) console.error(`  - ${f.name} [${f.step}] ${f.error}`)
  process.exit(1)
}

console.log('verify-asar-modules: ok,', needed.size, 'packages resolved; entry imports succeeded')
process.exit(0)
