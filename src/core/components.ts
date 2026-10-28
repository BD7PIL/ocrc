/**
 * Generic component assembly — the only surface shared with the components.
 *
 * ocrc no longer knows what reeve or deep-memory *are*. Each component ships a
 * `provision.json` that declares how it is installed (engine plugin, pinned
 * artifacts, openchamber extension, post-install checks); this module reads that
 * declaration, fetches the bytes, and places them. Adding a component is adding
 * a manifest, not editing ocrc.
 *
 * Air-gap rule: every remote step is a pure file operation (tar, sha256sum,
 * chmod, curl to the peer's own loopback). Nothing here makes the controlled
 * host reach the internet; downloads happen on the control side.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { proxyAwareFetch } from './bin-cache.js'
import { sshRun, sshRunWithStdin, pushFileOverSsh } from './remote-instance-push.js'
import type { SshTargetRef } from './remote-instance.js'

export const COMPONENT_SCHEMA = 1

export type ComponentPluginKind = 'package' | 'directory'

export interface ComponentEnginePlugin {
  spec: string
  kind: ComponentPluginKind
  /** Directory fallback used when the peer cannot resolve a package name. */
  entry?: string
  requiresPeer?: string[]
}

export interface ComponentArtifact {
  id: string
  version: string
  url: string
  sha256: string
  size?: number
  dest: string
  mode?: string
}

export interface ComponentExtension {
  apiVersion: number
  id: string
  zip: string
  tag?: string
  capabilities?: string[]
  filesystem?: string[]
}

export type ComponentVerify =
  | { kind: 'file'; path: string; mode?: string; when?: 'directory' }
  | { kind: 'engine-plugin-loaded'; spec: string }
  | { kind: 'guest-installed'; id: string }

export interface ComponentManifest {
  schema: number
  name: string
  version: string
  license?: string
  host?: { node?: string; os?: string[]; arch?: string[] }
  enginePlugin?: ComponentEnginePlugin
  artifacts?: ComponentArtifact[]
  extension?: ComponentExtension
  configSync?: string[]
  verify?: ComponentVerify[]
  /** 组件声明：写进对端 plugins 数组条目的 options（对象条目形式）。
   *  reeve 用它给对端带 `agents.hideBuiltins`——选项跟组件契约走，ocrc 不硬编码组件细节。 */
  pluginOptions?: Record<string, unknown>
}

/** 对端 plugins 数组的一个条目：裸路径字符串，或带 options 的对象形式。 */
export type PeerPluginEntry = string | { package: string; options: Record<string, unknown> }

export interface PreparedComponent {
  manifest: ComponentManifest
  /** Always present after preparation: directories are packed into a tarball. */
  tarball: string
  sha256: string
  /** Set when the source was a directory (kept for diagnostics). */
  directory?: string
}

export interface ComponentPins {
  components?: Record<string, { version?: string; spec?: string; tarball?: string; sha256?: string }>
}

