import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    reporters: ['verbose'],
    // Coverage baseline (2.0.0-alpha.7): first real measurement. Source-only —
    // without scoping, v8 coverage counts every vendored .js in the repo.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
})
