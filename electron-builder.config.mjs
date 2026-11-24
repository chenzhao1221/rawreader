import identity from './app-identity.json' with { type: 'json' }
import { prodNodeModuleFileSpecs, copyNativeModulesToUnpacked, assertNoNativesInAsar } from './scripts/prod-node-module-files.mjs'

const flavor = process.env['RAWREADER_FLAVOR'] === 'lite' ? 'lite' : 'full'

/**
 * Two packages from one code base:
 * - full: the default models ship in resources/models (OCR pair + Index-Translate-2B, 3.1 GB). NSIS cannot
 *   build installers above 2 GB, so this one is a zip that runs where it is extracted.
 * - lite: no model files, a normal NSIS installer. The wizard starts on Gemini; local models can be
 *   downloaded later from the settings.
 */
const MODEL_SOURCES = [
  { dir: '../ocr-vl-test/llamacpp/models', file: 'PaddleOCR-VL-1.5.gguf' },
  { dir: '../ocr-vl-test/llamacpp/models', file: 'PaddleOCR-VL-1.5-mmproj.gguf' },
  { dir: '../wb-tests/models', file: 'Index-Translate-2B.Q4_K_M.gguf' },
]

/** @type {import('electron-builder').Configuration} */
export default {
  appId: identity.appId,
  productName: identity.productName,
  directories: { output: `release/${flavor}` },
  artifactName: flavor === 'full' ? '${productName}-${version}-full.${ext}' : '${productName}-Setup-${version}-lite.${ext}',
  files: [
    'out/**',
    'package.json',
    // Explicit production tree: app-directapi/node_modules is a junction into ../app/node_modules,
    // and electron-builder's default walker drops those realpathed packages (@undefined).
    ...prodNodeModuleFileSpecs(),
    '!out/preload/overlay-smoke.cjs',
    // Native modules ship binaries for every platform; keep Windows x64 only (sharp already installs only its own).
    '!**/node_modules/onnxruntime-node/bin/napi-v6/darwin/**',
    '!**/node_modules/onnxruntime-node/bin/napi-v6/linux/**',
    '!**/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/**',
    '!**/node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*.node',
    '!**/node_modules/better-sqlite3/prebuilds/win32-arm64.node',
    '!**/node_modules/better-sqlite3/{deps,src}/**',
  ],
  // sharp, onnxruntime-node and better-sqlite3 are N-API modules with prebuilt Windows binaries, so no rebuild
  // against Electron headers is needed (and none of it should reach for the network or a compiler).
  npmRebuild: false,
  afterPack: async (context) => {
    copyNativeModulesToUnpacked(context.appOutDir)
    assertNoNativesInAsar(context.appOutDir)
  },
  asarUnpack: [
    '**/node_modules/sharp/**',
    '**/node_modules/@img/**',
    '**/node_modules/onnxruntime-node/**',
    '**/node_modules/better-sqlite3/**',
    '**/*.{node,dll}',
  ],
  // GGUF models are never bundled (R15.2). The Vulkan build comes from scripts/fetch-resources.mjs.
  // Only the llama-server runtime is shipped: the CLI, bench, quantize and RPC tools in the release zip are
  // left out (102 MB -> 85 MB; checked on 2026-11-13 by loading a model and translating with this set).
  extraResources: [
    {
      from: 'resources/llama/vulkan',
      to: 'llama/vulkan',
      filter: [
        'llama-server.exe',
        'llama-server-impl.dll',
        'llama.dll',
        'llama-common.dll',
        'mtmd.dll',
        'ggml.dll',
        'ggml-base.dll',
        'ggml-vulkan.dll',
        'ggml-cpu-*.dll',
        'libomp.dll',
        'LICENSE-LLVM-OpenMP',
      ],
    },
    { from: 'resources/detector', to: 'detector' },
    { from: 'resources/icons', to: 'icons', filter: ['*.png'] },
    { from: 'resources/fonts/NotoSansSC-Bold-subset.woff', to: 'fonts/NotoSansSC-Bold-subset.woff' },
    // Shown by the in-app "open source licences" view.
    { from: 'LICENSE', to: 'licenses/LICENSE' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md' },
    { from: 'resources/fonts/OFL.txt', to: 'licenses/NotoSansSC-OFL.txt' },
    ...(flavor === 'full' ? MODEL_SOURCES.map(({ dir, file }) => ({ from: `${dir}/${file}`, to: `models/${file}` })) : []),
  ],
  win: { target: flavor === 'full' ? 'zip' : 'nsis', icon: 'resources/icons/icon.png' },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // Simplified Chinese installer UI.
    language: '2052',
    // User data is kept by default. build/installer.nsh asks before removing it (default answer: keep).
    deleteAppDataOnUninstall: false,
  },
}
