#!/usr/bin/env node
/**
 * Build one OCRC Remote app pack for CI (or a manual release).
 *
 *   node scripts/build-app-pack.mjs --version 2.4.0 --tier modern --out pack
 *   node scripts/build-app-pack.mjs --version 2.4.0 --tier legacy-glibc217 \
 *        --node-dir /opt/node-v24.22.0 --out pack
 *
 * The pack is the normalized npm prefix of `@openchamber/web`:
 *   lib/node_modules/@openchamber/web/bin/cli.js   ← the manifest entry
 * The legacy tier additionally replaces node-pty's prebuilt binary with one
 * rebuilt for glibc 2.17 (scripts/build-pty-legacy-local.sh).
 *
 * Output per tier:
 *   ocrc-remote-pack-<version>-linux-x64-<tier>.tar.gz
 *   ocrc-remote-pack-<version>-linux-x64-<tier>.tar.gz.sha512   (base64)
 *   ocrc-remote-pack-<version>-linux-x64-<tier>.json            (tier manifest)
 *   ocrc-remote-pack-<version>-linux-x64-<tier>.lock.json       (frozen graph)
 *
 * The publish job merges the tier manifests into ocrc-remote-pack-manifest.json.
 * The tree is installed with `npm ci` from a lock resolved at build time, so the
 * pack for a given openchamber version is byte-stable across rebuilds.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const has = (name) => args.includes(name)

const version = arg('--version').trim()
const tier = arg('--tier', 'modern').trim()
if (!version) { console.error('--version is required'); process.exit(1) }
if (!['modern', 'legacy-glibc217'].includes(tier)) { console.error(`unknown tier: ${tier}`); process.exit(1) }
const out = resolve(arg('--out', 'pack'))
const nodePath = resolve(arg('--node', process.execPath))
const nodeDir = resolve(arg('--node-dir', dirname(dirname(nodePath))))
const ptyFile = arg('--pty') ? resolve(arg('--pty')) : ''
const noSmoke = has('--no-smoke')
const work = resolve(arg('--work', join(out, '..', `.pack-work-${tier}`)))
const tree = join(work, 'tree')
const asset = `ocrc-remote-pack-${version}-linux-x64-${tier}.tar.gz`
const glibcFloor = tier === 'legacy-glibc217' ? '2.17' : '2.31'

const run = (cmd, argv = [], opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`)
}

/** Locate npm's CLI entry next to the running Node. Invoking it as
 *  `node <npm-cli.js>` avoids PATH shims (this repo ships its own npm bin). */
