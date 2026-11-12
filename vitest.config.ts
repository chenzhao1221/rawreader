import { configDefaults, defineConfig } from 'vitest/config'

// Tests that spawn real processes are named *.win.test.ts and run on Windows only.
const skipWindowsOnly = process.platform !== 'win32'
// End-to-end smoke tests start the real llama-servers (GPU, several GB of models). They run only on request:
// $env:RAWREADER_E2E = '1'; npx vitest run src/main/pipeline/smoke.e2e.test.ts
const skipE2e = process.env['RAWREADER_E2E'] !== '1'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      ...(skipWindowsOnly ? ['src/**/*.win.test.ts'] : []),
      ...(skipE2e ? ['src/**/*.e2e.test.ts'] : []),
    ],
  },
})
