import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Panel bundle: classic-IIFE single file (openchamber guest sandbox = no ESM).
export default defineConfig({
  plugins: [react()],
  // See ocrc-remote/vite.config.ts — the guest frame has no Node globals.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/panel/main.tsx'),
      formats: ['iife'],
      name: 'OcrcOmoViewPanel',
      fileName: () => 'main.js',
    },
    rollupOptions: { external: [] },
    outDir: 'dist/panel-assets',
    emptyOutDir: true,
  },
})
