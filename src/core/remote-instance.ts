/**
 * Remote openchamber instances (dev plan §3.1) — the pure half.
 *
 * Why this exists: openchamber's project/file/git faces resolve **inside the
 * serving process** (`project-directory-runtime.validateDirectoryPath` is an
 * `fsPromises.stat`; `lib/fs/routes.js` reads the local disk). So "Add project
 * 列远程机器 / 中栏连远程机器引擎" is satisfied by running the instance **on the
 * controlled host** and looking at its UI through a forwarded port — zero
 * patches to openchamber. This module owns the decisions and the shell lines;
 * the ssh transport, store and the ops layer live next door
 * (`core/remote-instance-bridge.ts`, `extensions/ocrc/src/service/`).
 *
 * Two hard rules encoded here (plan §2.1 / R12):
 *   · **Engine must be opencode v2, major 2, >= 2.0.20** — never fall back to
 *     v1. The controlled host typically has a v1 (`~/.local/bin/opencode`
 *     1.18.x) sitting next to our v2, and openchamber refuses v1 outright
 *     (`Failed to start OpenCode: OpenCode 1.18.31 is installed…`).
 *   · **Paths are pinned absolute** — no PATH resolution anywhere.
 */
import type { SshAuthMode, SshAuthSpec } from './ssh-askpass.js'

export interface RemoteInstance extends SshAuthSpec {
  id: string
  /** Display name; defaults to host. */
  name?: string
  host: string
  /** SSH port. */
  port: number
  user?: string
  /** 认证档（A1）：`key` 用本机密钥/agent；`password` 走 askpass 喂密码。
   *  缺省 = `key`。 */
  sshAuth?: SshAuthMode
  /** 密码档的密码。只落在 0600 的 `~/.ocrc/remote-instances.json` 里，
   *  `redactInstance` 之后任何 HTTP/CLI 输出都不含它；ssh 子进程经
   *  `OPENCHAMBER_SSH_ASKPASS_VALUE` 拿到它（helper 脚本里没有秘密）。 */
  sshPassword?: string
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
   *  control side's proxy on `<localPort>`. This is the path for a controlled
   *  host without public egress; `egress` decides whether it is used. */
  proxy?: InstanceProxyConfig
  /** Where this peer's egress goes; default `auto` (probe the peer, relay only
   *  if it cannot get out itself). */
  egress?: EgressMode
  /** 装机方式（A3）：
   *   · `push`（默认）—— 控制端备件推过去：运行时 + 我们 pin 的引擎 + 应用，
   *     对端零联网。对端只有 v1 引擎时这是唯一能跑的路（R12）。
   *   · `reuse` —— 一个字节都不推。只做检查（运行时/应用是否在位、引擎是否过
   *     v2 门禁）并把引擎 pin 下来；缺件就明确失败，让人改回推包。 */
  provision?: ProvisionMode
  /** C2b: per-peer provider `baseURL` rewrites, applied during a config sync.
   *  A peer without its own egress may only reach a provider through our relay or
   *  an internal gateway, so the URL the control side uses is not always the one
   *  the peer must use. Opt-in and explicit — we never guess a URL. */
  providerBaseUrl?: Record<string, string>
}

export type ProvisionMode = 'push' | 'reuse'

/** What `plan` knows about the peer when it writes the "将要做的" list. */
export interface ProvisionFacts {
  provision?: ProvisionMode
  /** Runtime version found on the peer (`undefined` = missing). */
  runtime?: string
  /** App version found on the peer (`undefined` = missing). */
  app?: string
  /** The app version we would install. */
  targetAppVersion: string
  engineOk: boolean
  engineError?: string
  /** Engine pin we deploy when the peer has none. */
  enginePin?: string
}

/**
 * The action list for one provisioning mode. Pure, so the promise the user reads
 * before pressing anything is testable on its own — and so "推包" and "复用档"
 * cannot describe the same peer differently.
 *
 * The reuse list is deliberately a checklist of what must already be true, with
 * `FAIL` prefixes: that mode writes **nothing**, so the only useful thing it can
 * say is which precondition is missing.
 */
