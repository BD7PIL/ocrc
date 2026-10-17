import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('bin-cache')

/**
 * Self-hosted opencode V2 artifact cache — PRODUCT 第零点六条 realized for
 * the openchamber-era topology (panel on Win/Mac, air-gapped EL7 controlled
 * hosts, CI-produced offline bundles).
 *
 * Upstream ships V2 as npm tarballs: `@opencode/cli-<target>@<version>`
 * (registry.npmjs.org), each with a sha512 integrity hash in the registry
 * metadata. We mirror that contract: download → verify → cache → push, so an
 * offline host gets byte-identical official bits with no network. Verified
 * end-to-end in the E1 lab (docs/research/e1-verdict.md).
 *
 * Cache layout: <OCRC_HOME>/bin-cache/<version>/<target>.tgz
 * (bin-cache root resolves lazily so OCRC_HOME env stays overridable in tests).
 */

export interface ArtifactTarget {
  /** npm package target suffix: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | win32-x64 */
  target: string
}

export interface Manifest {
  /** ocrc-level pin of the opencode V2 line */
  opencodePin: string
  /** sha512-base64 integrity per target, copied from the registry metadata */
  integrity: Record<string, string>
  /** minimum engine version the current openchamber generation accepts */
  minOpenCodeVersion?: string
  createdAt: string
}

/**
 * B2 — the CI offline bundle, consumed instead of re-downloaded.
 *
 * `ocrc-follow.yml`'s `bundle` job has always produced the pinned tgz files plus
 * a manifest, and **nothing ever read them**: every install path went to the
 * registry even when the bytes were already on disk. That made the bundle a
 * promise rather than a supply, and a control side holding the bundle but no
 * registry still could not install.
 *
 * Layout (env `OCRC_BUNDLE_DIR`, default `<bin-cache>/bundle`):
 *   cli-<target>-<version>.tgz  +  manifest.json { digests: { <target>: { sha512, sha256, bytes } } }
 *
 * The bundle is **verified, never trusted**: without a digest for that target we
 * ignore the file and fall back to the registry, and a digest mismatch is an
 * error rather than a silent re-download — a tampered bundle has to be loud.
 */
export interface BundleManifest {
  opencodePin?: string
  /** Per-target digests. Older manifests carry only the pin; their artifacts are
   *  readable but not usable (we will not install bytes we cannot verify). */
  digests?: Record<string, { sha512?: string; sha256?: string; bytes?: number }>
  createdAt?: string
}

export function bundleDir(): string {
  return process.env.OCRC_BUNDLE_DIR ?? join(binCacheRoot(), 'bundle')
}

export function readBundleManifest(dir = bundleDir()): BundleManifest | undefined {
  const p = join(dir, 'manifest.json')
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as BundleManifest
  } catch {
    return undefined
  }
}

export function bundleArtifactPath(version: string, target: string, dir = bundleDir()): string {
  return join(dir, `cli-${target}-${version}.tgz`)
}

export interface BundleHit { file: string; sha512: string }

/** The bundle's copy of one artifact, when it is present **and** verifiable.
 *  `undefined` means "not usable from here" (absent, no digest) — the caller
 *  then goes to the registry. A digest mismatch throws. */
export function takeBundleArtifact(version: string, target: string, dir = bundleDir()): BundleHit | undefined {
  const file = bundleArtifactPath(version, target, dir)
  if (!existsSync(file)) return undefined
  const digest = readBundleManifest(dir)?.digests?.[target]?.sha512
  if (!digest) {
    log.warn(`bundle has ${file} but no digest for ${target} — ignoring it (unverified bytes are not worth using)`)
    return undefined
  }
  const expected = digest.startsWith('sha512-') ? digest.slice(7) : digest
  const actual = createHash('sha512').update(readFileSync(file)).digest('base64')
  if (actual !== expected) {
    throw new Error(`bundle artifact digest mismatch for ${target}@${version}：${file} 不是 CI 产出的那一份（拒绝使用）`)
  }
  return { file, sha512: actual }
}

const REGISTRY = 'https://registry.npmjs.org'

export function binCacheRoot(): string {
  const ocrcHome = process.env.OCRC_HOME ?? join(homedir(), '.ocrc')
  return join(ocrcHome, 'bin-cache')
}

/** npm target for a linux/darwin/win32 + x64/arm64 controlled host. */
export function npmTargetFor(platform: string, arch: string): string {
  const a = arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64'
  return `${platform}-${a}`
}

/** Compare a registry `dist.integrity` (sha512-base64) against a downloaded file. */
export function verifyIntegrity(file: string, integrity: string): boolean {
  const expected = integrity.startsWith('sha512-') ? integrity.slice(7) : integrity
  const actual = createHash('sha512').update(readFileSync(file)).digest('base64')
  return actual === expected
}

