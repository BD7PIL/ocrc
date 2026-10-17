/**
 * P2 — offline provisioning for remote instances (dev plan §4 P2).
 *
 * The controlled host has **no public egress** (R6), and openchamber's own
 * desktop `managed` install runs `npm install` on the far side — 142 registry
 * calls that can only fail there (verdict §二). So the control side prepares
 * everything and pushes bytes:
 *
 *   prepare (control)  →  npm -g --prefix <cache>/tree --os=linux … @openchamber/web
 *                         tar czf payload → sha512
 *   push (ssh stdin)   →  cat > staging ; sha check ; untar ; atomic rename into place
 *   verify (remote)    →  <runtime node> <prefix>/lib/node_modules/@openchamber/web/bin/cli.js --version
 *
 * Two invariants this module exists to keep:
 *   · **Nothing on the remote touches the network.** Every remote-side script is
 *     asserted against `assertOfflineSafe` before it is sent, so "works offline"
 *     is a property of the bytes, not a hope; the acceptance script then runs the
 *     same path under a poisoned proxy env for a live proof.
 *   · **The landing is atomic and never silent.** Payload unpacks into
 *     `~/.ocrc/remote/.staging/<artifact>` (same filesystem as the target), the
 *     whole prefix is swapped with `mv`, and the old tree is kept as
 *     `<prefix>.ocrc-bak` — the same no-silent-overwrite rule as syncDirectory.
 *
 * The pure half (argv builders, remote scripts, the offline assertion) is
 * unit-tested in `tests/unit/remote-instance-push.test.ts`; the IO half is
 * exercised end-to-end by `scripts/accept-remote-instance.sh`.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger.js'
import { binCacheRoot, cacheArtifact, extractBinary, npmTargetFor, resolveV2Pin } from './bin-cache.js'
import { askpassEnv } from './ssh-askpass.js'
import {
  APP_CLI_REL, DEFAULT_ENGINE_PIN, NODE_RUNTIME, buildSshExecArgs, instancePaths, type SshTargetRef,
} from './remote-instance.js'

const log = createLogger('remote-instance-push')

export const APP_PACKAGE = '@openchamber/web'

// ── cache layout (control side) ───────────────────────────────────────────────

/** `<OCRC_HOME>/bin-cache/remote-app/<version>/` — the prepared tree + payload. */
export function appCacheDir(appVersion: string): string {
  return join(binCacheRoot(), 'remote-app', appVersion)
}
export function appTreeDir(appVersion: string): string {
  return join(appCacheDir(appVersion), 'tree')
}
export function appPayloadPath(appVersion: string): string {
  return join(appCacheDir(appVersion), `app-${appVersion}.tar.gz`)
}

// ── CI compat packs ──────────────────────────────────────────────────────────
// A pack is the whole app tree built once, per openchamber release, by CI:
// the legacy tier also carries node-pty rebuilt against glibc 2.17. The
// control side prefers a verified pack and never runs `npm install --os=linux`
// when one is available.

export type AppPackTier = 'modern' | 'legacy-glibc217'

/** Official node-pty prebuilds need glibc 2.28; hosts below that need the
 *  legacy pack (rebuilt pty + the glibc-217 Node runtime). 2.31 is the cutoff
 *  for the modern runtime; 2.28–2.30 hosts can safely use the legacy pack. */
export function appPackTierForGlibc(glibc?: string): AppPackTier {
  const m = glibc?.match(/(\d+)\.(\d+)/)
  if (!m) return 'modern'
  const major = Number(m[1])
  const minor = Number(m[2])
  return major < 2 || (major === 2 && minor < 31) ? 'legacy-glibc217' : 'modern'
}

/** The peer app pack. Named after what is inside it (openchamber), not after the
 *  extension that pushes it: `ocrc-remote` means the extension and only that.
 *  The version stays in the file name because `OCRC_PACK_DIR` is a flat
 *  directory — an offline mirror holds several versions side by side, so the
 *  release tag cannot be the only version axis here. */
export function appPackName(appVersion: string, tier: AppPackTier): string {
  return `ocrc-openchamber-pack-${appVersion}-linux-x64-${tier}.tar.gz`
}

export function appPackPath(appVersion: string, tier: AppPackTier): string {
  return join(appCacheDir(appVersion), appPackName(appVersion, tier))
}

export function appPackManifestUrl(appVersion: string): string {
  const base = (process.env.OCRC_PACK_BASE
    ?? `https://github.com/BD7PIL/ocrc/releases/download/ocrc-openchamber-pack-${appVersion}`).replace(/\/+$/, '')
  return `${base}/ocrc-openchamber-pack-manifest.json`
}

export interface AppPackManifest {
  openchamberVersion?: string
  tiers?: Record<string, { asset?: string; sha512Base64?: string; sha512Hex?: string; glibcFloor?: string }>
}

export function parseAppPackManifest(raw: unknown, tier: AppPackTier): { asset: string; sha512Base64: string } | undefined {
  const manifest = raw as AppPackManifest | undefined
  const entry = manifest?.tiers?.[tier]
  if (!entry?.asset || !entry.sha512Base64) return undefined
  return { asset: entry.asset, sha512Base64: entry.sha512Base64 }
}

function verifiedPack(file: string, marker: string): { sha: string; shaHex: string } | undefined {
  if (!existsSync(file) || !existsSync(marker)) return undefined
  const sha = readFileSync(marker, 'utf-8').trim()
  if (!sha || sha512Base64(file) !== sha) return undefined
  return { sha, shaHex: sha512Hex(file) }
}

