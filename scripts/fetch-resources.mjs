// Puts the files the installer bundles into resources/ (design section 13):
//   resources/detector/detector-v4-s_int8.onnx   committed; verified here
//   resources/fonts/NotoSansSC-Bold-subset.woff   committed; verified here
//   resources/llama/vulkan/                       llama.cpp b12318 Vulkan build; NOT committed
//
//   node scripts/fetch-resources.mjs            fetch what is missing
//   node scripts/fetch-resources.mjs --force    fetch the Vulkan build again
//   node scripts/fetch-resources.mjs --offline  never use the network (copy fallback only)
//
// The Vulkan build comes from the official llama.cpp release (sha256 pinned below). If the download fails and a
// local copy exists in ../ocr-vl-test/llamacpp/bin (the developer's already-downloaded build), that folder is
// COPIED into resources/llama/vulkan. Nothing is ever written into the sibling folder.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const LLAMA_BUILD = 'b12318'
export const VULKAN_ASSET = {
  fileName: 'llama-b12318-bin-win-vulkan-x64.zip',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12318/llama-b12318-bin-win-vulkan-x64.zip',
  size: 38_052_654,
  sha256: 'bbf0403e8608f8638073842c71a6e8ddeed6bc8aa5d89e4d569994d57ddc8a10',
}
export const DETECTOR = {
  path: 'resources/detector/detector-v4-s_int8.onnx',
  size: 11_120_765,
  sha256: '5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79',
}
export const FONT = { path: 'resources/fonts/NotoSansSC-Bold-subset.woff' }

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const offline = args.has('--offline')

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyCommitted() {
  const detector = join(root, DETECTOR.path)
  if (!existsSync(detector)) throw new Error(`Missing ${DETECTOR.path} (it is committed to the repository)`)
  if (statSync(detector).size !== DETECTOR.size || (await sha256File(detector)) !== DETECTOR.sha256) {
    throw new Error(`${DETECTOR.path} does not match the pinned size/sha256`)
  }
  if (!existsSync(join(root, FONT.path))) throw new Error(`Missing ${FONT.path} (run scripts/build-font-subset.py)`)
  console.log('detector and font: ok')
}

async function downloadVulkanZip(target) {
  mkdirSync(dirname(target), { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(VULKAN_ASSET.url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
  } finally {
    clearTimeout(timer)
  }
  const size = statSync(target).size
  const digest = await sha256File(target)
  if (size !== VULKAN_ASSET.size || digest !== VULKAN_ASSET.sha256) {
    rmSync(target, { force: true })
    throw new Error(`Downloaded zip does not match the pinned size/sha256 (got ${size} bytes, ${digest})`)
  }
}

function extractZip(zip, dest) {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const result = spawnSync(tar, ['-xf', zip, '-C', dest], { windowsHide: true, shell: false, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tar.exe failed (${result.status}): ${result.stderr ?? result.error?.message ?? ''}`)
}

function findServerDir(dir) {
  if (existsSync(join(dir, 'llama-server.exe'))) return dir
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, 'llama-server.exe'))) return join(dir, entry.name)
  }
  return null
}

function copyDirectory(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyDirectory(source, target)
    else copyFileSync(source, target)
  }
}

async function fetchVulkan() {
  const target = join(root, 'resources', 'llama', 'vulkan')
  const marker = join(target, '.rawreader-build.json')
  if (!force && existsSync(join(target, 'llama-server.exe')) && existsSync(marker)) {
    const info = JSON.parse(readFileSync(marker, 'utf8'))
    if (info.build === LLAMA_BUILD) {
      console.log(`vulkan: already present (${info.source}, ${info.build})`)
      return
    }
  }

  const staging = `${target}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  let source = null

  if (!offline) {
    try {
      const zip = join(root, '.cache', 'fetch', VULKAN_ASSET.fileName)
      if (!existsSync(zip) || (await sha256File(zip)) !== VULKAN_ASSET.sha256) {
        console.log(`vulkan: downloading ${VULKAN_ASSET.url}`)
        await downloadVulkanZip(zip)
      }
      extractZip(zip, staging)
      source = 'official-release'
    } catch (error) {
      console.warn(`vulkan: official download failed: ${error instanceof Error ? error.message : String(error)}`)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
    }
  }

  let serverDir = source ? findServerDir(staging) : null
  if (!serverDir) {
    const local = join(root, '..', 'ocr-vl-test', 'llamacpp', 'bin')
    if (!existsSync(join(local, 'llama-server.exe'))) {
      throw new Error(`No Vulkan build available: the download failed and ${local} has no llama-server.exe`)
    }
    console.warn(`vulkan: copying the local build from ${local} (read-only source)`)
    rmSync(staging, { recursive: true, force: true })
    copyDirectory(local, staging)
    source = 'copied-from-local-dev-folder'
    serverDir = staging
  }

  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  renameSync(serverDir, target)
  rmSync(staging, { recursive: true, force: true })
  writeFileSync(marker, JSON.stringify({ build: LLAMA_BUILD, source, fetchedAt: new Date().toISOString() }, null, 2))
  console.log(`vulkan: ready in resources/llama/vulkan (${source})`)
}

await verifyCommitted()
await fetchVulkan()
