/**
 * Remote openchamber instances (dev plan §3.1) — the pure half.
 *
 * Why this exists: openchamber's project/file/git faces resolve **inside the
 * serving process** (`project-directory-runtime.validateDirectoryPath` is an
 * `fsPromises.stat`; `lib/fs/routes.js` reads the local disk). So "Add project
 * 列对端 / 中栏连对端引擎" is satisfied by running the instance **on the
 * controlled host** and looking at its UI through a forwarded port — zero
 * patches to openchamber. This module owns the decisions and the shell lines;
 * the ssh transport, store and routes live next door (`core/remote-host.ts`,
 * `transport/web/routes/remote-instance.ts`).
 *
 * Two hard rules encoded here (plan §2.1 / R12):
 *   · **Engine must be opencode v2, major 2, >= 2.0.20** — never fall back to
 *     v1. The controlled host typically has a v1 (`~/.local/bin/opencode`
 *     1.18.x) sitting next to our v2, and openchamber refuses v1 outright
 *     (`Failed to start OpenCode: OpenCode 1.18.31 is installed…`).
 *   · **Paths are pinned absolute** — no PATH resolution anywhere.
 */

export interface RemoteInstance {
  id: string
  /** Display name; defaults to host. */
  name?: string
  host: string
  /** SSH port. */
  port: number
  user?: string
  /** Instance port on the controlled host (loopback-bound). */
  instancePort: number
  /** Local forward port on the control side (`http://127.0.0.1:<localPort>`). */
  localPort: number
  /** UI password; generated if absent, never returned by APIs. */
  uiPassword?: string
  /** Pinned engine binary (absolute path ON THE REMOTE). Never re-resolved by PATH. */
  enginePath?: string
  /** Engine version observed when the path was pinned (for display/assert). */
  engineVersion?: string
  /** openchamber version pinned to the control side's (mirror, never "latest"). */
  appVersion: string
  enabled: boolean
  /** R10 switches. Defaults: reconnect/resume on, restart-restore on, replay off. */
  reconnect?: boolean
  restoreOnStart?: boolean
  replayQueued?: boolean
  /** R9 egress relay: the engine's `HTTPS_PROXY` points at the controlled host's
   *  loopback (`127.0.0.1:<remotePort>`), which an `ssh -R` brings back to the
   *  control side's proxy on `<localPort>`. Defaults on — the whole premise is a
   *  controlled host without public egress. */
  proxy?: InstanceProxyConfig
}

export interface InstanceProxyConfig {
  enabled: boolean
  /** 目标白名单（空 = 只拒回环，其余放行）。按点边界后缀匹配，见 isTargetAllowed。 */
  allow: string[]
  /** Control-side listener for the relay. */
  localPort: number
  /** Loopback port created ON the controlled host by `ssh -R`. */
  remotePort: number
}

/** R9 defaults; 4711/2711 keep clear of the instance (2610) and the panel's own
 *  tunnels (4096/4199). */
export const PROXY_DEFAULTS: InstanceProxyConfig = { enabled: true, localPort: 4711, remotePort: 2711, allow: [] }

/** Default reconnect policy (plan §4 P4 / Q15: all three toggleable). */
export const RECONNECT_DEFAULTS = { reconnect: true, restoreOnStart: true, replayQueued: false } as const

/** openchamber version we pin the instance to — a **mirror of what the control
 *  side runs**, never "latest" (the two ends must speak the same API; a panel
 *  and an instance on different majors is the failure this pin removes). */
export const DEFAULT_APP_VERSION = '2.3.3'
/** Instance port on the controlled host; 2610 keeps clear of a user-run 4096. */
export const DEFAULT_INSTANCE_PORT = 2610
/** Local forward port on the control side; 4610 keeps clear of the user's own
 *  4096 tunnel (the one openchamber auto-probes). */
export const DEFAULT_LOCAL_PORT = 4610

/** Stable id for one controlled host. A machine appears **once** — several
 *  instances per host are out of v1 scope (plan §9). */
export function instanceIdFor(target: Pick<SshTargetRef, 'host' | 'user'>): string {
  const raw = `${target.user ? `${target.user}@` : ''}${target.host}`
  return raw.replace(/[^A-Za-z0-9._@-]/g, '-')
}