// ── manifest parsing ────────────────────────────────────────────────────────

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`)
}

function requireString(source: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(source, `${field} 必须是非空字符串`)
  return value
}

/** Parse and validate a `provision.json`. Unknown keys are ignored on purpose:
 *  a newer component may add fields the current ocrc does not act on. */
export function parseComponentManifest(raw: unknown, source = 'provision.json'): ComponentManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(source, '必须是 JSON 对象')
  const doc = raw as Record<string, unknown>
  if (doc.schema !== COMPONENT_SCHEMA) fail(source, `schema 必须是 ${COMPONENT_SCHEMA}（收到 ${String(doc.schema)}）`)
  const manifest: ComponentManifest = {
    schema: COMPONENT_SCHEMA,
    name: requireString(source, doc.name, 'name'),
    version: requireString(source, doc.version, 'version'),
  }
  if (doc.license !== undefined) manifest.license = requireString(source, doc.license, 'license')
  if (doc.host !== undefined) {
    if (typeof doc.host !== 'object' || doc.host === null) fail(source, 'host 必须是对象')
    const host = doc.host as Record<string, unknown>
    manifest.host = {
      node: host.node === undefined ? undefined : requireString(source, host.node, 'host.node'),
      os: Array.isArray(host.os) ? host.os.map((v) => requireString(source, v, 'host.os[]')) : undefined,
      arch: Array.isArray(host.arch) ? host.arch.map((v) => requireString(source, v, 'host.arch[]')) : undefined,
    }
  }
  if (doc.enginePlugin !== undefined) {
    if (typeof doc.enginePlugin !== 'object' || doc.enginePlugin === null) fail(source, 'enginePlugin 必须是对象')
    const plugin = doc.enginePlugin as Record<string, unknown>
    const kind = plugin.kind
    if (kind !== 'package' && kind !== 'directory') fail(source, 'enginePlugin.kind 只认 package | directory')
    manifest.enginePlugin = {
      spec: requireString(source, plugin.spec, 'enginePlugin.spec'),
      kind,
      entry: plugin.entry === undefined ? undefined : requireString(source, plugin.entry, 'enginePlugin.entry'),
      requiresPeer: Array.isArray(plugin.requiresPeer)
        ? plugin.requiresPeer.map((v) => requireString(source, v, 'enginePlugin.requiresPeer[]'))
        : undefined,
    }
  }
  if (doc.artifacts !== undefined) {
    if (!Array.isArray(doc.artifacts)) fail(source, 'artifacts 必须是数组')
    manifest.artifacts = doc.artifacts.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) fail(source, `artifacts[${i}] 必须是对象`)
      const a = entry as Record<string, unknown>
      const sha256 = requireString(source, a.sha256, `artifacts[${i}].sha256`).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(sha256)) fail(source, `artifacts[${i}].sha256 必须是 64 位十六进制`)
      const dest = requireString(source, a.dest, `artifacts[${i}].dest`)
      if (!dest.startsWith('~/') && !dest.startsWith('/')) fail(source, `artifacts[${i}].dest 必须是 ~/ 或绝对路径`)
      return {
        id: requireString(source, a.id, `artifacts[${i}].id`),
        version: requireString(source, a.version, `artifacts[${i}].version`),
        url: requireString(source, a.url, `artifacts[${i}].url`),
        sha256,
        size: typeof a.size === 'number' ? a.size : undefined,
        dest,
        mode: a.mode === undefined ? undefined : requireString(source, a.mode, `artifacts[${i}].mode`),
      }
    })
  }
  if (doc.extension !== undefined) {
    if (typeof doc.extension !== 'object' || doc.extension === null) fail(source, 'extension 必须是对象')
    const e = doc.extension as Record<string, unknown>
    const zip = requireString(source, e.zip, 'extension.zip')
    if (!/^https:\/\//.test(zip) || !zip.endsWith('.zip')) fail(source, 'extension.zip 必须是 https .zip URL')
    manifest.extension = {
      apiVersion: typeof e.apiVersion === 'number' ? e.apiVersion : fail(source, 'extension.apiVersion 必须是数字'),
      id: requireString(source, e.id, 'extension.id'),
      zip,
      tag: e.tag === undefined ? undefined : requireString(source, e.tag, 'extension.tag'),
      capabilities: Array.isArray(e.capabilities)
        ? e.capabilities.map((v) => requireString(source, v, 'extension.capabilities[]'))
        : undefined,
      filesystem: Array.isArray(e.filesystem)
        ? e.filesystem.map((v) => requireString(source, v, 'extension.filesystem[]'))
        : undefined,
    }
  }
  if (doc.configSync !== undefined) {
    if (!Array.isArray(doc.configSync)) fail(source, 'configSync 必须是数组')
    manifest.configSync = doc.configSync.map((v) => requireString(source, v, 'configSync[]'))
  }
  if (doc.pluginOptions !== undefined) {
    if (typeof doc.pluginOptions !== 'object' || doc.pluginOptions === null || Array.isArray(doc.pluginOptions)) {
      fail(source, 'pluginOptions 必须是对象')
    }
    manifest.pluginOptions = doc.pluginOptions as Record<string, unknown>
  }
  if (doc.verify !== undefined) {
    if (!Array.isArray(doc.verify)) fail(source, 'verify 必须是数组')
    manifest.verify = doc.verify.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) fail(source, `verify[${i}] 必须是对象`)
      const v = entry as Record<string, unknown>
      if (v.kind === 'file') {
        const when = v.when === 'directory' ? 'directory' : undefined
        return {
          kind: 'file' as const,
          path: requireString(source, v.path, `verify[${i}].path`),
          mode: v.mode === undefined ? undefined : requireString(source, v.mode, `verify[${i}].mode`),
          when,
        }
      }
      if (v.kind === 'engine-plugin-loaded') {
        return { kind: 'engine-plugin-loaded' as const, spec: requireString(source, v.spec, `verify[${i}].spec`) }
      }
      if (v.kind === 'guest-installed') {
        return { kind: 'guest-installed' as const, id: requireString(source, v.id, `verify[${i}].id`) }
      }
      return fail(source, `verify[${i}].kind 认不出（${String(v.kind)}）`)
    })
  }
  return manifest
}

// ── reading manifests ───────────────────────────────────────────────────────

function tarBinary(): string {
  // Git-for-Windows ships GNU tar, which reads "C:" as a remote host.
  return process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
}

/** npm 的版本权威是 `package.json`；`provision.json` 只是安装契约，它的 version 会漂。
 * 真实事故（reeve 0.2.9）：契约里还写着 0.2.8，于是 `ocrc remote apply` 装的是 0.2.9、
 * 日志与缓存名却报 0.2.8 —— 运维据此反复重装。这里以 package.json 为准。 */
function reconcileVersion(manifest: ComponentManifest, packageJsonText: string | null): ComponentManifest {
  if (!packageJsonText) return manifest
  try {
    const v = (JSON.parse(packageJsonText) as { version?: unknown }).version
    if (typeof v === 'string' && v.length > 0 && v !== manifest.version) return { ...manifest, version: v }
  } catch {
    /* package.json 坏了就沿用契约的版本，不挡安装 */
  }
  return manifest
}

export function readManifestFromDir(dir: string): ComponentManifest {
  const file = join(dir, 'provision.json')
  if (!existsSync(file)) throw new Error(`${dir}: 没有 provision.json（组件必须自带安装契约）`)
  const manifest = parseComponentManifest(JSON.parse(readFileSync(file, 'utf8')), file)
  const pkgFile = join(dir, 'package.json')
  return reconcileVersion(manifest, existsSync(pkgFile) ? readFileSync(pkgFile, 'utf8') : null)
}

export function readManifestFromTarball(tarball: string): ComponentManifest {
  let text: string
  try {
    text = execFileSync(tarBinary(), ['-xOf', tarball, 'package/provision.json'], { encoding: 'utf8' })
  } catch {
    throw new Error(`${tarball}: 包里没有 package/provision.json`)
  }
  const manifest = parseComponentManifest(JSON.parse(text), `${tarball}:package/provision.json`)
  let pkgText: string | null = null
  try {
    pkgText = execFileSync(tarBinary(), ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  } catch {
    /* 没有 package.json：沿用契约版本 */
  }
  return reconcileVersion(manifest, pkgText)
}

// ── preparation (control side) ──────────────────────────────────────────────

export function componentCacheDir(): string {
  const home = process.env.OCRC_HOME ?? join(homedir(), '.ocrc')
  return join(home, 'component-cache')
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Pack a directory as `package/…` so the same remote unpack step works for a
 *  repo checkout and for an npm tarball. */
function packDirectory(dir: string): string {
  const staging = join(tmpdir(), `ocrc-component-${process.pid}-${Date.now()}`)
  const target = join(staging, 'package')
  mkdirSync(target, { recursive: true })
  cpSync(dir, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src)
      return name !== 'node_modules' && name !== '.git' && name !== '.zcode'
    },
  })
  const out = `${staging}.tgz`
  execFileSync(tarBinary(), ['-czf', out, '-C', staging, 'package'])
  rmSync(staging, { recursive: true, force: true })
  return out
}

function packNpmSpec(spec: string): string {
  const dir = join(tmpdir(), `ocrc-npm-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  execFileSync(npm, ['pack', spec, '--silent', '--pack-destination', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Node 24 on Windows refuses to spawn .cmd files without a shell.
    shell: process.platform === 'win32',
  })
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error(`npm pack ${spec}: 没有产出 tgz`)
  return join(dir, tgz)
}

