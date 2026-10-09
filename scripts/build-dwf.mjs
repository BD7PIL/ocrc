#!/usr/bin/env node
/**
 * Build the vendored dynamic-workflow engine (P1).
 *
 * Two steps, both required:
 *  1. `generate-libs.mjs` (upstream, vendored verbatim) snapshots the TypeScript
 *     stdlib .d.ts closure into `src/compiler/libs.generated.ts`. The workflow
 *     compiler runs with zero disk access by design, so it cannot read
 *     lib.es2022.d.ts from the typescript package at runtime — the closure has to
 *     be embedded at build time. It is idempotent per installed TS version.
 *  2. One tsc pass over BOTH packages, rooted at the vendor dir, so the emitted
 *     tree keeps `dynamic-workflow/` and `dynamic-workflow-runtime/` side by side
 *     and the runtime's relative import (PATCHES #1) resolves in dist exactly as
 *     it does in src.
 *
 * Output: vendor/zcode-dwf/dist/{dynamic-workflow,dynamic-workflow-runtime}/src/*.js
 * The relative depth from both `src/` and `dist/` to that output is identical, so
 * ocrc's own code can import it with one path that works compiled and unbundled.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const VENDOR = join(REPO, 'vendor', 'zcode-dwf')

const genLibs = join(VENDOR, 'dynamic-workflow', 'scripts', 'generate-libs.mjs')
if (!existsSync(genLibs)) {
  console.error(`build-dwf: missing ${genLibs} — the vendor tree is incomplete`)
  process.exit(1)
}

console.log('[build-dwf] generating the embedded TypeScript lib closure…')
execFileSync(process.execPath, [genLibs], { stdio: 'inherit', cwd: VENDOR })

console.log('[build-dwf] compiling the vendored engine…')
const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(process.execPath, [tsc, '-p', join(VENDOR, 'tsconfig.build.json')], { stdio: 'inherit', cwd: REPO })

console.log('[build-dwf] done → vendor/zcode-dwf/dist')