/** Find a verified CI pack for `appVersion` + `tier`, locally or by downloading
 *  the release asset. Returns `undefined` when no pack is available so the
 *  caller can fall back to the control-side cross-install. */
export async function ensureAppPack(
  appVersion: string,
  tier: AppPackTier,
  opts: { force?: boolean; onLog?: (line: string) => void; fetchImpl?: typeof fetch; packDir?: string } = {},
): Promise<(PrepareResult & { tier: AppPackTier }) | undefined> {
  const file = appPackPath(appVersion, tier)
  const marker = `${file}.sha512`
  if (!opts.force) {
    const cached = verifiedPack(file, marker)
    if (cached) return { file, bytes: statSync(file).size, sha: cached.sha, shaHex: cached.shaHex, prepared: false, tier }
  }
  // A directory of packs: offline testing, a mirrored release, or a manually
  // downloaded asset. The file is copied into the normal cache so later runs
  // take the fast path without the directory.
  for (const dir of [opts.packDir, process.env.OCRC_PACK_DIR].filter((d): d is string => !!d?.trim())) {
    const candidate = join(dir, appPackName(appVersion, tier))
    if (!existsSync(candidate)) continue
    const sha = sha512Base64(candidate)
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(candidate, file)
    writeFileSync(marker, `${sha}\n`)
    opts.onLog?.(`应用包已就位：${appPackName(appVersion, tier)}（本地目录）`)
    return { file, bytes: statSync(file).size, sha, shaHex: sha512Hex(file), prepared: false, tier }
  }
  try {
    const doFetch = opts.fetchImpl ?? fetch
    const manifestUrl = appPackManifestUrl(appVersion)
    const res = await doFetch(manifestUrl, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`)
    const entry = parseAppPackManifest(await res.json(), tier)
    if (!entry) throw new Error(`manifest 里没有 ${tier} 档`)
    const url = new URL(entry.asset, manifestUrl).toString()
    const dl = await doFetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!dl.ok) throw new Error(`pack HTTP ${dl.status}`)
    const bytes = Buffer.from(await dl.arrayBuffer())
    const sha = createHash('sha512').update(bytes).digest('base64')
    if (sha !== entry.sha512Base64) throw new Error('pack sha512 mismatch')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    writeFileSync(marker, `${sha}\n`)
    opts.onLog?.(`应用包已取件：${appPackName(appVersion, tier)}（${(bytes.length / 1e6).toFixed(1)}MB）`)
    return { file, bytes: bytes.length, sha, shaHex: sha512Hex(file), prepared: false, tier }
  } catch (err) {
    opts.onLog?.(`应用包不可用（${(err as Error).message}）——回退控制端跨装`)
    return undefined
  }
}
/** `<OCRC_HOME>/bin-cache/remote-runtime/<version>/` — the Node runtime bits. */
export function runtimeCacheDir(): string {
  return join(binCacheRoot(), 'remote-runtime', NODE_RUNTIME.version)
}
export function runtimePayloadPath(): string {
  return join(runtimeCacheDir(), NODE_RUNTIME.tarball)
}

// ── control side: build the artifacts ─────────────────────────────────────────

/** Windows ships `npm.cmd`; POSIX ships `npm`. Spawning the bare name on
 *  Windows would need a shell round-trip — and we never want a shell here. */
export function npmBinary(platform: string = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** A `.cmd` shim cannot be spawned without a shell on Windows (`spawn` raises
 *  EINVAL) and we do not want a shell on POSIX. Quoting is applied only to the
 *  one argument a user can influence (a cache path with spaces) so the command
 *  line stays readable in logs and errors. */
export function buildWindowsCommandLine(cmd: string, args: string[]): string {
  const quote = (a: string) => (/[\s"&|<>^()%]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a)
  return [cmd, ...args.map(quote)].join(' ')
}

/** Cross-platform install of the app tree: we are on Win/Mac, the target is
 *  linux-x64 glibc, and npm ≥10 lets the install target be selected explicitly
 *  instead of inferred from the running platform. `--ignore-scripts` is implicit
 *  by npm's own allow-scripts gate here, which is what we want: the tree must be
 *  the published bytes, not artifacts built on the control host. */
export function buildCrossInstallInvocation(
  appVersion: string,
  treeDir: string,
  platform: string = process.platform,
): { cmd: string; args: string[]; needsShell: boolean } {
  return {
    cmd: npmBinary(platform),
    // `npm.cmd` needs a shell on Windows; nothing else here does.
    needsShell: platform === 'win32',
    args: [
      'install', '-g', '--prefix', treeDir,
      '--os=linux', '--cpu=x64', '--libc=glibc',
      '--no-audit', '--no-fund', '--loglevel=error',
      `${APP_PACKAGE}@${appVersion}`,
    ],
  }
}

/** `tar czf <out> -C <tree> .` — the payload carries the prefix contents at its
 *  root, so the remote untars straight into the landing dir.
 *
 *  Both names are **relative** and the caller sets `cwd` to the payload dir:
 *  GNU tar reads a `name:path` argument as a remote host, so an absolute Windows
 *  path (`C:\…`) fails with "Cannot connect to C:". Relative names sidestep that
 *  portably (no `--force-local`, which bsdtar lacks). */
export function buildPackInvocation(treeDirName: string, outFileName: string): { cmd: string; args: string[]; needsShell: boolean } {
  return { cmd: 'tar', args: ['-czf', outFileName, '-C', treeDirName, '.'], needsShell: false }
}

/** Where the app package landed — npm's two layouts differ by platform
 *  (`<prefix>/node_modules` on Windows, `<prefix>/lib/node_modules` on POSIX). */
export function findAppPackageDir(treeDir: string): string | undefined {
  for (const rel of ['lib/node_modules', 'node_modules']) {
    const dir = join(treeDir, rel, '@openchamber', 'web')
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** Normalize a foreign-platform install to the Linux prefix shape so the remote
 *  path is identical no matter which machine prepared it. The app's own requires
 *  walk up from `bin/cli.js` and hit `<prefix>/lib/node_modules` — dependencies
 *  npm nested inside the package travel with it and keep resolving. */
export function normalizeTreeLayout(treeDir: string): { appPackageDir: string; moved: boolean } {
  const app = findAppPackageDir(treeDir)
  if (!app) throw new Error(`app package not found in tree: ${treeDir}（先跑交叉安装）`)
  if (app.startsWith(join(treeDir, 'lib'))) return { appPackageDir: app, moved: false }
  const src = join(treeDir, 'node_modules')
  const dest = join(treeDir, 'lib', 'node_modules')
  mkdirSync(join(treeDir, 'lib'), { recursive: true })
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  renameSync(src, dest)
  // npm's Windows launcher shims (`openchamber`, `.cmd`, `.ps1`) are dead bytes on
  // Linux and we always invoke cli.js by its absolute path.
  for (const shim of ['openchamber', 'openchamber.cmd', 'openchamber.ps1']) {
    rmSync(join(treeDir, shim), { force: true })
  }
  return { appPackageDir: join(dest, '@openchamber', 'web'), moved: true }
}

/** `SHASUMS256.txt` line for `name` → hex digest (undefined when absent). */
export function parseShasumsLine(text: string, name: string): string | undefined {
  for (const line of (text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed)
    if (m && m[2].trim() === name) return m[1]
  }
  return undefined
}

// ── remote side: scripts (all must stay offline-safe) ─────────────────────────

/** Remote: is the runtime already there? Missing answers `MISSING` (never an
 *  error code) so the caller can decide to push rather than treat it as a fault. */
export function buildRuntimeProbeCommand(): string {
  const p = instancePaths('x')
  return `if [ -x ${p.node} ]; then ${p.node} --version; else echo MISSING; fi`
}

/** Remote: is the app already there, and at which version? */
export function buildAppProbeCommand(appVersion: string): string {
  const p = instancePaths(appVersion)
  return `if [ -f ${p.cli} ]; then ${p.node} ${p.cli} --version; else echo MISSING; fi`
}

/** Remote: receive the runtime tarball on stdin, verify sha256, unpack, rename to
 *  the short path. Idempotent — an existing good runtime is kept (the caller
 *  probes first, so a push here means "install or repair"). */
export function buildRuntimePushScript(sha256Hex: string): string {
  const p = instancePaths('x')
  const short = `node-v${NODE_RUNTIME.version}`
  return [
    'set -e',
    `R="${p.root}"`,
    `S="$R/.staging/runtime-node-${NODE_RUNTIME.version}"`,
    'rm -rf "$S"',
    'mkdir -p "$S"',
    'cat > "$S/payload.tar.xz"',
    `if ! printf '%s  %s\\n' '${sha256Hex}' "$S/payload.tar.xz" | sha256sum -c - >/dev/null 2>&1; then`,
    '  echo "payload sha256 mismatch (传输损坏或缓存被污染)" >&2',
    '  exit 4',
    'fi',
    `mkdir -p "$R/runtime"`,
    `cd "$R/runtime"`,
    `tar xf "$S/payload.tar.xz"`,
    `rm -rf ${short}`,
    `mv ${NODE_RUNTIME.unpackedDir} ${short}`,
    'rm -rf "$S"',
    `${p.node} --version`,
    `echo "runtime: pushed"`,
  ].join('\n')
}

/** Remote: receive the app tree on stdin, verify sha512, unpack into staging,
 *  then swap the version prefix atomically (old tree → `.ocrc-bak`). The payload
 *  shape is asserted before anything is moved, so a bad payload cannot cost the
 *  working install. */
export function buildAppPushScript(appVersion: string, sha512Base64: string): string {
  const p = instancePaths(appVersion)
  const cliRel = APP_CLI_REL
  return [
    'set -e',
    `R="${p.root}"`,
    `N="${p.node}"`,
    `S="$R/.staging/app-${appVersion}"`,
    `P="${p.appPrefix}"`,
    `if [ ! -x "$N" ]; then echo "runtime missing: $N（先推运行时）" >&2; exit 6; fi`,
    'rm -rf "$S"',
    'mkdir -p "$S/unpacked"',
    'cat > "$S/payload.tar.gz"',
    `if ! printf '%s  %s\\n' '${sha512Base64}' "$S/payload.tar.gz" | sha512sum -c - >/dev/null 2>&1; then`,
    '  echo "payload sha512 mismatch (传输损坏或缓存被污染)" >&2',
    '  exit 4',
    'fi',
    'tar xzf "$S/payload.tar.gz" -C "$S/unpacked"',
    `if [ ! -f "$S/unpacked/${cliRel}" ]; then`,
    '  echo "payload shape unexpected: ' + cliRel + ' 不在包里" >&2',
    '  exit 5',
    'fi',
    `mkdir -p "$R/openchamber"`,
    `if [ -e "$P" ]; then rm -rf "$P.ocrc-bak"; mv "$P" "$P.ocrc-bak"; echo "backup: openchamber/${appVersion} → .ocrc-bak"; fi`,
    'mv "$S/unpacked" "$P"',
    'rm -rf "$S"',
    `"$N" "$P/${cliRel}" --version`,
    `echo "app: pushed"`,
  ].join('\n')
}

// ── engine (the opencode v2 we deploy, R12) ───────────────────────────────────

export const ENGINE_TARGET = 'linux-x64'

export type EngineDeployOutcome = DeployOutcome & { version: string; path: string }

/** Control side: the cached engine binary (last hop of the bin-cache contract:
 *  registry tarball → sha512 → extract → **our** namespace on the far side). */
export function engineCacheDir(version: string, target: string = ENGINE_TARGET): string {
  return join(binCacheRoot(), 'remote-engine', `${version}-${target}`)
}
export function engineBinaryPath(version: string, target: string = ENGINE_TARGET): string {
  return join(engineCacheDir(version, target), 'package', 'bin', 'opencode')
}

/** Which engine to deploy: explicit > `manifest.json`/`OCRC_V2_PIN` > the
 *  declared default pin. Never "latest" — the pin is the contract (R12). */
export function resolveEnginePin(explicit?: string): string {
  return explicit?.trim() || resolveV2Pin() || DEFAULT_ENGINE_PIN
}

/** Remote: is our engine in place? */
export function buildDeployedEngineProbeCommand(): string {
  const e = `${instancePaths('x').engineDir}/opencode`
  return `if [ -x ${e} ]; then ${e} --version; else echo MISSING; fi`
}

/** Remote: receive the engine on stdin, verify sha256, **gate the version**,
 *  land in our engine dir. The gate runs on the exact bytes about to be kept,
 *  and it runs before the swap — a truncated transfer cannot cost the engine
 *  that is currently working.
 *
 *  Note this lands in `~/.ocrc/remote/engine/`, never in `~/.local/bin/`: on a
 *  controlled host the user very likely already has an opencode there (our EL7
 *  box has 1.18.32), and overwriting it is not ours to do. */
export function buildEnginePushScript(version: string, sha256Hex: string): string {
  const p = instancePaths('x')
  return [
    'set -e',
    `R="${p.root}"`,
    `E="${p.engineDir}/opencode"`,
    `S="$R/.staging/engine-${version}"`,
    'rm -rf "$S"',
    'mkdir -p "$S" "$(dirname "$E")"',
    'cat > "$S/opencode"',
    `if ! printf '%s  %s\\n' '${sha256Hex}' "$S/opencode" | sha256sum -c - >/dev/null 2>&1; then`,
    '  echo "payload sha256 mismatch (传输损坏或缓存被污染)" >&2',
    '  exit 4',
    'fi',
    'chmod 755 "$S/opencode"',
    'V=$("$S/opencode" --version 2>&1 | head -1)',
    `case "$V" in *'${version}'*) ;; *) echo "engine version gate failed: $V (需要 ${version})" >&2; exit 7 ;; esac`,
    `if [ -e "$E" ]; then cp -p "$E" "$E.ocrc-bak"; echo "backup: engine/opencode → .ocrc-bak"; fi`,
    'mv "$S/opencode" "$E"',
    'rm -rf "$S"',
    '"$E" --version',
    'echo "engine: pushed"',
  ].join('\n')
}

// ── the offline guarantee, as an assertion ────────────────────────────────────

/** Commands that would leave the controlled host if they ever appeared in a
 *  remote script. Kept deliberately broad: the scripts we send are ~30 lines of
 *  file plumbing, so a hit is always a bug, not a false positive. */
const EGRESS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['curl', /\bcurl\b/],
  ['wget', /\bwget\b/],
  ['npm', /\bnpm\b/],
  ['npx', /\bnpx\b/],
  ['yarn', /\byarn\b/],
  ['pnpm', /\bpnpm\b/],
  ['bun', /\bbun\b/],
  ['git', /\bgit\b/],
  ['pip', /\bpip3?\b/],
  ['apt', /\bapt(-get)?\b/],
  ['yum', /\byum\b/],
  ['dnf', /\bdnf\b/],
  ['ssh', /\bssh\b/],
  ['scp/sftp', /\b(?:scp|sftp)\b/],
  ['nc/telnet', /\b(?:nc|ncat|telnet)\b/],
  ['upstream installer', /opencode\.ai\/install/],
]

/** Every egress-capable token found in a remote script (empty = offline-safe). */
export function findEgressCommands(script: string): string[] {
  const hits = new Set<string>()
  for (const [name, re] of EGRESS_PATTERNS) if (re.test(script)) hits.add(name)
  return [...hits]
}

/** Throws with the offenders named — the call site is about to hand this script
 *  to a host that cannot reach the network, so a silent typo would be found only
 *  by a user whose install died halfway. */
export function assertOfflineSafe(script: string, what = '远程脚本'): void {
  const hits = findEgressCommands(script)
  if (hits.length > 0) throw new Error(`${what} 含联网命令（${hits.join(', ')}）——离线工况下不许出现`)
}

/** Env that makes external egress fail immediately instead of hanging, used by
 *  the acceptance script to run the whole path "as if" the host were air-gapped
 *  (a real netfilter block needs root, which we do not ask the user for).
 *
 *  Loopback stays out of the proxy on purpose — same rule as `buildProxyExports`:
 *  the instance talks to its own engine on 127.0.0.1, and a proxy that swallowed
 *  that traffic would break the very thing we are testing. */
export function buildOfflineGuardExports(port = 1): string {
  const dead = `http://127.0.0.1:${port}`
  return `export http_proxy='${dead}' https_proxy='${dead}' HTTP_PROXY='${dead}' HTTPS_PROXY='${dead}' no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost' npm_config_registry='${dead}/'; `
}

