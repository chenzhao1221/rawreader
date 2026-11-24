/**
 * Production node_modules file specs for electron-builder.
 *
 * app-directapi/node_modules is a junction to ../app/node_modules. electron-builder default
 * dependency walker realpaths those packages outside the project dir and drops them
 * (build log: cannot find path for dependency at undefined).
 *
 * asarUnpack filters also run on the source path relative to the project dir, so a
 * FileSet from path that has already been realpathed to ../app/node_modules never matches
 * the @img glob. Sharp .node + libvips DLLs then stay inside the asar and fail to load
 * on Windows (extracted to a temp file without sibling DLLs).
 *
 * Fix: copy the resolved production tree into pack-app/node_modules inside this
 * project, FileSet from there, and let asarUnpack move native addons into
 * app.asar.unpacked before asar integrity is written.
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stageRoot = path.join(root, 'pack-app', 'node_modules')
const builtins = new Set(builtinModules)

function findPkgDir(name, fromFile) {
  const req = createRequire(fromFile)
  for (const spec of [`${name}/package.json`, name]) {
    try {
      const resolved = req.resolve(spec)
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

const FILTER = [
  '**/*',
  '!**/README.md',
  '!**/readme.md',
  '!**/CHANGELOG.md',
  '!**/changelog.md',
  '!**/docs/**',
  '!**/doc/**',
  '!**/test/**',
  '!**/tests/**',
  '!**/__tests__/**',
  '!**/*.map',
]

function collectProdPackages() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const rootPkgFile = path.join(root, 'package.json')
  /** @type {Map<string, string>} */
  const found = new Map()
  const missing = []

  function walk(name, fromFile, via) {
    if (!name || builtins.has(name) || name.startsWith('node:')) return
    if (found.has(name)) return
    const dir = findPkgDir(name, fromFile)
    if (!dir) {
      missing.push({ name, via })
      return
    }
    found.set(name, dir)
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const next = path.join(dir, 'package.json')
    for (const dep of Object.keys(j.dependencies || {})) walk(dep, next, name)
    for (const dep of Object.keys(j.optionalDependencies || {})) {
      if (findPkgDir(dep, next)) walk(dep, next, `${name} (optional)`)
    }
  }

  for (const name of Object.keys(rootPkg.dependencies || {})) walk(name, rootPkgFile, 'package.json')

  const requiredMissing = missing.filter(({ name }) => !name.startsWith('@img/sharp-') && name !== '@img/sharp-libvips-dev')
  if (requiredMissing.length) {
    throw new Error(
      'Could not resolve production dependencies to pack: ' +
        requiredMissing.map((m) => `${m.name} (via ${m.via})`).join(', '),
    )
  }
  return found
}

function filtersFor(name) {
  const f = [...FILTER]
  if (name === 'better-sqlite3') {
    f.push(
      '!prebuilds/darwin-arm64.node',
      '!prebuilds/darwin-x64.node',
      '!prebuilds/linux-arm64.node',
      '!prebuilds/linux-x64.node',
      '!prebuilds/linuxmusl-arm64.node',
      '!prebuilds/linuxmusl-x64.node',
      '!prebuilds/win32-arm64.node',
      '!deps/**',
      '!src/**',
    )
  }
  if (name === 'onnxruntime-node') {
    f.push(
      '!bin/napi-v6/darwin/**',
      '!bin/napi-v6/linux/**',
      '!bin/napi-v6/win32/arm64/**',
    )
  }
  return f
}

function stageProdNodeModules(found) {
  fs.rmSync(path.dirname(stageRoot), { recursive: true, force: true })
  fs.mkdirSync(stageRoot, { recursive: true })
  for (const [name, dir] of found) {
    const dest = path.join(stageRoot, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(dir, dest, { recursive: true, force: true, dereference: true })
  }
  console.log(`staged ${found.size} production packages under pack-app/node_modules`)
}

/**
 * @returns {import('electron-builder').FileSet[]}
 */
export function prodNodeModuleFileSpecs() {
  const found = collectProdPackages()
  stageProdNodeModules(found)
  const specs = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name]) => ({
      from: path.join(stageRoot, name),
      to: `node_modules/${name}`,
      filter: filtersFor(name),
    }))
  console.log(`prod node_modules: ${specs.length} packages (staged in-project for asarUnpack)`)
  return specs
}

function hasNativeBinary(dir) {
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of ents) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'docs' || ent.name === 'test' || ent.name === 'tests') continue
        stack.push(p)
      } else if (/\.(node|dll)$/i.test(ent.name)) return true
    }
  }
  return false
}

/**
 * Safety net: copy packages that contain .node/.dll into app.asar.unpacked.
 * @param {string} appOutDir
 */
export function copyNativeModulesToUnpacked(appOutDir) {
  const found = collectProdPackages()
  const destRoot = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')
  const copied = []
  for (const [name, dir] of found) {
    if (!hasNativeBinary(dir)) continue
    const dest = path.join(destRoot, name)
    fs.mkdirSync(dest, { recursive: true })
    fs.cpSync(dir, dest, { recursive: true, force: true, dereference: true })
    copied.push(name)
  }
  console.log(`unpacked natives: ${copied.join(', ') || '(none)'}`)
}

/**
 * Fail the build if native addons were packed into the asar body (Windows cannot load them).
 * asar list includes unpacked entries, so this inspects the asar header flags instead.
 * @param {string} appOutDir
 */
export function assertNoNativesInAsar(appOutDir) {
  const asar = path.join(appOutDir, 'resources', 'app.asar')
  const fd = fs.openSync(asar, 'r')
  const prefix = Buffer.alloc(16)
  fs.readSync(fd, prefix, 0, 16, 0)
  const jsonSize = prefix.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonSize)
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
  fs.closeSync(fd)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const packed = []
  const walk = (node, prefixPath) => {
    if (!node) return
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) walk(child, prefixPath + '/' + name)
      return
    }
    if (/\.(node|dll)$/i.test(prefixPath) && /\/node_modules\//.test(prefixPath) && !node.unpacked) {
      packed.push(prefixPath)
    }
  }
  walk(header, '')
  if (packed.length) {
    throw new Error(
      'Native addons must only live in app.asar.unpacked, but these are still packed inside app.asar:\n' +
        packed.map((l) => '  ' + l).join('\n'),
    )
  }
  console.log('asar native check: all node_modules .node/.dll entries are unpacked')
}