function proxyAwareFetch(url: string, timeoutMs: number): Promise<Response> {
  // Node's fetch ignores HTTP(S)_PROXY by default; enterprises route egress
  // through a proxy (PRODUCT 第零点六条). Env var read is enough here — a
  // full proxy agent would add a dependency, and the CI bundle path (the
  // primary producer of caches) runs on GitHub runners without proxies.
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (proxy) log.warn(`HTTPS_PROXY=${proxy} is set but not applied to registry fetch (no proxy agent dependency); direct fetch attempted`)
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
}

/** Fetch the registry metadata and return the dist.integrity for a version. */
export async function fetchIntegrity(version: string, target: string, timeoutMs = 30_000): Promise<string> {
  const url = `${REGISTRY}/@opencode%2Fcli-${target}`
  const res = await proxyAwareFetch(url, timeoutMs)
  if (!res.ok) throw new Error(`registry metadata ${res.status} for @opencode/cli-${target}`)
  const meta = (await res.json()) as { versions?: Record<string, { dist?: { integrity?: string } }> }
  const integrity = meta.versions?.[version]?.dist?.integrity
  if (!integrity) throw new Error(`no integrity for cli-${target}@${version}`)
  return integrity
}

/** Stream-download the tgz to the cache dir and verify integrity. Returns the cached path. */
export async function cacheArtifact(version: string, target: string, timeoutMs = 300_000): Promise<string> {
  const root = binCacheRoot()
  const dir = join(root, version)
  const dest = join(dir, `cli-${target}-${version}.tgz`)
  if (existsSync(dest)) {
    log.info(`cache hit: ${dest}`)
    return dest
  }
  mkdirSync(dir, { recursive: true })
  // B2: a verified CI bundle wins over the network — same bytes, no egress, and
  // the reason the bundle exists at all. `takeBundleArtifact` throws on a digest
  // mismatch, so this can never quietly install something else.
  const bundled = takeBundleArtifact(version, target)
  if (bundled) {
    writeFileSync(dest, readFileSync(bundled.file), { mode: 0o644 })
    log.info(`bundle hit: ${bundled.file} → ${dest}（sha512 校验通过，未走网络）`)
    return dest
  }
  const integrity = await fetchIntegrity(version, target)
  const url = `${REGISTRY}/@opencode/cli-${target}/-/cli-${target}-${version}.tgz`
  log.info(`downloading ${url}`)
  const res = await proxyAwareFetch(url, timeoutMs)
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = `${dest}.part`
  writeFileSync(tmp, buf)
  if (!verifyIntegrity(tmp, integrity)) {
    rmSync(tmp, { force: true })
    throw new Error(`integrity mismatch for cli-${target}@${version} — cache poisoned?`)
  }
  // Chmod through a fresh write so the mode is explicit (downloads are world-readable bits).
  writeFileSync(dest, buf, { mode: 0o644 })
  rmSync(tmp, { force: true })
  return dest
}

/** Windows paths handed to tar need forward slashes AND `--force-local`.
 *  Verified against GNU tar 1.35 on Windows by trying all four combinations:
 *  backslashes alone → "Cannot open …\002.0.27-linux-x64"; backslashes with
 *  `--force-local` → MSYS escape mangling; forward slashes without the flag →
 *  "Cannot connect to C:". Only forward + flag works. */
function tarPath(p: string): string {
  return process.platform === 'win32' ? p.replaceAll('\\', '/') : p
}

/** Extract the `package/bin/opencode` binary from a cached tgz into destDir. Local side only. */
export async function extractBinary(tgzPath: string, destDir: string): Promise<string> {
  mkdirSync(destDir, { recursive: true })
  const forceLocal = process.platform === 'win32' ? ['--force-local'] : []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', [...forceLocal, '-xzf', tarPath(tgzPath), '-C', tarPath(destDir), 'package/bin/opencode'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => reject(e))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar extract failed: ${err.trim()}`))))
  })
  const bin = join(destDir, 'package', 'bin', 'opencode')
  if (!existsSync(bin)) throw new Error(`binary missing after extract: ${bin}`)
  chmodSync(bin, 0o755)
  return bin
}

/** Read a CI-produced manifest (version + integrity + minEngine), if present. */
export function readManifest(): Manifest | undefined {
  const p = join(binCacheRoot(), 'manifest.json')
  if (!existsSync(p)) return undefined
  try { return JSON.parse(readFileSync(p, 'utf-8')) as Manifest } catch { return undefined }
}

/** The effective V2 pin: manifest first (declarative, PRODUCT 第零点六条),
 *  then the OCRC_V2_PIN env, else undefined (dynamic-follow legacy path). */
export function resolveV2Pin(): string | undefined {
  return readManifest()?.opencodePin ?? process.env.OCRC_V2_PIN ?? undefined
}