/** API/log-facing view: the UI password never leaves the store. */
export type RedactedInstance = Omit<RemoteInstance, 'uiPassword'> & { hasUiPassword: boolean }
export function redactInstance(i: RemoteInstance): RedactedInstance {
  const { uiPassword, ...rest } = i
  return { ...rest, hasUiPassword: !!uiPassword }
}

/** openchamber gate: `server/lib/opencode/compatibility.js`. */
export const MIN_ENGINE_VERSION = '2.0.20'
export const ENGINE_MAJOR = 2

/** Engine version we deploy to a controlled host (R12: a **pin**, never
 *  "latest"). Default = the v2.0.27 that was measured working on EL7
 *  (verdict §二); a bin-cache manifest or `OCRC_V2_PIN` overrides it, and the
 *  CLI can name one explicitly. */
export const DEFAULT_ENGINE_PIN = '2.0.27'

/** The runtime we ship to the controlled host (verdict §二): unofficial
 *  glibc-2.17 build — the ONLY 24.x line variant that runs on EL7. 24.14.0 has
 *  no glibc-217 artifact, so the floor comes from what actually exists. */
export const NODE_RUNTIME = {
  version: '24.22.0',
  /** Directory name inside the tarball. */
  unpackedDir: 'node-v24.22.0-linux-x64-glibc-217',
  tarball: 'node-v24.22.0-linux-x64-glibc-217.tar.xz',
  base: 'https://unofficial-builds.nodejs.org/download/release/v24.22.0',
} as const

/** Where the app's entry point sits inside the prefix we push. Single source of
 *  truth: the offline push normalizes a foreign-platform install to exactly this
 *  shape (npm puts packages under `<prefix>/node_modules` on Windows and under
 *  `<prefix>/lib/node_modules` on Linux), so the remote never sees two layouts. */
export const APP_CLI_REL = 'lib/node_modules/@openchamber/web/bin/cli.js'

/** Remote layout — our own namespace, never touches what the user already has.
 *  The runtime dir is renamed to the short `node-v<version>` after unpacking
 *  (the acceptance script and every later builder use that short path). */
export function instancePaths(appVersion: string) {
  const root = '$HOME/.ocrc/remote'
  const runtimeDir = `${root}/runtime/node-v${NODE_RUNTIME.version}`
  const appPrefix = `${root}/openchamber/${appVersion}`
  return {
    root,
    staging: `${root}/.staging`,
    runtimeDir,
    node: `${runtimeDir}/bin/node`,
    appPrefix,
    cli: `${appPrefix}/${APP_CLI_REL}`,
    engineDir: `${root}/engine`,
    log: `${root}/instance.log`,
  }
}

/** `opencode v2.0.27` / `2.0.27` / `v2.0.27` → `2.0.27`. */
export function normalizeEngineVersion(raw: string): string {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw ?? '')
  return m?.[1] ?? ''
}

/** openchamber's own judgement, restated: major 2 and at least 2.0.20. */
export function isSupportedEngineVersion(version: string): boolean {
  const parts = normalizeEngineVersion(version).split(/[-+]/, 1)[0]?.split('.').map(Number) ?? []
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n))) return false
  if (parts[0] !== ENGINE_MAJOR) return false
  const floor = MIN_ENGINE_VERSION.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i]
  }
  return true
}

/** Engine candidates, in preference order: our deployed copy first, then the
 *  usual install locations. `$HOME` is expanded by the remote shell. */
export const DEFAULT_ENGINE_CANDIDATES = [
  '$HOME/.ocrc/remote/engine/opencode',
  '$HOME/.opencode/bin/opencode',
  '$HOME/.local/bin/opencode',
  '/usr/local/bin/opencode',
  '/usr/bin/opencode',
]

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Quote a path for the remote **and** keep a leading `~`/`$HOME` expandable:
 *  `"$HOME"'/rest'` — the variable is expanded by the remote shell, everything
 *  after it cannot be re-read as shell syntax. Plain single-quoting would freeze
 *  `$HOME` into a literal path, and a `for` list needs quoting (see below). */