export function provisionActions(f: ProvisionFacts): string[] {
  const appOk = !!f.app && f.app === f.targetAppVersion
  if (f.provision === 'reuse') {
    const out = ['复用已安装：不推送任何字节（运行时 / OpenChamber / OpenCode 都保持远程机器现状）']
    if (!f.runtime) out.push('FAIL 运行时缺失——复用已安装下无法继续，把安装方式改回「推送安装」')
    if (!appOk) out.push(`FAIL OpenChamber 缺失或版本不符（远程机器 ${f.app ?? '缺失'} ≠ ${f.targetAppVersion}）——改回「推送安装」`)
    if (!f.engineOk) out.push(`FAIL OpenCode 不满足 v2 门禁：${f.engineError ?? '原因未知'}`)
    if (f.runtime && appOk && f.engineOk) out.push('检查通过，可以直接启动')
    return out
  }
  const out: string[] = []
  if (!f.runtime) out.push(`推送运行时 node v${f.runtime ?? NODE_RUNTIME.version}（控制端已备件，离线）`)
  if (!appOk) out.push(`推送 OpenChamber ${f.targetAppVersion} 到 ~/.ocrc/remote/openchamber/${f.targetAppVersion}（旧树留 .ocrc-bak）`)
  if (f.runtime && appOk) out.push('运行时与 OpenChamber 都在位，推送会跳过')
  if (!f.engineOk) {
    out.push(`安装我们 pin 的 OpenCode ${f.enginePin ?? DEFAULT_ENGINE_PIN} 到 ~/.ocrc/remote/engine/opencode（远程机器现有 v1 一律不动）`)
  }
  return out
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

/** Where the peer's egress goes. `auto` asks the peer and relays **only** when it
 *  cannot get out itself: a peer with its own internet must not be routed through
 *  the control side (it would pay a detour, and it would lose egress whenever the
 *  control machine is off). `proxy.enabled === false` still forces direct. */
export type EgressMode = 'auto' | 'relay' | 'direct'

export const EGRESS_DEFAULT: EgressMode = 'auto'

/** What the probe found. DNS and TCP are separated because they fail differently
 *  and the operator's fix differs — and because a host with a resolver but no
 *  route still cannot reach a model provider. */
export type EgressProbe = 'direct' | 'dns-only' | 'none' | 'unknown'

/**
 * The address that decides "has egress": **models.dev**, because that is the thing
 * the instance actually needs (openchamber fetches its provider/model catalogue
 * from `https://models.dev/api.json` — `server/lib/opencode/models-metadata.js`).
 * An empty catalogue is what "the peer has no internet" looks like from inside the
 * panel, so probing the install channel (npmjs) answered a different question: a
 * peer behind an allowlist that permits npm but not models.dev would have been
 * judged direct while its provider list stayed empty.
 */
export const EGRESS_PROBE_URL = 'https://models.dev/api.json'

/**
 * Controlled host: can it reach the internet on its own?
 *
 * The answer must be about the **consumer's** path, not about a packet, so the
 * implementation is a chain and the chain is family-aware:
 *   · `curl` first — it honours the peer's own `http_proxy`/`HTTPS_PROXY` by
 *     default, so a peer that gets out through its own proxy is correctly "direct"
 *     (measured on Ubuntu while it ran its own proxy: raw TCP failed, the peer
 *     itself got out fine).
 *   · **IPv4 before IPv6, and IPv6 only if IPv4 failed.** Measured on the same
 *     Ubuntu: it has a v6 default route but a broken v6 egress, its resolver hands
 *     back AAAA records first, and curl's 4 s connect budget was spent on the dead
 *     family — a plain `curl` reported a timeout while `curl -4` returned 200 in
 *     3.3 s. One family is not the peer.
 *   · `wget` next (same env semantics, different flags), then the pushed Node as a
 *     last resort — it can only test DNS+TCP and cannot see a proxy, so it is the
 *     weakest of the three (documented).
 *
 * Verdicts stay the same four words; only the method changed. Cost: ~3-4 s for a
 * peer that works, ~6-12 s for one that cannot get out (both attempts must fail
 * before "no egress" is a supported claim), cached for five minutes.
 */
export function buildEgressProbeCommand(o: { appVersion: string; url?: string; host?: string; timeoutMs?: number; deadlineMs?: number }): string {
  const p = instancePaths(o.appVersion)
  const url = o.url ?? EGRESS_PROBE_URL
  // The node fallback runs only when curl/wget are missing or were killed by the
  // outer cap, so its own budget is deliberately small: 1.5 s to learn whether the
  // resolver answers at all, 1.5 s per literal-IP connect, 6 s overall.
  const timeout = o.timeoutMs ?? 1_500
  const deadline = o.deadlineMs ?? 6_000
  // A dead resolver makes `getaddrinfo` sit on its own retry schedule (measured on
  // the offline EL7: the lookup outlived the whole budget), which would turn "DNS is
  // dead" into "could not measure". Racing it against a short timer and falling
  // through to a literal IP keeps the two apart: literal IP unreachable → `none`
  // (a supported claim), literal IP reachable → `dns-only`.
  const nodeProbe = [
    "const dns=require('dns'),net=require('net')",
    `const H=${JSON.stringify(o.host ?? 'models.dev')},T=${timeout}`,
    'const done=(v)=>{console.log(v);process.exit(0)}',
    `setTimeout(()=>done('unknown'),${deadline})`,
    'const tryList=(list,viaDns)=>{let i=0;const next=()=>{'
      + 'if(i>=list.length)return done(viaDns?"dns-only":"none");'
      + 'const a=list[i++];const s=net.connect({host:a.address,port:443,timeout:T},()=>{s.destroy();done("direct")});'
      + 's.on("error",()=>{s.destroy();next()});s.on("timeout",()=>{s.destroy();next()})};next()}',
    'let answered=false',
    'const fallback=()=>{if(answered)return;answered=true;tryList([{address:"1.1.1.1",family:4}],false)}',
    'setTimeout(fallback,1500)',
    `dns.lookup(H,{all:true},(e,all)=>{if(answered)return;answered=true;`
      + `if(e||!all||!all.length)return tryList([{address:'1.1.1.1',family:4}],false);`
      + 'tryList([...all].sort((x,y)=>x.family-y.family),true)})',
  ].join(';')
  const qq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  return [
    `U=${qq(url)}`,
    // `timeout` is the outer hard cap: curl's own `--max-time` cannot interrupt a
    // blocking `getaddrinfo`, so a peer with a *hanging* resolver (measured on the
    // offline EL7) kept curl busy for glibc's full retry schedule (~10 s per
    // family). A killed attempt (124) is **not** a verdict — it falls through to the
    // node probe, which bounds the resolver itself and can still separate "no
    // route" from "no resolver".
    'TMO=""; command -v timeout >/dev/null 2>&1 && TMO="timeout 5"',
    // curl: 0 = got a response (any status counts — a 401 from models.dev still
    // proves the route), 6 = could not resolve, 7 = could not connect, 28 = timeout.
    'if command -v curl >/dev/null 2>&1; then',
    '  $TMO curl -4 -sS -o /dev/null --connect-timeout 3 --max-time 5 "$U" >/dev/null 2>&1; r4=$?',
    '  [ "$r4" = 0 ] && { echo direct; exit 0; }',
    '  if [ "$r4" != 124 ]; then',
    '    $TMO curl -6 -sS -o /dev/null --connect-timeout 3 --max-time 5 "$U" >/dev/null 2>&1; r6=$?',
    '    [ "$r6" = 0 ] && { echo direct; exit 0; }',
    '    if [ "$r4" = 6 ] && [ "$r6" = 6 ]; then echo dns-only; exit 0; fi',
    '    for c in "$r4" "$r6"; do case "$c" in 6|7|28) ;; *) echo unknown; exit 0 ;; esac; done',
    '    echo none; exit 0',
    '  fi',
    'fi',
    // wget: 0 = fetched, 8 = the server answered with an error status (still a
    // route!), 4 = network failure, 6 = auth. So 8 counts as reachable.
    'if command -v wget >/dev/null 2>&1; then',
    '  $TMO wget -4 -q -T 4 -O /dev/null "$U" >/dev/null 2>&1; w4=$?',
    '  { [ "$w4" = 0 ] || [ "$w4" = 8 ]; } && { echo direct; exit 0; }',
    '  if [ "$w4" != 124 ]; then',
    '    $TMO wget -6 -q -T 4 -O /dev/null "$U" >/dev/null 2>&1; w6=$?',
    '    { [ "$w6" = 0 ] || [ "$w6" = 8 ]; } && { echo direct; exit 0; }',
    '    [ "$w4" = 4 ] && [ "$w6" = 4 ] && { echo none; exit 0; }',
    '    echo unknown; exit 0',
    '  fi',
    'fi',
    `${p.node} -e ${q(nodeProbe)}`,
  ].join('\n')
}

/**
 * Two family attempts → verdict, as a pure function so the mapping is testable
 * without a peer. `resolveFailure` is the code that means "could not resolve"
 * (curl 6, wget: none — wget folds DNS failures into 4), `unreachable` the codes
 * that mean "resolved but could not connect" (curl 7/28, wget 4).
 */
export function egressProbeFromAttempts(
  codes: readonly [number, number],
  opts: { reachable: readonly number[]; resolveFailure?: number; unreachable: readonly number[] },
): EgressProbe {
  if (codes.some((c) => opts.reachable.includes(c))) return 'direct'
  if (opts.resolveFailure !== undefined && codes.every((c) => c === opts.resolveFailure)) return 'dns-only'
  // Both families failed in a way we understand — that is a supported "no egress".
  if (codes.every((c) => opts.unreachable.includes(c) || c === opts.resolveFailure)) return 'none'
  return 'unknown'
}

/** curl's exit codes as the mapping above expects. */
export const CURL_EXIT_MAP = { reachable: [0], resolveFailure: 6, unreachable: [6, 7, 28] } as const
/** wget's: 8 is "server answered with an error status", which still proves a route. */
export const WGET_EXIT_MAP = { reachable: [0, 8], unreachable: [4] } as const

export function parseEgressProbe(stdout: string): EgressProbe {
  const last = stdout.trim().split(/\r?\n/).pop()?.trim()
  return last === 'direct' || last === 'dns-only' || last === 'none' ? last : 'unknown'
}

/** The policy, as a pure function so it is testable without a host: **only a
 *  probe that positively succeeded keeps us out of the peer's path**. Everything
 *  else — including a probe that could not run — relays, because silently losing
 *  egress is worse than an unnecessary detour. */
export function resolveEgressPolicy(o: {
  mode?: EgressMode
  relayAllowed: boolean
  probe?: EgressProbe
}): { relay: boolean; reason: string } {
  const mode = o.mode ?? EGRESS_DEFAULT
  if (!o.relayAllowed) return { relay: false, reason: 'relay 已关闭' }
  if (mode === 'direct') return { relay: false, reason: '按配置直连' }
  if (mode === 'relay') return { relay: true, reason: '按配置经本机转发' }
  switch (o.probe) {
    case 'direct': return { relay: false, reason: '远程机器自己能出网' }
    case 'dns-only': return { relay: true, reason: '远程机器有路由但 DNS 不通' }
    case 'none': return { relay: true, reason: '远程机器出不了网' }
    default: return { relay: true, reason: '探测未成功——保守经本机转发' }
  }
}

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

/** API/log-facing view: neither secret leaves the store. `sshPassword` is the
 *  one the panel must never echo — it is a credential for **someone else's
 *  machine**, so it is dropped the same way the UI password is, and the caller
 *  gets a boolean to render "已设置/未设置" from. */
export type RedactedInstance = Omit<RemoteInstance, 'uiPassword' | 'sshPassword'> & {
  hasUiPassword: boolean
  hasSshPassword: boolean
}
export function redactInstance(i: RemoteInstance): RedactedInstance {
  const { uiPassword, sshPassword, ...rest } = i
  return { ...rest, hasUiPassword: !!uiPassword, hasSshPassword: !!sshPassword }
}

/** openchamber gate: `server/lib/opencode/compatibility.js`. */
export const MIN_ENGINE_VERSION = '2.0.20'
export const ENGINE_MAJOR = 2

/** Engine version we deploy to a controlled host (R12: a **pin**, never
 *  "latest"). 2.0.32 is the version the component adapters are verified
 *  against (deep-memory's v2 gate; opencode-deep-memory README §compatibility).
 *  A bin-cache manifest or `OCRC_V2_PIN` overrides it, and the CLI can name one
 *  explicitly. */
export const DEFAULT_ENGINE_PIN = '2.0.32'

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
    return { ok: false, error: `远程机器上没有找到满足 v2 门禁的 OpenCode（候选：${DEFAULT_ENGINE_CANDIDATES.join(', ')}）——先装一份 v2（面板的「检查并安装」会推我们 pin 的那份）`, seen: [] }
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
  /** Extra env vars to export on the controlled host. The control side picks
   *  the names and supplies the values (see `OCRC_INSTANCE_ENV`); this is how a
   *  peer engine gets `{env:VAR}` references resolved without putting a secret
   *  in its config file. */
  extraEnv?: Record<string, string>
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
    ...o.extraEnv,
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

/** Controlled host: ask the running instance for a single-use pairing link.
 *
 *  Identity is openchamber's job here — the link carries a one-time secret that
 *  the desktop app redeems for a per-device, revocable client token, so nothing
 *  of ours stores a password. `--server` is the address the *client* will dial,
 *  which is why it must be the forward the control side holds (openchamber calls
 *  that "this computer only"). The caller checks that a server is already
 *  listening: `connect-url` would otherwise start a second one. */
export function buildPairLinkCommand(o: {
  appVersion: string
  instancePort: number
  serverUrl: string
  label: string
}): string {
  const p = instancePaths(o.appVersion)
  return `${p.node} ${p.cli} connect-url --port ${o.instancePort} --server ${q(o.serverUrl)} --name ${q(o.label)}`
}

/** The `openchamber://connect?v=2&p=<base64url>` link out of `connect-url`'s boxed output. */
export function parsePairLink(output: string): string | undefined {
  return output.match(/openchamber:\/\/connect\?v=2&p=[A-Za-z0-9_-]+/)?.[0]
}

/** What the link says, for display: label, expiry, route count. Never the
 *  secret — that belongs to the app that redeems it. */
export function describePairLink(link: string): { label?: string; expiresAt?: string; candidates: number } | undefined {
  try {
    const payload = JSON.parse(Buffer.from(new URL(link).searchParams.get('p') ?? '', 'base64url').toString('utf8'))
    return {
      ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
      ...(typeof payload.expiresAt === 'string' ? { expiresAt: payload.expiresAt } : {}),
      candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    }
  } catch {
    return undefined
  }
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
 *  both are; the provisioning/forward layers only need this much.
 *
 *  `sshAuth`/`sshPassword` are the two-mode choice from plan A1. Absent
 *  `sshAuth` = `key`, which is what every existing record and caller means. */
export interface SshTargetRef extends SshAuthSpec {
  host: string
  port?: number
  user?: string
}

/**
 * Auth mode → ssh options (A1). One function so the one-shot path and the
 * tunnel path cannot drift apart — a tunnel that authenticates differently from
 * the probe that just succeeded is a bug that only shows up as
 * "预演通过，启动失败".
 *
 *   · **key** (default): `BatchMode=yes`. A prompt nobody can answer is an
 *     error we want immediately, not a hang.
 *   · **password**: `BatchMode` must go off or ssh never consults the askpass
 *     helper. `PubkeyAuthentication=no` is not cosmetic: with a
 *     passphrase-protected key in `~/.ssh`, ssh would offer that key first, fail,
 *     and only then ask for a password — turning the user's own key into a
 *     source of confusing "wrong passphrase" failures for a peer we were told to
 *     reach with a password. `NumberOfPasswordPrompts=1` keeps one bad password
 *     from eating the whole 20 s host-proxy budget in retries.
 */
export function sshAuthArgs(target: SshTargetRef): string[] {
  if (target.sshAuth !== 'password') return ['-o', 'BatchMode=yes']
  return [
    '-o', 'BatchMode=no',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=1',
  ]
}

/** ssh argv for a **one-shot** remote command (probes, provisioning scripts).
 *  No `-N`, no forward: the remote shell runs `command` and exits. */
export function buildSshExecArgs(target: SshTargetRef, command: string): string[] {
  return [
    ...sshAuthArgs(target),
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

/** Remote: is a port already taken **on the peer**? A3 shows the answer next to
 *  the instance-port field, because a busy port is the most common start failure
 *  and the one the user can still fix before anything is written.
 *
 *  Three ways to answer, in order of trust: the runtime we push (an exact
 *  connect), then `ss`/`netstat` (a listening-socket listing), then **unknown**.
 *  `unknown` is a real answer and is reported as one — a fresh peer has neither
 *  our runtime nor necessarily `ss`, and "we could not tell" must never be shown
 *  as "free" (that is the shape of bug where the user is told a port is fine and
 *  the start then fails). */
export function buildPeerPortProbeCommand(appVersion: string, port: number): string {
  const node = instancePaths(appVersion).node
  const js = `const n=require('net');const s=n.connect(${port},'127.0.0.1',()=>{console.log('open');s.destroy();process.exit(0)});s.on('error',()=>{console.log('closed');process.exit(0)});setTimeout(()=>{console.log('closed');s.destroy();process.exit(0)},2000)`
  return [
    `if [ -x ${node} ]; then ${node} -e "${js}";`,
    `elif command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q "[:.]${port} " && echo open || echo closed;`,
    `elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | grep -q "[:.]${port} " && echo open || echo closed;`,
    'else echo unknown; fi',
  ].join(' ')
}

/** `open` / `closed` / `unknown` — anything else is treated as unknown. */
export function parsePortProbe(stdout: string): 'open' | 'closed' | 'unknown' {
  const last = (stdout ?? '').trim().split('\n').pop()?.trim() ?? ''
  return last === 'open' || last === 'closed' ? last : 'unknown'
}

/**
 * Remote: which egress the **running** instance was started with.
 *
 * Why this exists: the relay env is decided when the instance starts, so a peer
 * whose internet disappears (or comes back) keeps running with the *old* decision
 * until it is restarted — and `up` used to answer "已在服务，复用，不重启" while the
 * engine silently had no egress at all (measured on EL7 with its internet cut:
 * policy flipped to relay, running instance carried zero proxy variables, `up`
 * still said online).
 *
 * Two details that only a live run reveals:
 *   · The instance port is the discriminator, **not** the command shape. Our serve
 *     line is `<node> <cli.js> serve --hostname 127.0.0.1 --port 2610`, but the
 *     process that ends up holding the listener is openchamber's own child,
 *     `.../server/index.js --port 2610 -`. Matching on `serve --hostname` found
 *     nothing (measured), so we match on `--port <instancePort>`.
 *   · The port travels as a **shell variable**: a `sh -c` script carries its own
 *     text in argv, so a literal `--port 2610` would match the probing shell and
 *     report the wrong process.
 */
export function buildInstanceProxyProbeCommand(_appVersion: string, port: number): string {
  return [
    `PORT=${port}`,
    'ME=$$',
    'FOUND=""',
    'for d in /proc/[0-9]*; do',
    '  pid=${d#/proc/}',
    '  [ "$pid" = "$ME" ] && continue',
    '  c=$(tr \'\\0\' \' \' < "$d/cmdline" 2>/dev/null) || continue',
    '  case "$c" in *"--port $PORT"*)',
    '    case "$c" in *".ocrc/remote"*) FOUND="$pid"; break ;; esac',
    '    [ -n "$FOUND" ] || FOUND="$pid"',
    '  ;; esac',
    'done',
    'if [ -z "$FOUND" ]; then echo "PROXY=unknown";',
    'elif tr \'\\0\' \'\\n\' < "/proc/$FOUND/environ" 2>/dev/null | grep -q "^HTTPS_PROXY="; then',
    '  tr \'\\0\' \'\\n\' < "/proc/$FOUND/environ" 2>/dev/null | sed -n "s/^HTTPS_PROXY=//p" | head -1 | sed "s/^/PROXY=/"',
    'else echo "PROXY=none"; fi',
  ].join('\n')
}

/** `none` (no proxy at all) / `unknown` (no serve process found) / the URL. */
export function parseInstanceProxyProbe(stdout: string): 'none' | 'unknown' | string {
  const line = (stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('PROXY=')).pop()
  if (!line) return 'unknown'
  const value = line.slice('PROXY='.length).trim()
  if (!value || value === 'unknown') return 'unknown'
  return value === 'none' ? 'none' : value
}

/** The relay URL the engine must carry when this peer goes through us. */
export function relayProxyUrl(remotePort: number): string {
  return `http://127.0.0.1:${remotePort}`
}

/** D3: the two peer-side logs that explain a failure, in one round trip.
 *
 *  `instance.log` is **ours** (the `nohup` redirect of the serve line: startup
 *  errors, the engine's own complaints) and `~/.config/openchamber/logs/
 *  openchamber-<port>.log` is the instance's own (HTTP layer, guests, the
 *  desktop-facing bits). Diagnosing "it is running but nothing works" needs both,
 *  and asking for them separately would double the round trips for no reason.
 *
 *  The log name carries the **instance port** because that is how openchamber
 *  names it (one file per served port), and the glob is deliberately not used:
 *  a peer running two instances must not hand us the other one's log. */
export function buildPeerLogCommand(appVersion: string, port: number, lines = 40): string {
  const p = instancePaths(appVersion)
  const appLog = `$HOME/.config/openchamber/logs/openchamber-${port}.log`
  return [
    `echo "PATH_INSTANCE=${p.log}"`,
    `echo "PATH_APP=${appLog}"`,
    'echo "INSTANCE_BEGIN"',
    `tail -n ${lines} ${p.log} 2>/dev/null`,
    'echo "INSTANCE_END"',
    'echo "APP_BEGIN"',
    `tail -n ${lines} ${appLog} 2>/dev/null`,
    'echo "APP_END"',
    'echo "DONE=1"',
  ].join('\n')
}

export interface PeerLogs {
  instance: string[]
  app: string[]
  paths: { instance: string; app: string }
}

export function parsePeerLogs(stdout: string): PeerLogs {
  const section = (name: string): string[] => {
    const m = new RegExp(`${name}_BEGIN\\r?\\n([\\s\\S]*?)\\r?\\n${name}_END`).exec(stdout)
    if (!m) return []
    return m[1].split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0)
  }
  return {
    instance: section('INSTANCE'),
    app: section('APP'),
    paths: {
      instance: /^PATH_INSTANCE=(.*)$/m.exec(stdout)?.[1]?.trim() ?? '',
      app: /^PATH_APP=(.*)$/m.exec(stdout)?.[1]?.trim() ?? '',
    },
  }
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
export interface ForwardSpec extends SshAuthSpec {
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
    ...sshAuthArgs(spec),
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

/** Reverse-only forward for the external-tunnel mode: the desktop shell owns
 *  the UI's `-L`, this process owns the `-R` egress leg. Same ssh options, no
 *  `-L`, so the two processes cannot fight over the local port. */
export function buildRelayForwardArgs(spec: ForwardSpec): string[] {
  if (!spec.reverse) throw new Error('relay forward requires a reverse spec')
  const args = buildForwardArgs(spec)
  const i = args.indexOf('-L')
  if (i !== -1) args.splice(i, 2)
  return args
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
  if (!payload || typeof payload !== 'object') return { ok: false, error: '实例没有返回 OpenCode 兼容性' }
  const state = String(payload.state ?? '')
  const version = normalizeEngineVersion(String(payload.version ?? ''))
  const binary = String(payload.binary ?? '')
  if (state !== 'compatible') {
    return { ok: false, error: `实例的 OpenCode 兼容性 state=${state || '（空）'}（需要 compatible）` }
  }
  if (!isSupportedEngineVersion(version)) {
    return { ok: false, error: `实例用的 OpenCode ${version || '（版本未知）'} 不满足 v2 门禁（需 major=2 且 ≥ ${MIN_ENGINE_VERSION}）${binary ? `；二进制 ${binary}` : ''}` }
  }
  if (!binary.startsWith('/')) {
    return { ok: false, error: `实例报的 OpenCode 路径不是绝对路径：${binary || '（空）'}` }
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
