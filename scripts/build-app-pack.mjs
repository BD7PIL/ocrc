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
 *
 * The publish job merges the tier manifests into ocrc-remote-pack-manifest.json.
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

// 1. Cross-install the app tree (no lifecycle scripts; the tree is pure JS +
//    node-pty's prebuilt binary, which we replace for the legacy tier).
const npmCli = resolveNpmCli()
console.log(`[pack] npm install -g --prefix <tree> --os=linux --cpu=x64 --libc=glibc @openchamber/web@${version}`)
run(process.execPath, [
  npmCli, 'install', '-g', '--prefix', tree,
  '--os=linux', '--cpu=x64', '--libc=glibc',
  `@openchamber/web@${version}`,
  '--ignore-scripts', '--no-audit', '--no-fund',
])

// 2. Normalize the prefix layout: lib/node_modules is what the remote push
//    script asserts; drop the Windows shim files.
const rootModules = join(tree, 'node_modules')
if (existsSync(rootModules) && !existsSync(join(tree, 'lib', 'node_modules'))) {
  mkdirSync(join(tree, 'lib'), { recursive: true })
  renameSync(rootModules, join(tree, 'lib', 'node_modules'))
}
for (const shim of ['openchamber', 'openchamber.cmd', 'openchamber.ps1']) {
  rmSync(join(tree, shim), { force: true })
}
const appDir = join(tree, 'lib', 'node_modules', '@openchamber', 'web')
const cli = join(appDir, 'bin', 'cli.js')
if (!existsSync(cli)) throw new Error(`layout check failed: ${cli} missing`)

// 3. Legacy tier: replace node-pty's prebuild with the glibc-2.17 rebuild.
const ptyTarget = join(appDir, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node')
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
    const p = spawnSync(nodePath, ['-e', 'require(process.argv[1])', join(appDir, 'node_modules', 'node-pty')], { encoding: 'utf8' })
    if (p.status !== 0) throw new Error(`smoke: node-pty failed to load\n${p.stderr || p.stdout}`)
  }
  console.log(`[pack] smoke ok (cli ${got}${process.platform === 'win32' ? ', pty load skipped on win32' : ', pty loads'})`)
}

// 5. Pack (relative names + cwd: GNU tar on Windows reads C:\ as host:file).
run('tar', ['czf', asset, '-C', 'tree', '.'], { cwd: work })
const finalAsset = join(out, asset)
copyFileSync(join(work, asset), finalAsset)
const bytes = readFileSync(finalAsset)
const sha512Base64 = createHash('sha512').update(bytes).digest('base64')
const sha512Hex = createHash('sha512').update(bytes).digest('hex')
writeFileSync(`${finalAsset}.sha512`, `${sha512Base64}\n`)

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
  createdAt: new Date().toISOString(),
}
writeFileSync(join(out, `ocrc-remote-pack-${version}-linux-x64-${tier}.json`), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`[pack] ${finalAsset} (${(bytes.length / 1e6).toFixed(1)}MB) sha512 ${sha512Base64.slice(0, 16)}…`)