export function quoteRemotePath(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"${q(path.slice(1))}`
  if (path.startsWith('$HOME/')) return `"$HOME"${q(path.slice('$HOME'.length))}`
  return q(path)
}

/** One ssh round: print `<path>\t<version>` for every existing candidate.
 *  Never trusts PATH, never runs a candidate twice. Candidates go through
 *  `quoteRemotePath` — a bare `for c in $HOME/...` would word-split, and a fully
 *  single-quoted one would silently test a literal `$HOME` path (which is how a
 *  host with a real v1 got reported as having no engine at all). */
export function buildEngineProbeCommand(candidates: readonly string[] = DEFAULT_ENGINE_CANDIDATES): string {
  return [
    'for c in ' + candidates.map(quoteRemotePath).join(' ') + '; do',
    '  if [ -x "$c" ]; then',
    '    v=$("$c" --version 2>/dev/null | head -1)',
    '    printf "%s\\t%s\\n" "$c" "$v"',
    '  fi',
    'done',
  ].join('\n')
}

export interface EngineCandidate {
  path: string
  version: string
  /** Raw line as printed by `--version` (kept for honest error messages). */
  raw: string
}

export function parseEngineProbe(stdout: string): EngineCandidate[] {
  const out: EngineCandidate[] = []
  for (const line of (stdout ?? '').split('\n')) {
    // Split BEFORE trimming: a candidate whose `--version` printed nothing ends
    // in a bare tab, and trimming first would swallow the separator and drop
    // the row — exactly the row a refusal message needs to show.
    const bare = line.replace(/\r$/, '')
    const tab = bare.indexOf('\t')
    if (tab <= 0) continue
    const path = bare.slice(0, tab).trim()
    const raw = bare.slice(tab + 1).trim()
    if (!path) continue
    out.push({ path, version: normalizeEngineVersion(raw), raw })
  }
  return out
}

export type EnginePick = { ok: true; candidate: EngineCandidate } | { ok: false; error: string; seen: EngineCandidate[] }

/** Pick the first candidate that satisfies the v2 gate. A host with only v1 is
 *  a **hard refusal** with the versions spelled out — the failure this rule
 *  exists for is silent: openchamber would start, then die on its own gate. */
export function pickV2Engine(candidates: EngineCandidate[]): EnginePick {
  for (const candidate of candidates) {
    if (isSupportedEngineVersion(candidate.version)) return { ok: true, candidate }
  }
  if (candidates.length === 0) {
    return { ok: false, error: `目标机上没有找到 opencode 引擎（候选：${DEFAULT_ENGINE_CANDIDATES.join(', ')}）——请先用「部署引擎」装一份 v2`, seen: [] }
  }
  const seen = candidates.map((c) => `${c.path} → ${c.raw || '（版本未知）'}`).join('；')
  return {
    ok: false,
    error: `目标机上的 opencode 都不满足 v2 门禁（需 major=2 且 ≥ ${MIN_ENGINE_VERSION}）：${seen}`,
    seen: candidates,
  }
}

/** NOTE (P2): the runtime fetch and the app `npm install` used to run *on the
 *  controlled host* (`curl … | sha256sum -c`, `npm -g --prefix …`). Both are
 *  gone: that host has no egress (R6), so the control side prepares and pushes
 *  the bytes instead (`core/remote-instance-push.ts`). */

export interface InstanceServeOptions {
  appVersion: string
  port: number
  uiPassword?: string
  /** Absolute path on the remote; required (R12: pin, never PATH). */
  enginePath: string
  proxy?: { httpProxy?: string; httpsProxy?: string; noProxy?: string; caPath?: string }
  /** Build the log redirect + background `nohup` wrapper (CLI-style start). */
  detached?: boolean
}

/** Controlled host: the `serve` line. Engine and runtime are absolute; the
 *  proxy block reuses `buildProxyExports` so NO_PROXY keeps 127.0.0.1 off the
 *  corporate proxy (R9 reverse-forward territory). */
