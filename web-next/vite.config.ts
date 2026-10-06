import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// base '/next/': during migration the host serves this build at :4099/next/
// while the frozen Svelte shell stays at '/'. M4 swaps the roots.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/next/',
  resolve: {
    alias: {
      // Keep the Svelte app's '$lib' import shape so framework-free modules
      // migrate verbatim (no import rewrites, tests included).
      '$lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
      // Shared card/session types live in the HOST core (same source of
      // truth as the Svelte shell's $shared alias — svelte.config.js).
      '$shared': fileURLToPath(new URL('../src/core', import.meta.url)),
    },
  },
  server: {
    port: 5175,
    proxy: {
      // Dev against the running debug host (:4099). Never point at the
      // user's engine (:4096) — zero test traffic through production.
      '/api': { target: 'http://127.0.0.1:4099', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4099', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    css: false,
  },
})