/** Trace mode: run the script **from a file** under
 *  `strace -f -e trace=connect`, so the acceptance run can prove zero outbound
 *  connections during an install — evidence that does not depend on proxy
 *  semantics (Node's fetch ignores env proxies unless the app opts in, so the
 *  poisoned-proxy run alone cannot rule out a raw socket call).
 *
 *  The script is base64'd on the way in, so quoting is a non-issue and stdin
 *  still belongs to the payload. */
export function wrapForTrace(script: string, traceFile: string): string {
  const b64 = Buffer.from(script, 'utf-8').toString('base64')
  const p = instancePaths('x')
  return [
    `mkdir -p "${p.staging}"`,
    `printf %s '${b64}' | base64 -d > "${p.staging}/traced.sh"`,
    `strace -f -e trace=connect -o '${traceFile}' sh "${p.staging}/traced.sh"`,
    'rc=$?',
    `rm -f "${p.staging}/traced.sh"`,
    'exit $rc',
  ].join('\n')
}

/** Connect() calls in a trace that are **not** loopback/unix — the offline
 *  assertion over strace output. Empty = the install never left the box.
 *  `AF_FILE` is how strace prints an AF_UNIX socket on Linux (nscd/dbus probes
 *  show up as these and are not egress). */
export function findOutboundConnects(trace: string): string[] {
  return (trace ?? '')
    .split('\n')
    .filter((l) => l.includes('connect('))
    .filter((l) => !/AF_UNIX|AF_LOCAL|AF_FILE|AF_NETLINK/.test(l))
    .filter((l) => !l.includes('127.0.0.1') && !l.includes('"::1"') && !l.includes('inet_addr("0.0.0.0")'))
    .map((l) => l.trim())
}

