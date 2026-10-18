// Regenerate src/service/omo-schema.ts from a local oh-my-opencode-slim
// package (offline; e.g. the opencode npm cache). Usage:
//   node scripts/vendor-omo-schema.mjs <path-to-oh-my-opencode-slim>
// The schema file sits at the package root (shipped since 3.x).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = process.argv[2]
if (!pkgDir) {
  console.error('usage: node scripts/vendor-omo-schema.mjs <oh-my-opencode-slim package dir>')
  process.exit(1)
}
const raw = readFileSync(join(pkgDir, 'oh-my-opencode-slim.schema.json'), 'utf8')
JSON.parse(raw) // reject anything the panel could not parse anyway
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const out = `// ==vendored== DO NOT EDIT — generated from oh-my-opencode-slim@${pkg.version} package root
// (oh-my-opencode-slim.schema.json, MIT). Regenerate: node scripts/vendor-omo-schema.mjs
// Source of truth: the npm package ships this schema; ocrc vendors it so the
// panel can validate/display omo configs offline (air-gap hosts).
export const OMO_SCHEMA_VERSION = '${pkg.version}'
export const OMO_SCHEMA: unknown = ${raw.trim()}
`
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'service', 'omo-schema.ts'), out)
console.log(`[vendor-omo-schema] written from ${pkgDir} (v${pkg.version})`)
