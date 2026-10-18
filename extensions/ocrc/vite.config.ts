import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Panel bundle: classic-IIFE single file (openchamber's guest sandbox has no
// ESM import support — the manifest entry HTML must reference a real .js).
// Vite lib mode matches web-next's toolchain (vite 7 + react plugin).
export default defineConfig({
  plugins: [react()],
  // Lib mode leaves process.env.NODE_ENV in the output, and the guest frame has
  // no Node globals — React's dev/prod branch would throw ReferenceError on
  // load and the panel would never mount.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/panel/main.tsx'),
      formats: ['iife'],
      name: 'OcrcConnectPanel',
      fileName: () => 'main.js',
    },
    rollupOptions: {
      // React ships inside the IIFE — the guest sandbox loads only package-local files.
      external: [],
    },
    outDir: 'dist/panel-assets',
    emptyOutDir: true,
  },
})