// ── hashing (control side) ────────────────────────────────────────────────────

export function sha512Base64(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}
export function sha512Hex(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('hex')
}
export function sha256Hex(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// ── ssh transport ─────────────────────────────────────────────────────────────

export interface SshResult { code: number | null; stdout: string; stderr: string }

export function sshRun(target: SshTargetRef, command: string, opts: { timeoutMs?: number } = {}): Promise<SshResult> {
  return new Promise((resolve) => {
    // Password mode needs the askpass helper in the child's env; key mode gets
    // `undefined` so ssh inherits ours (agent socket, ~/.ssh/config) unchanged.
    const child = spawn('ssh', buildSshExecArgs(target, command), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: askpassEnv(target),
    })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Run a remote script with a **small** payload on its stdin (credentials, a
 *  config document). `pushFileOverSsh` streams a file with progress; this is for
 *  the cases where the bytes are already in memory and the remote side reads
 *  them once (`cat > …`, `base64 -d > …`). */
export function sshRunWithStdin(
  target: SshTargetRef,
  command: string,
  input: Buffer | string,
  opts: { timeoutMs?: number } = {},
): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', buildSshExecArgs(target, command), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: askpassEnv(target),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: SshResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); done({ code: null, stdout, stderr: `${stderr}\ntimeout after ${opts.timeoutMs}ms` }) }, opts.timeoutMs)
      : undefined
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => done({ code: null, stdout, stderr: `${stderr}\n${err.message}` }))
    child.on('close', (code) => done({ code, stdout, stderr }))
    // EPIPE means the remote script exited early (bad path, no permission); its
    // stderr is the real story, so the write error must not mask it.
    child.stdin?.on('error', () => { /* reported through stderr/exit code */ })
    child.stdin?.end(input)
  })
}