const resolveNpmCli = () => {
  const runtimeDir = dirname(process.execPath)
  const candidates = [
    join(runtimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(runtimeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`npm CLI not found next to ${process.execPath}`)
}

console.log(`[pack] ${tier} ${version} → ${out}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(tree, { recursive: true })
mkdirSync(out, { recursive: true })

// 1. Cross-install the app tree from a frozen dependency graph. The lock is
//    resolved once per openchamber version, installed with `npm ci`, and
//    shipped next to the pack, so the same version always yields the same
//    bytes (and a pruned release can be rebuilt identically on demand).
//    No lifecycle scripts: the tree is pure JS + node-pty's prebuilt binary,
//    which we replace for the legacy tier.
const npmCli = resolveNpmCli()
const platform = ['--os=linux', '--cpu=x64', '--libc=glibc']
const lockDir = join(work, 'lock')
mkdirSync(lockDir, { recursive: true })
writeFileSync(join(lockDir, 'package.json'), `${JSON.stringify({
  name: 'ocrc-remote-pack', version: '0.0.0', private: true,
  dependencies: { '@openchamber/web': version },
}, null, 2)}\n`)

console.log(`[pack] npm install --package-lock-only @openchamber/web@${version} (freeze the graph)`)
run(process.execPath, [
  npmCli, 'install', '--package-lock-only', '--prefix', lockDir, ...platform,
  '--ignore-scripts', '--no-audit', '--no-fund',
])
const lockFile = join(lockDir, 'package-lock.json')
if (!existsSync(lockFile)) throw new Error('layout check failed: package-lock.json was not generated')

console.log('[pack] npm ci (install exactly that graph)')
run(process.execPath, [
  npmCli, 'ci', '--prefix', lockDir, ...platform,
  '--ignore-scripts', '--no-audit', '--no-fund',
])

// 2. Normalize the layout the remote push script asserts: lib/node_modules.
//    `npm ci` into a project dir writes node_modules directly (no -g shims).
const installed = join(lockDir, 'node_modules')
if (!existsSync(installed)) throw new Error(`layout check failed: ${installed} missing`)
mkdirSync(join(tree, 'lib'), { recursive: true })
renameSync(installed, join(tree, 'lib', 'node_modules'))
const appDir = join(tree, 'lib', 'node_modules', '@openchamber', 'web')
const cli = join(appDir, 'bin', 'cli.js')
if (!existsSync(cli)) throw new Error(`layout check failed: ${cli} missing`)

// 3. Legacy tier: replace node-pty's prebuild with the glibc-2.17 rebuild.
//    npm's layout is not guaranteed: a global-style install nests deps under the
//    package, `npm ci` hoists them beside it. Both resolve at runtime, so look
//    in both places rather than assuming one.
const ptyDir = [join(appDir, 'node_modules', 'node-pty'), join(tree, 'lib', 'node_modules', 'node-pty')]
  .find((dir) => existsSync(dir))
if (!ptyDir) throw new Error('node-pty not found in the packed tree')
const ptyTarget = join(ptyDir, 'prebuilds', 'linux-x64', 'pty.node')
if (tier === 'legacy-glibc217') {
  if (!existsSync(ptyTarget)) throw new Error(`node-pty prebuild missing: ${ptyTarget}`)
  if (ptyFile) {
    copyFileSync(ptyFile, ptyTarget)
    console.log(`[pack] pty from ${ptyFile}`)
  } else if (process.platform !== 'win32') {
    const built = join(work, 'pty.node')
    run('bash', [join(repoRoot, 'scripts', 'build-pty-legacy-local.sh'), '--tree', tree, '--node-dir', nodeDir, '--out', built])
    copyFileSync(built, ptyTarget)
  } else {
    throw new Error('legacy pack on Windows needs --pty <prebuilt pty.node> (or run in the CI container)')
  }
}

// 4. Smoke: the bundled CLI reports the exact version; node-pty loads.
if (!noSmoke) {
  const v = spawnSync(nodePath, [cli, '--version'], { encoding: 'utf8' })
  const got = (v.stdout || '').trim().split(/\r?\n/).pop() || ''
  if (!got.startsWith(version)) throw new Error(`smoke: cli --version printed ${JSON.stringify(got)}, expected ${version}`)
  if (process.platform !== 'win32') {
    const p = spawnSync(nodePath, ['-e', 'require(process.argv[1])', ptyDir], { encoding: 'utf8' })
    if (p.status !== 0) throw new Error(`smoke: node-pty failed to load\n${p.stderr || p.stdout}`)
  }
  console.log(`[pack] smoke ok (cli ${got}${process.platform === 'win32' ? ', pty load skipped on win32' : ', pty loads'})`)
}

// 5. Pack. Deterministic on purpose: sorted entries with zeroed mtimes and
//    ownership, so the same lock rebuilds to the same bytes. GNU tar only grew
//    `--sort` in 1.28 and centos:7 ships 1.26, hence the explicit sorted list.
//    The output is named `../<asset>` (relative, no drive colon) because GNU
//    tar reads a `X:` prefix as an rsh host.
run('bash', [
  '-c',
  'set -euo pipefail; find . -print0 | sort -z | tar --null -T - '
    + '--mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$1"',
  'ocrc-pack', `../${asset}`,
], { cwd: tree })
const finalAsset = join(out, asset)
copyFileSync(join(work, asset), finalAsset)
const bytes = readFileSync(finalAsset)
const sha512Base64 = createHash('sha512').update(bytes).digest('base64')
const sha512Hex = createHash('sha512').update(bytes).digest('hex')
writeFileSync(`${finalAsset}.sha512`, `${sha512Base64}\n`)

// The frozen graph travels with the pack: it makes "same version ⇒ same bytes"
// auditable and lets a pruned release be rebuilt identically on demand.
const lockAsset = `ocrc-remote-pack-${version}-linux-x64-${tier}.lock.json`
copyFileSync(lockFile, join(out, lockAsset))
const lockSha512Hex = createHash('sha512').update(readFileSync(lockFile)).digest('hex')

// 6. Tier manifest; the publish job merges these into the release manifest.
const pinManifest = join(repoRoot, 'ops', 'v2-pin-manifest.json')
const opencodePin = existsSync(pinManifest) ? (JSON.parse(readFileSync(pinManifest, 'utf8')).opencodePin ?? '') : ''
const manifest = {
  openchamberVersion: version,
  tier,
  glibcFloor,
  opencodePin,
  nodeRuntime: process.env.OCRC_NODE_RUNTIME ?? 'v24.22.0',
  asset,
  sha512Base64,
  sha512Hex,
  lockAsset,
  lockSha512Hex,
  createdAt: new Date().toISOString(),
}
writeFileSync(join(out, `ocrc-remote-pack-${version}-linux-x64-${tier}.json`), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`[pack] ${finalAsset} (${(bytes.length / 1e6).toFixed(1)}MB) sha512 ${sha512Base64.slice(0, 16)}…`)