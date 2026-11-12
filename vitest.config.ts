import { configDefaults, defineConfig } from 'vitest/config'

// Tests that spawn real processes are named *.win.test.ts and run on Windows only.
const skipWindowsOnly = process.platform !== 'win32'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(skipWindowsOnly ? ['src/**/*.win.test.ts'] : [])],
  },
})