export function buildInstanceServeCommand(o: InstanceServeOptions): string {
  const p = instancePaths(o.appVersion)
  // Imported lazily to keep this module free of a hard dependency cycle.
  const exports = renderExports({
    HTTP_PROXY: o.proxy?.httpProxy,
    http_proxy: o.proxy?.httpProxy,
    HTTPS_PROXY: o.proxy?.httpsProxy,
    https_proxy: o.proxy?.httpsProxy,
    NO_PROXY: o.proxy?.httpProxy || o.proxy?.httpsProxy
      ? [o.proxy?.noProxy?.trim(), '127.0.0.1', 'localhost'].filter(Boolean).join(',')
      : o.proxy?.noProxy,
    NODE_EXTRA_CA_CERTS: o.proxy?.caPath,
  })
  const env = `${exports}${renderExports({
    OPENCODE_BINARY: o.enginePath,
    OPENCHAMBER_UI_PASSWORD: o.uiPassword,
    // Air-gapped hosts: never dial the hosted relay, and make that explicit.
    OPENCHAMBER_RELAY_HOST: 'off',
  })}`
  const line = `${env}${p.node} ${p.cli} serve --hostname 127.0.0.1 --port ${o.port}`
  // Detached: log to our file, stdin from /dev/null so the backgrounded server
  // does not hold the ssh channel open after the command returns.
  return o.detached ? `nohup sh -c ${q(line)} >> ${p.log} 2>&1 < /dev/null & echo started` : line
}

/** Deterministic `export A='x' B='y'; ` prefix; blank values are dropped. */
export function renderExports(vars: Record<string, string | undefined>): string {
  const out = Object.keys(vars)
    .sort()
    .filter((k) => vars[k] !== undefined && vars[k] !== '')
    .map((k) => `${k}=${q(String(vars[k]))}`)
  return out.length ? `export ${out.join(' ')}; ` : ''
}

/** Controlled host: stop by port (openchamber's own CLI owns the daemon lifecycle). */
export function buildInstanceStopCommand(appVersion: string, port: number): string {
  const p = instancePaths(appVersion)
  return `${p.node} ${p.cli} stop --port ${port} || true`
}

/** Controlled host: machine-readable status; the caller parses `running`. */
export function buildInstanceStatusCommand(appVersion: string, port: number): string {
  const p = instancePaths(appVersion)
  return `${p.node} ${p.cli} status --port ${port} --json 2>/dev/null || true`
}

/** Anything that can be reached over ssh — `RemoteInstance` and `RemoteHost`
 *  both are; the provisioning/forward layers only need this much. */
export interface SshTargetRef {
  host: string
  port?: number
  user?: string
}

/** ssh argv for a **one-shot** remote command (probes, provisioning scripts).
 *  No `-N`, no forward: the remote shell runs `command` and exits. */
export function buildSshExecArgs(target: SshTargetRef, command: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    '-p', String(target.port || 22),
    target.user ? `${target.user}@${target.host}` : target.host,
    command,
  ]
}

/** Remote: does a TCP port accept on the controlled host's loopback? Used to
 *  tell "the tunnel from an earlier run already carries the -R relay" (reuse it)
 *  from "something else holds the local port" (refuse loudly). */
export function buildRemotePortProbeCommand(appVersion: string, port: number): string {
  const node = instancePaths(appVersion).node
  const js = `const n=require('net');const s=n.connect(${port},'127.0.0.1',()=>{console.log('open');s.destroy();process.exit(0)});s.on('error',()=>{console.log('closed');process.exit(0)});setTimeout(()=>{console.log('closed');s.destroy();process.exit(0)},3000)`
  return `if [ -x ${node} ]; then ${node} -e "${js}"; else echo closed; fi`
}

/** Remote: can the instance's terminal actually load? node-pty ships prebuilt
 *  binaries an EL7 host cannot dlopen. Measured on the EL7 target (P6):
 *  `pty.node` needs **GLIBC_2.28** *and* GLIBCXX_3.4.21/22, while the host has
 *  glibc 2.17 / GLIBCXX up to 3.4.19. The glibc requirement is why shipping a
 *  newer libstdc++ does **not** help — only "rebuild against the host glibc"
 *  or "use Bun's own pty" remain on the table.
 *
 *  The loader's own message is misleading ("Cannot find module
 *  ./prebuilds/linux-x64/pty.node" — the file is right there); requiring the
 *  .node directly surfaces the real error, which is what we want the user to
 *  read instead of a silently dead terminal button.
 *  Prints `terminal-ok` or `terminal-unavailable: <first line>`. */