/** Stream a file into the remote script's stdin (`cat > …` reads exactly this).
 *  Progress is byte-counted on the control side — the payload is tens of MB, so
 *  a silent multi-minute push would look like a hang. */
export function pushFileOverSsh(
  target: SshTargetRef,
  file: string,
  script: string,
  opts: { timeoutMs?: number; onProgress?: (sent: number, total: number) => void } = {},
): Promise<SshResult> {
  return new Promise((resolve) => {
    const total = statSync(file).size
    let sent = 0
    const child = spawn('ssh', buildSshExecArgs(target, script), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: askpassEnv(target),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: SshResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    const timer = opts.timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); done({ code: null, stdout, stderr: `${stderr}\ntimeout after ${opts.timeoutMs}ms` }) }, opts.timeoutMs) : undefined
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => done({ code: null, stdout, stderr: `${stderr}\n${err.message}` }))
    child.on('close', (code) => done({ code, stdout, stderr }))
    const src = createReadStream(file)
    src.on('data', (chunk: string | Buffer) => {
      sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      opts.onProgress?.(sent, total)
    })
    src.on('error', (err) => {
      try { child.kill() } catch { /* already gone */ }
      done({ code: null, stdout, stderr: `${stderr}\nread ${file}: ${err.message}` })
    })
    // When the far side exits early (script error, missing strace, full disk) the
    // socket dies mid-write. EPIPE here is the *symptom*; the exit code and
    // stderr are the story — an unhandled 'error' would crash the caller instead.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') stderr += `\nstdin: ${err.message}`
    })
    src.pipe(child.stdin!)
  })
}

// ── preparation (control side) ────────────────────────────────────────────────

