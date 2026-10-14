import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Status-section bundle — same IIFE contract as the panel, separate entry.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/status/main.tsx'),
      formats: ['iife'],
      name: 'OcrcConnectStatus',
      fileName: () => 'main.js',
    },
    rollupOptions: { external: [] },
    outDir: 'dist/status-assets',
    emptyOutDir: true,
  },
})
