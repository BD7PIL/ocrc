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

/** Extract the `package/bin/opencode` binary from a cached tgz into destDir. Local side only. */
export async function extractBinary(tgzPath: string, destDir: string): Promise<string> {
  mkdirSync(destDir, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['xzf', tgzPath, '-C', destDir, 'package/bin/opencode'], {
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