export interface PrepareResult {
  file: string
  bytes: number
  /** sha512 **base64** — the bin-cache/npm `dist.integrity` convention (cache marker). */
  sha: string
  /** Same digest in **hex** — what coreutils `sha512sum -c` on the far side expects.
   *  (Feeding it base64 is how a perfectly transferred payload fails its check.) */
  shaHex: string
  prepared: boolean
  /** Which CI pack tier this came from (absent for a locally cross-built tree). */
  tier?: AppPackTier
}

async function runInvocation(inv: { cmd: string; args: string[]; needsShell?: boolean }, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = inv.needsShell
      ? spawn(buildWindowsCommandLine(inv.cmd, inv.args), { cwd, shell: true, stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn(inv.cmd, inv.args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => reject(new Error(`${inv.cmd}: ${e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${inv.cmd} ${inv.args.join(' ')} 退出码 ${code}\n${err.trim().slice(-2000)}`))))
  })
}

/** Install the app tree on the control side (once per version) and normalize its
 *  layout. Reuses an existing tree unless `force` — an existing tree is only
 *  re-normalized (a foreign-platform layout is a fixup, not a reason to refetch
 *  202 packages). */
export async function ensureAppTree(appVersion: string, opts: { force?: boolean; onLog?: (line: string) => void } = {}): Promise<{ treeDir: string; installed: boolean }> {
  const treeDir = appTreeDir(appVersion)
  if (opts.force) rmSync(treeDir, { recursive: true, force: true })
  if (findAppPackageDir(treeDir)) {
    const layout = normalizeTreeLayout(treeDir)
    if (layout.moved) opts.onLog?.(`tree 已归一到 lib/node_modules：${layout.appPackageDir}`)
    return { treeDir, installed: false }
  }
  mkdirSync(dirname(treeDir), { recursive: true })
  const inv = buildCrossInstallInvocation(appVersion, treeDir)
  opts.onLog?.(`$ ${inv.cmd} ${inv.args.join(' ')}`)
  await runInvocation(inv, dirname(treeDir))
  const layout = normalizeTreeLayout(treeDir)
  opts.onLog?.(`tree ready: ${layout.appPackageDir}${layout.moved ? '（已归一到 lib/node_modules）' : ''}`)
  return { treeDir, installed: true }
}

/** Pack the tree into the payload + its digest. Skipped when the payload is
 *  newer than the tree, so repeated deploys do not re-tar 267 MB. */
export async function ensureAppPayload(appVersion: string, opts: { force?: boolean; onLog?: (line: string) => void; tier?: AppPackTier; packDir?: string } = {}): Promise<PrepareResult> {
  // Prefer a CI-built pack: no cross-install on the control side, and the
  // legacy tier already carries the node-pty rebuilt for glibc 2.17.
  if (opts.tier) {
    const pack = await ensureAppPack(appVersion, opts.tier, { force: opts.force, onLog: opts.onLog, packDir: opts.packDir })
    if (pack) return pack
  }
  const { treeDir } = await ensureAppTree(appVersion, opts)
  const payload = appPayloadPath(appVersion)
  const marker = `${payload}.sha512`
  const fresh = existsSync(payload) && existsSync(marker)
    && statSync(payload).mtimeMs >= statSync(treeDir).mtimeMs
  if (fresh && !opts.force) {
    const bytes = statSync(payload).size
    return { file: payload, bytes, sha: readFileSync(marker, 'utf-8').trim(), shaHex: sha512Hex(payload), prepared: false }
  }
  const inv = buildPackInvocation('tree', `app-${appVersion}.tar.gz`)
  opts.onLog?.(`$ tar czf ${payload} -C ${treeDir} .`)
  await runInvocation(inv, appCacheDir(appVersion))
  const sha = sha512Base64(payload)
  writeFileSync(marker, `${sha}\n`)
  return { file: payload, bytes: statSync(payload).size, sha, shaHex: sha512Hex(payload), prepared: true }
}

/** Fetch (once, verified) the Node runtime tarball the controlled host needs.
 *  The checksum comes from the same host as the artifact — official
 *  `SHASUMS256.txt`, the same contract as the E1 bin-cache path. */
