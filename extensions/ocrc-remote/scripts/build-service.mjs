// Bundle the extension service (and the OCRC core it imports) into one ESM
// file. The service is spawned by openchamber with ELECTRON_RUN_AS_NODE, so a
// single self-contained bundle is what the manifest entry points at.
import { rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('dist/service', { recursive: true, force: true })
rmSync('dist/shared', { recursive: true, force: true })

await build({
  entryPoints: ['src/service/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/service/main.js',
  logLevel: 'info',
})