export function buildTerminalProbeCommand(appVersion: string): string {
  const p = instancePaths(appVersion)
  const pty = `${p.appPrefix}/lib/node_modules/@openchamber/web/node_modules/node-pty`
  const node = p.node
  const js = `const f=process.argv[1]+'/prebuilds/'+process.platform+'-'+process.arch+'/pty.node';try{require(f);console.log('terminal-ok')}catch(e){console.log('terminal-unavailable: '+String(e.message).split('\\n')[0])}`
  return `if [ -x ${node} ]; then ${node} -e "${js}" ${quoteRemotePath(pty)}; else echo terminal-unavailable: 运行时不在位; fi`
}

export type TerminalProbe = { ok: true } | { ok: false; reason: string }

export function parseTerminalProbe(stdout: string): TerminalProbe {
  const line = (stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (line === 'terminal-ok') return { ok: true }
  const reason = line.startsWith('terminal-unavailable:') ? line.slice('terminal-unavailable:'.length).trim() : line || '（无输出）'
  return { ok: false, reason }
}

/** 「一键 external」的**可落地**形态：openchamber 桌面版的 Remote Instances 列表由桌面外壳自己拥有
 *  （settings 里的 `desktopSshInstances`，owner=desktop-shell、desktop-only 面），外部按猜测的形状写它
 *  只会毁掉用户配置。所以这里把桌面版对话框要的三项**算好、验好、一次交出去**：
 *  URL（已在转发上）、UI 密码（只在本地终端给，HTTP 面不回显）、端口（实例端口与转发端口一致）。
 *  人照着粘贴、脚本照着读 JSON —— 这就是「一键」在我们能负责的边界内的全部。 */
export interface DesktopHandoff {
  id: string
  /** 桌面版「Remote Instance」地址栏要填的 URL。 */
  url: string
  /** 桌面版要的密码（同样可登录浏览器 UI）。 */
  uiPassword?: string
  /** 与 url 配套的端口（桌面版对话框另一项）。 */
  port: number
  instancePort: number
  appVersion: string
  running: boolean
  engine?: { path: string; version: string }
  /** 直接展示给用户的说明行（终端/面板）。 */
  lines: string[]
}

/** 纯函数：从档案 + 状态生成交接信息（不碰网络，便于单测）。 */
export function buildDesktopHandoff(
  instance: RemoteInstance,
  status: { state?: string; engine?: { path: string; version: string } } | undefined,
): DesktopHandoff {
  const url = `http://127.0.0.1:${instance.localPort}`
  const running = status?.state === 'online'
  const lines = [
    `地址 : ${url}`,
    instance.uiPassword ? `密码 : ${instance.uiPassword}` : '密码 : （档案里没有，先 ocrc remote add）',
    `端口 : ${instance.localPort}（对应实例端口 ${instance.instancePort}）`,
    running ? '状态 : 在线，可以直接打开' : `状态 : ${status?.state ?? 'unknown'}——先 ocrc remote up ${instance.id}`,
  ]
  return {
    id: instance.id,
    url,
    uiPassword: instance.uiPassword,
    port: instance.localPort,
    instancePort: instance.instancePort,
    appVersion: instance.appVersion,
    running,
    engine: status?.engine,
    lines,
  }
}
export interface ForwardSpec {
  host: string
  port: number
  user?: string
  localPort: number
  remotePort: number
  /** P3 / R9: same ssh process, opposite direction — brings the control side's
   *  egress relay onto the controlled host's loopback (`-R`). One connection
   *  carries both directions, so a dropped tunnel loses egress and UI together
   *  and the reconnect logic only has one thing to watch. */
  reverse?: { remotePort: number; localPort: number }
}

/** Control side: the ONE connection — a local forward to the instance port, plus
 *  (R9) the reverse forward that gives the controlled host its egress.
 *  `ExitOnForwardFailure` so a busy local port surfaces instead of a silently
 *  unforwarded session; keepalives so a dead peer is noticed (R10). */
export function buildForwardArgs(spec: ForwardSpec): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-p', String(spec.port || 22),
    '-N',
    '-L', `127.0.0.1:${spec.localPort}:127.0.0.1:${spec.remotePort}`,
    ...(spec.reverse ? ['-R', `127.0.0.1:${spec.reverse.remotePort}:127.0.0.1:${spec.reverse.localPort}`] : []),
    spec.user ? `${spec.user}@${spec.host}` : spec.host,
  ]
}