/** Resolve a `--component` argument: a directory, a local `.tgz`, or an npm spec. */
export async function prepareComponent(source: string): Promise<PreparedComponent> {
  let tarball: string
  let temporary: string | undefined
  let directory: string | undefined
  let manifest: ComponentManifest
  if (existsSync(source) && statSync(source).isDirectory()) {
    directory = source
    manifest = readManifestFromDir(source)
    tarball = packDirectory(source)
    temporary = tarball
  } else if (existsSync(source)) {
    // The caller's own tarball: never delete it after caching.
    manifest = readManifestFromTarball(source)
    tarball = source
  } else {
    const packed = packNpmSpec(source)
    manifest = readManifestFromTarball(packed)
    tarball = packed
    temporary = packed
  }
  const cache = componentCacheDir()
  mkdirSync(cache, { recursive: true })
  const cached = join(cache, `${manifest.name}-${manifest.version}.tgz`)
  if (!existsSync(cached) || sha256File(cached) !== sha256File(tarball)) {
    writeFileSync(cached, readFileSync(tarball), { mode: 0o644 })
  }
  if (temporary) rmSync(temporary, { force: true })
  return { manifest, tarball: cached, sha256: sha256File(cached), directory }
}

/** 把一份 pin 表解释成取件源列表（纯函数，便于逐分支断言优先级）。 */
export function sourcesFromPins(pins: ComponentPins, env: NodeJS.ProcessEnv = {}): string[] {
  const out: string[] = []
  for (const [name, pin] of Object.entries(pins.components ?? {})) {
    const envKey = `OCRC_${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_PIN`
    const override = env[envKey]?.trim()
    if (override) {
      out.push(override)
      continue
    }
    if (pin.tarball) out.push(pin.tarball)
    else if (pin.spec) out.push(pin.spec)
    else if (pin.version) out.push(`${name}@${pin.version}`)
  }
  return out
}

