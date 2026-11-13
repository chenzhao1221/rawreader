import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const root = import.meta.dirname

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          // Utility-process entry for detection (sharp + onnxruntime-node live there).
          'detect-worker': resolve(root, 'src/main/detect/worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // Sandboxed preloads must be standalone CommonJS bundles.
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          shell: resolve(root, 'src/preload/shell/index.ts'),
          browse: resolve(root, 'src/preload/browse/index.ts'),
          // Development-only driver of the headless overlay smoke; excluded from the installer.
          'overlay-smoke': resolve(root, 'src/preload/overlay-smoke/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [svelte({ configFile: resolve(root, 'svelte.config.js') })],
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
})
