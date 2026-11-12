import identity from './app-identity.json' with { type: 'json' }

/** @type {import('electron-builder').Configuration} */
export default {
  appId: identity.appId,
  productName: identity.productName,
  directories: { output: 'release' },
  files: ['out/**', 'package.json'],
  asarUnpack: [
    '**/node_modules/sharp/**',
    '**/node_modules/@img/**',
    '**/node_modules/onnxruntime-node/**',
    '**/node_modules/better-sqlite3/**',
  ],
  // Later slices: resources/llama/vulkan -> llama/vulkan, resources/detector -> detector.
  extraResources: [],
  win: { target: 'nsis' },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
}