/** Pinned component sources: `OCRC_<NAME>_PIN` wins over `ops/components.json`. */
export function defaultComponentSources(env: NodeJS.ProcessEnv = process.env): string[] {
  const pinsFile = fileURLToPath(new URL('../../ops/components.json', import.meta.url))
  if (!existsSync(pinsFile)) return []
  let pins: ComponentPins
  try {
    pins = JSON.parse(readFileSync(pinsFile, 'utf8')) as ComponentPins
  } catch {
    return []
  }
  return sourcesFromPins(pins, env)
}

// ── remote install scripts ──────────────────────────────────────────────────

export function componentRemoteDir(manifest: ComponentManifest): string {
  return `$HOME/.ocrc/components/${manifest.name}`
}

/** The value written into the engine's v2 `plugins` array.
 *  `kind` defaults to the manifest's own; ocrc's install path forces
 *  `directory` because it pushed the bytes and the peer may be air-gapped. */
export function pluginEntryFor(
  manifest: ComponentManifest,
  remoteHome: string,
  kind: ComponentPluginKind = manifest.enginePlugin?.kind ?? 'package',
): string | undefined {
  if (!manifest.enginePlugin) return undefined
  return kind === 'directory'
    ? `${remoteHome}/.ocrc/components/${manifest.name}/package`
    : manifest.enginePlugin.spec
}