export async function ensureRuntimePayload(opts: { force?: boolean; onLog?: (line: string) => void } = {}): Promise<PrepareResult> {
  const file = runtimePayloadPath()
  const sums = join(runtimeCacheDir(), 'SHASUMS256.txt')
  const marker = `${file}.sha256`
  if (existsSync(file) && existsSync(marker) && !opts.force) {
    const sha = readFileSync(marker, 'utf-8').trim()
    if (sha256Hex(file) === sha) return { file, bytes: statSync(file).size, sha, shaHex: sha, prepared: false }
    opts.onLog?.(`缓存校验不符，重新取件：${file}`)
    rmSync(file, { force: true })
  }
  mkdirSync(runtimeCacheDir(), { recursive: true })
  const fetchTo = async (url: string, dest: string) => {
    opts.onLog?.(`$ curl -fsSL ${url}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  }
  await fetchTo(`${NODE_RUNTIME.base}/SHASUMS256.txt`, sums)
  await fetchTo(`${NODE_RUNTIME.base}/${NODE_RUNTIME.tarball}`, file)
  const expected = parseShasumsLine(readFileSync(sums, 'utf-8'), NODE_RUNTIME.tarball)
  if (!expected) throw new Error(`SHASUMS256.txt 里没有 ${NODE_RUNTIME.tarball}`)
  const sha = sha256Hex(file)
  if (sha !== expected) {
    rmSync(file, { force: true })
    throw new Error(`运行时包 sha256 不符：期望 ${expected.slice(0, 16)}…，实得 ${sha.slice(0, 16)}…`)
  }
  writeFileSync(marker, `${sha}\n`)
  return { file, bytes: statSync(file).size, sha, shaHex: sha, prepared: true }
}

// ── deploy (control side → remote) ────────────────────────────────────────────

export interface DeployOutcome { ok: boolean; detail: string }

/** §5.3 diagnostics that must not drift from the production path: a poisoned
 *  proxy env inside the script, and a strace of the same run. */
export interface DeployDiagOptions {
  /** Prepend `buildOfflineGuardExports()` — "as if" the host had no egress. */
  guard?: boolean
  /** Wrap each push script in `strace -f -e trace=connect` writing `<trace>.<what>`. */
  trace?: string
}

/** The exact bytes to send for one remote script: assert offline-safety on the
 *  script itself FIRST (the guard prefix contains the word `npm` and would trip
 *  the assertion), then decorate for the diagnostics of the day. */
function decorate(script: string, what: string, diag: DeployDiagOptions | undefined, label: string): string {
  assertOfflineSafe(script, `${label}远程脚本`)
  let out = diag?.guard ? `${buildOfflineGuardExports()}${script}` : script
  if (diag?.trace) out = wrapForTrace(out, `${diag.trace}.${what}`)
  return out
}

function tailLine(r: SshResult): string {
  const text = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean)
  return text[text.length - 1] ?? `exit ${r.code}`
}

/** Remote runtime version, or undefined when absent. */
export async function probeRemoteRuntime(target: SshTargetRef): Promise<string | undefined> {
  const r = await sshRun(target, buildRuntimeProbeCommand(), { timeoutMs: 30_000 })
  const v = r.stdout.trim().split('\n')[0] ?? ''
  return v && v !== 'MISSING' ? v : undefined
}

/** Remote app version, or undefined when absent. */
export async function probeRemoteApp(target: SshTargetRef, appVersion: string): Promise<string | undefined> {
  const r = await sshRun(target, buildAppProbeCommand(appVersion), { timeoutMs: 60_000 })
  const v = r.stdout.trim().split('\n')[0] ?? ''
  return v && v !== 'MISSING' ? v : undefined
}

export async function deployRuntimeToRemote(
  target: SshTargetRef,
  opts: DeployDiagOptions & { onLog?: (line: string) => void; onProgress?: (sent: number, total: number) => void; force?: boolean } = {},
): Promise<DeployOutcome> {
  const existing = await probeRemoteRuntime(target)
  if (existing === `v${NODE_RUNTIME.version}` && !opts.force) {
    opts.onLog?.(`runtime 已在位：${existing}（跳过推送）`)
    return { ok: true, detail: `已在位 ${existing}` }
  }
  const payload = await ensureRuntimePayload(opts)
  const script = decorate(buildRuntimePushScript(payload.shaHex), 'runtime', opts, '运行时推送')
  opts.onLog?.(`推送 runtime ${(payload.bytes / 1e6).toFixed(1)}MB（sha256 ${payload.shaHex.slice(0, 12)}…）`)
  const r = await pushFileOverSsh(target, payload.file, script, { timeoutMs: 900_000, onProgress: opts.onProgress })
  if (r.code !== 0) return { ok: false, detail: `运行时推送失败：${tailLine(r)}` }
  const version = r.stdout.trim().split('\n').filter((l) => /^v\d/.test(l)).pop() ?? ''
  if (version !== `v${NODE_RUNTIME.version}`) return { ok: false, detail: `运行时版本不符：${version || '（无输出）'}` }
  return { ok: true, detail: `已推送 ${version}` }
}

export async function deployAppToRemote(
  target: SshTargetRef,
  appVersion: string,
  opts: DeployDiagOptions & { onLog?: (line: string) => void; onProgress?: (sent: number, total: number) => void; force?: boolean; tier?: AppPackTier } = {},
): Promise<DeployOutcome> {
  const existing = await probeRemoteApp(target, appVersion)
  if (existing === appVersion && !opts.force) {
    opts.onLog?.(`应用已在位：${existing}（跳过推送）`)
    return { ok: true, detail: `已在位 ${existing}` }
  }
  const payload = await ensureAppPayload(appVersion, opts)
  const script = decorate(buildAppPushScript(appVersion, payload.shaHex), 'app', opts, '应用推送')
  opts.onLog?.(`推送 app ${(payload.bytes / 1e6).toFixed(1)}MB（sha512 ${payload.shaHex.slice(0, 12)}…）`)
  const r = await pushFileOverSsh(target, payload.file, script, { timeoutMs: 1_800_000, onProgress: opts.onProgress })
  if (r.code !== 0) return { ok: false, detail: `应用推送失败：${tailLine(r)}` }
  const version = r.stdout.trim().split('\n').filter((l) => /^\d+\.\d+\.\d+/.test(l)).pop() ?? ''
  if (version !== appVersion) return { ok: false, detail: `应用版本不符：${version || '（无输出）'}` }
  return { ok: true, detail: `已推送 ${version}` }
}

/** Control side: the v2 engine binary, from the bin-cache contract (registry
 *  tarball → sha512 verified → extracted, chmod 755). Cached per version+target,
 *  re-verified by sha256 on every reuse. */
export async function ensureEngineBinary(opts: { version?: string; target?: string; force?: boolean; onLog?: (line: string) => void } = {}): Promise<PrepareResult & { version: string; target: string }> {
  const version = resolveEnginePin(opts.version)
  const target = opts.target ?? npmTargetFor('linux', 'x64')
  const bin = engineBinaryPath(version, target)
  const marker = `${bin}.sha256`
  if (existsSync(bin) && existsSync(marker) && !opts.force) {
    const sha = sha256Hex(bin)
    if (sha === readFileSync(marker, 'utf-8').trim()) {
      // sha256Hex is already hex, so `sha` and `shaHex` coincide here; both
      // fields exist so every caller sees one shape.
      return { file: bin, bytes: statSync(bin).size, sha, shaHex: sha, prepared: false, version, target }
    }
    opts.onLog?.(`引擎缓存校验不符，重新取件：${bin}`)
    rmSync(bin, { force: true })
  }
  opts.onLog?.(`$ bin-cache: @opencode/cli-${target}@${version}`)
  const tgz = await cacheArtifact(version, target)
  const extracted = await extractBinary(tgz, engineCacheDir(version, target))
  const sha = sha256Hex(extracted)
  writeFileSync(`${extracted}.sha256`, `${sha}\n`)
  return { file: extracted, bytes: statSync(extracted).size, sha, shaHex: sha, prepared: true, version, target }
}

/** Remote: the engine version we deployed (undefined when absent). */
export async function probeRemoteEngine(target: SshTargetRef): Promise<string | undefined> {
  const r = await sshRun(target, buildDeployedEngineProbeCommand(), { timeoutMs: 30_000 })
  const v = r.stdout.trim().split('\n')[0] ?? ''
  return v && v !== 'MISSING' ? v : undefined
}

export async function deployEngineToRemote(
  target: SshTargetRef,
  opts: DeployDiagOptions & { version?: string; target?: string; onLog?: (line: string) => void; onProgress?: (sent: number, total: number) => void; force?: boolean } = {},
): Promise<EngineDeployOutcome> {
  const payload = await ensureEngineBinary(opts)
  const expected = `opencode v${payload.version}`
  const existing = await probeRemoteEngine(target)
  const path = `${instancePaths('x').engineDir}/opencode`
  if (existing === expected && !opts.force) {
    opts.onLog?.(`引擎已在位：${existing}（跳过推送）`)
    return { ok: true, detail: `已在位 ${expected}`, version: payload.version, path }
  }
  const script = decorate(buildEnginePushScript(payload.version, payload.shaHex), 'engine', opts, '引擎推送')
  opts.onLog?.(`推送 engine ${payload.version} ${(payload.bytes / 1e6).toFixed(0)}MB（sha256 ${payload.shaHex.slice(0, 12)}…）`)
  const r = await pushFileOverSsh(target, payload.file, script, { timeoutMs: 900_000, onProgress: opts.onProgress })
  if (r.code !== 0) return { ok: false, detail: `引擎推送失败：${tailLine(r)}`, version: payload.version, path }
  const printed = r.stdout.trim().split('\n').filter((l) => /opencode v/.test(l)).pop() ?? ''
  if (printed !== expected) return { ok: false, detail: `引擎版本不符：${printed || '（无输出）'}（需要 ${expected}）`, version: payload.version, path }
  return { ok: true, detail: `已推送 ${printed}`, version: payload.version, path }
}

/** The whole offline install path: runtime → engine → app. Order matters — the
 *  app script refuses to land without our runtime, and the engine gate R12
 *  belongs *before* anything starts. */
export async function provisionOffline(
  target: SshTargetRef,
  appVersion: string,
  opts: DeployDiagOptions & { onLog?: (line: string) => void; onProgress?: (sent: number, total: number) => void; force?: boolean; engineVersion?: string; skipEngine?: boolean; tier?: AppPackTier } = {},
): Promise<{ ok: boolean; runtime: DeployOutcome; engine: EngineDeployOutcome; app: DeployOutcome }> {
  const runtime = await deployRuntimeToRemote(target, opts)
  if (!runtime.ok) {
    const why = { version: resolveEnginePin(opts.engineVersion), path: `${instancePaths('x').engineDir}/opencode` }
    return {
      ok: false,
      runtime,
      engine: { ok: false, detail: '运行时未就绪，跳过引擎', ...why },
      app: { ok: false, detail: '运行时未就绪，跳过应用' },
    }
  }
  const engine: EngineDeployOutcome = opts.skipEngine
    ? { ok: true, detail: '按显式 pin 跳过（用对端既有引擎）', version: opts.engineVersion ?? '', path: '' }
    : await deployEngineToRemote(target, { ...opts, version: opts.engineVersion })
  const app = await deployAppToRemote(target, appVersion, opts)
  return { ok: runtime.ok && engine.ok && app.ok, runtime, engine, app }
}

/** The exact scripts that would run on the far side — exported so the acceptance
 *  script can assert offline-safety from the outside instead of trusting us. */
export function offlineScriptInventory(appVersion: string, engineVersion: string = resolveEnginePin()): Array<{ what: string; script: string }> {
  return [
    { what: 'runtime-probe', script: buildRuntimeProbeCommand() },
    { what: 'app-probe', script: buildAppProbeCommand(appVersion) },
    { what: 'engine-probe', script: buildDeployedEngineProbeCommand() },
    { what: 'runtime-push', script: buildRuntimePushScript('0'.repeat(64)) },
    { what: 'engine-push', script: buildEnginePushScript(engineVersion, '0'.repeat(64)) },
    { what: 'app-push', script: buildAppPushScript(appVersion, 'ZGVhZGJlZWY=') },
  ]
}

export { log }