/** Health/identity probe targets on the forwarded URL, in the order the plan
 *  checks them. `capabilities` must contain `api.runtime-url.v1` — that is the
 *  one openchamber's own host probe treats as a hard requirement. */
export const REQUIRED_INSTANCE_CAPABILITY = 'api.runtime-url.v1'

export interface InstanceVersionPayload {
  status?: string
  openchamberVersion?: string
  compatibility?: { apiVersion?: number; minClientApiVersion?: number; capabilities?: string[] }
  serverId?: string
}

export type InstanceProbe =
  | { ok: true; version: string; capabilities: string[]; serverId?: string }
  | { ok: false; error: string }

/** `GET /api/opencode/compatibility` — what the **running instance** actually
 *  launched. This is the only honest answer to "which engine is behind the
 *  panel": `up`'s own pick is what we *asked* for, this is what is serving. */
export interface EngineCompatPayload {
  state?: string
  version?: string
  binary?: string
  port?: number
}

export type CompatJudgement =
  | { ok: true; version: string; binary: string }
  | { ok: false; error: string }

/** R12 assertion point ③ (plan §2.1): refuse anything that is not a v2 engine
 *  behind an absolute path. An instance that adopted a leftover process, or one
 *  whose `OPENCODE_BINARY` was ignored, shows up here — not in the user's face
 *  three clicks later. */
export function judgeEngineCompat(payload: EngineCompatPayload | undefined): CompatJudgement {
  if (!payload || typeof payload !== 'object') return { ok: false, error: '实例没有返回引擎兼容性' }
  const state = String(payload.state ?? '')
  const version = normalizeEngineVersion(String(payload.version ?? ''))
  const binary = String(payload.binary ?? '')
  if (state !== 'compatible') {
    return { ok: false, error: `实例引擎兼容性 state=${state || '（空）'}（需要 compatible）` }
  }
  if (!isSupportedEngineVersion(version)) {
    return { ok: false, error: `实例用的引擎 ${version || '（版本未知）'} 不满足 v2 门禁（需 major=2 且 ≥ ${MIN_ENGINE_VERSION}）${binary ? `；二进制 ${binary}` : ''}` }
  }
  if (!binary.startsWith('/')) {
    return { ok: false, error: `实例报的引擎路径不是绝对路径：${binary || '（空）'}` }
  }
  return { ok: true, version, binary }
}

/** Judge `/api/version`. Missing capability or major < 2 = refuse (same rule as
 *  the desktop probe), so we fail here rather than inside the user's browser. */
export function judgeInstanceVersion(payload: InstanceVersionPayload | undefined): InstanceProbe {
  if (!payload || typeof payload !== 'object') return { ok: false, error: '实例没有返回版本信息' }
  const version = String(payload.openchamberVersion ?? '')
  if (payload.status !== 'ok' || !version) {
    return { ok: false, error: `实例版本响应不是 openchamber（收到 ${JSON.stringify(payload).slice(0, 120)}）` }
  }
  const capabilities = payload.compatibility?.capabilities ?? []
  if (!capabilities.includes(REQUIRED_INSTANCE_CAPABILITY)) {
    return { ok: false, error: `实例缺少能力 ${REQUIRED_INSTANCE_CAPABILITY}（版本 ${version}）——升级实例` }
  }
  if (Number(version.split('.')[0]) < 2) return { ok: false, error: `实例版本 ${version} 过旧（需要 major=2）` }
  return { ok: true, version, capabilities, serverId: payload.serverId }
}
