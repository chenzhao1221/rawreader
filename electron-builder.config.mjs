import identity from './app-identity.json' with { type: 'json' }

/** @type {import('electron-builder').Configuration} */
export default {
  appId: identity.appId,
  productName: identity.productName,
  directories: { output: 'release' },
  artifactName: '${productName}-Setup-${version}.${ext}',
  files: [
    'out/**',
    'package.json',
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
  asarUnpack: [
    '**/node_modules/sharp/**',
    '**/node_modules/@img/**',
    '**/node_modules/onnxruntime-node/**',
    '**/node_modules/better-sqlite3/**',
  ],
  // GGUF models are never bundled (R15.2). The Vulkan build comes from scripts/fetch-resources.mjs.
  extraResources: [
    { from: 'resources/llama/vulkan', to: 'llama/vulkan', filter: ['**/*', '!.rawreader-build.json'] },
    { from: 'resources/detector', to: 'detector' },
    { from: 'resources/fonts/NotoSansSC-Bold-subset.woff', to: 'fonts/NotoSansSC-Bold-subset.woff' },
    // Shown by the in-app "open source licences" view.
    { from: 'LICENSE', to: 'licenses/LICENSE' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md' },
    { from: 'resources/fonts/OFL.txt', to: 'licenses/NotoSansSC-OFL.txt' },
  ],
  win: { target: 'nsis' },
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