/** Script that unpacks an already-pushed tarball atomically and keeps the old
 *  tree as `.ocrc-bak` (one level, so a failed second install is recoverable). */
export function buildComponentUnpackScript(manifest: ComponentManifest, tarballName: string): string {
  const dir = componentRemoteDir(manifest)
  return [
    'set -e',
    `D="${dir}"`,
    `T="$D/${tarballName}"`,
    '[ -f "$T" ] || { echo "component tarball missing" >&2; exit 1; }',
    'rm -rf "$D.next" && mkdir -p "$D.next"',
    'tar xzf "$T" -C "$D.next"',
    '[ -f "$D.next/package/package.json" ] || { echo "component tree has no package.json" >&2; exit 1; }',
    'rm -rf "$D.bak"',
    'if [ -d "$D" ]; then mv "$D" "$D.bak"; fi',
    'mv "$D.next" "$D"',
    'echo component-unpacked',
  ].join('\n')
}

export function buildArtifactProbeCommand(dest: string): string {
  const f = dest.replace(/^~\//, '$HOME/')
  return `f="${f}"; if [ -f "$f" ]; then sha256sum "$f" | cut -d" " -f1; else echo MISSING; fi`
}

export function buildArtifactPushScript(dest: string, sha256: string, mode = '0644'): string {
  const f = dest.replace(/^~\//, '$HOME/')
  return [
    'set -e',
    `D="${dirname(f)}"`,
    `F="${f}"`,
    'mkdir -p "$D"',
    'cat > "$F.part"',
    `echo "${sha256}  $F.part" | sha256sum -c - >/dev/null`,
    'if [ -f "$F" ]; then cp -p "$F" "$F.ocrc-bak" 2>/dev/null || true; fi',
    'mv "$F.part" "$F"',
    `chmod ${mode} "$F"`,
    `echo "${sha256}  $F" | sha256sum -c - >/dev/null`,
    'echo artifact-ok',
  ].join('\n')
}

export function buildExtensionInstallScript(o: {
  port: number
  zipPath: string
  id: string
  capabilities: readonly string[]
}): string {
  const granted = o.capabilities.length > 0 ? o.capabilities.join(',') : 'sessions'
  return [
    'set -e',
    'PW="${OPENCHAMBER_UI_PASSWORD:-}"',
    '[ -n "$PW" ] || { echo "no ui password in env" >&2; exit 1; }',
    'C=$(mktemp)',
    'trap \'rm -f "$C"\' EXIT',
    `curl -fsS -c "$C" -X POST "http://127.0.0.1:${o.port}/auth/session" -H 'Content-Type: application/json' --data-binary "{\\"password\\":\\"$PW\\"}" >/dev/null`,
    `curl -fsS -b "$C" -X POST "http://127.0.0.1:${o.port}/api/guests" -H 'Content-Type: application/json' --data-binary "{\\"path\\":\\"${o.zipPath}\\",\\"replace\\":true}" >/dev/null`,
    `curl -fsS -b "$C" -X PUT "http://127.0.0.1:${o.port}/api/guests/${o.id}/capabilities" -H 'Content-Type: application/json' --data-binary '{"granted":[${granted.split(',').map((c) => `"${c}"`).join(',')}]}' >/dev/null`,
    `curl -fsS -b "$C" "http://127.0.0.1:${o.port}/api/guests" | grep -q '"id":"${o.id}"'`,
    'echo extension-installed',
  ].join('\n')
}

// ── IO helpers ──────────────────────────────────────────────────────────────

export interface ComponentInstallResult {
  ok: boolean
  details: string[]
  /** Entries to put into the engine's v2 `plugins` array（对象条目可带组件声明的 options）。 */
  plugins: PeerPluginEntry[]
  extensionInstalled: boolean
}

async function remoteSha(target: SshTargetRef, dest: string): Promise<string> {
  const r = await sshRun(target, buildArtifactProbeCommand(dest), { timeoutMs: 30_000 })
  return (r.stdout.trim().split('\n').pop() ?? '').trim()
}

async function fetchArtifact(artifact: ComponentArtifact): Promise<string> {
  const cache = join(componentCacheDir(), 'artifacts')
  mkdirSync(cache, { recursive: true })
  const dest = join(cache, `${artifact.id}-${artifact.version}`)
  if (existsSync(dest) && sha256File(dest) === artifact.sha256) return dest
  // A local path is allowed: an air-gapped control side can pre-place the exact
  // bytes (verified below, same as a download).
  const buf = /^https?:/.test(artifact.url)
    ? await (async () => {
      const res = await proxyAwareFetch(artifact.url, 900_000)
      if (!res.ok || !res.body) throw new Error(`下载 ${artifact.id} 失败：HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    })()
    : readFileSync(artifact.url)
  if (artifact.size !== undefined && buf.length !== artifact.size) {
    throw new Error(`${artifact.id} 大小不符：期望 ${artifact.size}，收到 ${buf.length}`)
  }
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== artifact.sha256) throw new Error(`${artifact.id} sha256 不符：期望 ${artifact.sha256}，收到 ${actual}`)
  writeFileSync(dest, buf, { mode: 0o644 })
  return dest
}

/** Install one prepared component on the peer. Every step is idempotent. */
export async function installPreparedComponent(
  target: SshTargetRef,
  component: PreparedComponent,
  opts: { log?: (line: string) => void; uiPassword?: string; instancePort: number; remoteHome: string; instanceRunning: boolean },
): Promise<ComponentInstallResult> {
  const details: string[] = []
  const plugins: PeerPluginEntry[] = []
  const { manifest } = component
  const dir = componentRemoteDir(manifest)
  const tarballName = `${manifest.name}-${manifest.version}.tgz`

  mkdirSync(componentCacheDir(), { recursive: true })
  const push = await pushFileOverSsh(target, component.tarball, [
    'set -e',
    `mkdir -p "${dir}"`,
    `cat > "${dir}/${tarballName}.part"`,
    `mv "${dir}/${tarballName}.part" "${dir}/${tarballName}"`,
    'echo tarball-ok',
  ].join('\n'), { timeoutMs: 300_000 })
  if (push.code !== 0) return { ok: false, details: [`${manifest.name}: 推送安装包失败（${push.stderr.trim() || `exit ${push.code}`}）`], plugins, extensionInstalled: false }
  const unpack = await sshRun(target, buildComponentUnpackScript(manifest, tarballName), { timeoutMs: 120_000 })
  if (unpack.code !== 0) return { ok: false, details: [`${manifest.name}: 解包失败（${unpack.stderr.trim() || `exit ${unpack.code}`}）`], plugins, extensionInstalled: false }
  details.push(`${manifest.name} ${manifest.version} → ${dir}/package`)

  if (manifest.enginePlugin) {
    // Directory, not the package spec: the bytes are already on the peer and an
    // air-gapped host cannot resolve a registry package name.
    const spec = pluginEntryFor(manifest, opts.remoteHome, 'directory')
    if (spec) {
      plugins.push(manifest.pluginOptions ? { package: spec, options: manifest.pluginOptions } : spec)
      details.push(manifest.pluginOptions ? `插件条目（带 options）：${spec}` : `插件条目：${spec}`)
    }
  }

  for (const artifact of manifest.artifacts ?? []) {
    const local = await fetchArtifact(artifact)
    const want = artifact.sha256
    const have = await remoteSha(target, artifact.dest)
    if (have === want) {
      details.push(`${artifact.id} ${artifact.version} 已在位（sha256 命中）`)
      continue
    }
    const pushed = await pushFileOverSsh(target, local, buildArtifactPushScript(artifact.dest, want, artifact.mode), { timeoutMs: 900_000 })
    if (pushed.code !== 0) {
      return { ok: false, details: [...details, `${artifact.id}: 落位失败（${pushed.stderr.trim() || `exit ${pushed.code}`}）`], plugins, extensionInstalled: false }
    }
    details.push(`${artifact.id} ${artifact.version} → ${artifact.dest}`)
  }

  let extensionInstalled = false
  if (manifest.extension) {
    const ext = manifest.extension
    const zipPath = `${dir}/${ext.id}.zip`
    // A local zip is allowed for an air-gapped control side (and for release
    // rehearsal before the GitHub asset exists).
    const envKey = `OCRC_EXTENSION_ZIP_${ext.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    const source = process.env[envKey] ?? ext.zip
    let buf: Buffer | undefined
    if (/^https?:/.test(source)) {
      const res = await proxyAwareFetch(source, 300_000)
      if (res.ok && res.body) buf = Buffer.from(await res.arrayBuffer())
      else details.push(`扩展 ${ext.id}：下载失败 HTTP ${res.status}（不阻断实例启动）`)
    } else {
      try {
        buf = readFileSync(source)
      } catch {
        details.push(`扩展 ${ext.id}：读不到 ${source}（不阻断实例启动）`)
      }
    }
    if (buf) {
      if (buf.subarray(0, 2).toString() !== 'PK') {
        details.push(`扩展 ${ext.id}：拿到的不是 zip（不阻断实例启动）`)
      } else {
        const zipLocal = join(componentCacheDir(), `${ext.id}-${manifest.version}.zip`)
        writeFileSync(zipLocal, buf)
        const p = await pushFileOverSsh(target, zipLocal, [
          'set -e',
          `cat > "${zipPath}.part"`,
          `mv "${zipPath}.part" "${zipPath}"`,
          'echo zip-ok',
        ].join('\n'), { timeoutMs: 300_000 })
        if (p.code !== 0) {
          details.push(`扩展 ${ext.id}：推送失败（不阻断实例启动）`)
        } else if (!opts.instanceRunning) {
          details.push(`扩展 ${ext.id}：包已就位（${zipPath}），实例未运行，启动后再装`)
        } else {
          const cmd = buildExtensionInstallScript({
            port: opts.instancePort,
            zipPath,
            id: ext.id,
            capabilities: ext.capabilities ?? ['sessions'],
          })
          const install = await sshRunWithStdin(
            target,
            `export OPENCHAMBER_UI_PASSWORD=${JSON.stringify(opts.uiPassword ?? '')}\n${cmd}`,
            '',
            { timeoutMs: 120_000 },
          )
          if (install.code === 0 && /extension-installed/.test(install.stdout)) {
            extensionInstalled = true
            details.push(`扩展 ${ext.id} 已安装并授权：${(ext.capabilities ?? ['sessions']).join('+')}`)
          } else {
            details.push(`扩展 ${ext.id}：安装未完成（${(install.stderr || install.stdout).trim().split('\n').pop() || `exit ${install.code}`}；不阻断实例启动）`)
          }
        }
      }
    }
  }

  return { ok: true, details, plugins, extensionInstalled }
}

// ── config registration ─────────────────────────────────────────────────────

const entryKey = (v: unknown) => JSON.stringify(v)

/** 我们组件的旧条目（字符串或对象形式）都算 stale——重建时换成最新形态（含新 options）。 */
const entryPackage = (v: unknown): string | null => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof (v as { package?: unknown }).package === 'string') {
    return (v as { package: string }).package
  }
  return null
}

/** 纯函数：把我们的组件条目并进对端现有 plugins 数组。
 * 只增不删我们自己的旧形态（升级即**原位**替换：字符串 → 对象、旧 options → 新 options）；
 * 非我们的条目（用户自己的 npm 插件等）一个字节都不碰。 */
export function mergePeerPluginEntries(
  current: readonly unknown[],
  additions: readonly PeerPluginEntry[],
  isStale: (pkg: string) => boolean,
): { merged: unknown[]; changed: boolean } {
  const pending = new Map<string, PeerPluginEntry>()
  for (const a of additions) {
    const pkg = entryPackage(a)
    if (pkg !== null && !pending.has(pkg)) pending.set(pkg, a)
  }
  const consumed = new Set<string>()
  const merged: unknown[] = []
  let changed = false
  for (const v of current) {
    const pkg = entryPackage(v)
    if (pkg !== null && isStale(pkg)) {
      const repl = pkg !== null ? pending.get(pkg) : undefined
      if (repl !== undefined && !consumed.has(pkg)) {
        if (entryKey(repl) !== entryKey(v)) changed = true
        merged.push(repl)
        consumed.add(pkg)
      } else {
        changed = true // 我们的旧条目且无对应新条目：删除
      }
      continue
    }
    merged.push(v)
  }
  for (const a of additions) {
    const pkg = entryPackage(a)
    if (pkg !== null && consumed.has(pkg)) continue
    if (merged.some((v) => entryKey(v) === entryKey(a))) continue
    merged.push(a)
    changed = true
  }
  return { merged, changed }
}

/** Merge plugin entries into the peer's effective user config (the `.jsonc`
 *  wins when it exists). Comments in a rewritten `.jsonc` are lost; the file is
 *  backed up first and the loss is reported, never silent. */
export async function registerPeerPlugins(
  target: SshTargetRef,
  entries: readonly PeerPluginEntry[],
  opts: { readScript: string; log?: (line: string) => void; componentNames?: readonly string[] },
): Promise<{ ok: boolean; detail: string }> {
  const log = opts.log ?? (() => {})
  const { parsePeerConfigRead } = await import('./instance-config.js')
  const read = await sshRun(target, opts.readScript, { timeoutMs: 45_000 })
  if (read.code !== 0) return { ok: false, detail: `读取对端配置失败：${read.stderr.trim() || `exit ${read.code}`}` }
  const peer = parsePeerConfigRead(read.stdout)
  const file = peer.targetBasename
  const layer = peer.layers.find((l) => l.basename === file)
  // A fresh peer has no user config at all. Writing ONLY `plugins` is safe: the
  // engine merges it with openchamber's managed layer as a union (verified on a
  // real v2 engine), so an empty document does not shadow anything.
  const doc = layer
    ? (JSON.parse(JSON.stringify(layer.parsed ?? {})) as Record<string, unknown>)
    : { $schema: 'https://opencode.ai/config.json' }
  const names = opts.componentNames ?? []
  const stale = (pkg: string) => names.some((name) =>
    pkg.includes(`@bd7pil/${name}`) || pkg.includes(`/.ocrc/components/${name}/`))
  const current = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : []
  const { merged, changed } = mergePeerPluginEntries(current, entries, stale)
  if (!changed) {
    return { ok: true, detail: `plugins 已是并集（${merged.length} 条）` }
  }
  doc.plugins = merged
  const text = `${JSON.stringify(doc, null, 2)}\n`
  const path = `$HOME/.config/opencode/${file}`
  const written = await sshRunWithStdin(
    target,
    [
      'set -e',
      `F="${path}"`,
      'mkdir -p "$(dirname "$F")"',
      'cat > "$F.part"',
      'if [ -f "$F" ]; then cp -p "$F" "$F.ocrc-bak"; fi',
      'mv "$F.part" "$F"',
      'echo config-ok',
    ].join('\n'),
    text,
    { timeoutMs: 45_000 },
  )
  if (written.code !== 0) return { ok: false, detail: `写入 ${file} 失败：${written.stderr.trim() || `exit ${written.code}`}` }
  log(`已登记 ${merged.length} 个插件（${file}${file.endsWith('.jsonc') ? '，注释会丢失，旧件在 .ocrc-bak' : ''}）`)
  return {
    ok: true,
    detail: layer ? `plugins 已并集写入 ${file}` : `已创建 ${file} 并登记 ${merged.length} 个插件`,
  }
}
