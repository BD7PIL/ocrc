/**
 * Remote instance lifecycle (dev plan §3 launch/forward, §4 P4) — the half that
 * actually drives ssh.
 *
 * Three things this module is responsible for, each tied to a requirement:
 *   · **Engine gate on every path that can start something** (R12): `plan`,
 *     `apply` and `up` all refuse to proceed when the far side has no opencode
 *     v2 (major 2, ≥ 2.0.20). A pinned `enginePath` must itself satisfy the gate;
 *     we never silently swap the user's pin for another binary.
 *   · **Restart-restore** (R10): the persisted list plus `ensureAll()` is what
 *     re-establishes every tunnel after the control side restarts.
 *   · **Forward supervision** (R10): keepalives are in the ssh args, and an
 *     unexpected exit reconnects with `nextRetryDelay` (2s→60s) — toggled by
 *     `instance.reconnect`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ocrcHome } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'
import { parseGlibcVersion, nextRetryDelay } from './remote-common.js'
import { createInstanceProxy, type InstanceProxy } from './remote-instance-proxy.js'
import {
  DEFAULT_APP_VERSION, DEFAULT_ENGINE_CANDIDATES, DEFAULT_ENGINE_PIN, PROXY_DEFAULTS, buildEngineProbeCommand,
  buildForwardArgs, buildRelayForwardArgs, buildInstanceServeCommand, buildInstanceStopCommand, buildRemotePortProbeCommand, buildSshExecArgs,
  buildPeerPortProbeCommand, parsePortProbe, provisionActions, buildPeerLogCommand, parsePeerLogs, type PeerLogs,
  buildInstanceProxyProbeCommand, parseInstanceProxyProbe, relayProxyUrl,
  buildPairLinkCommand, parsePairLink, describePairLink, buildEgressProbeCommand, parseEgressProbe, resolveEgressPolicy,
  EGRESS_DEFAULT, type EgressMode, type EgressProbe, type ProvisionMode,
  buildTerminalProbeCommand, instancePaths, parseTerminalProbe,
  judgeEngineCompat, judgeInstanceVersion, parseEngineProbe, pickV2Engine, type EngineCandidate,
  type EngineCompatPayload, type EnginePick, type ForwardSpec, type InstanceProxyConfig,
  type RemoteInstance, type SshTargetRef,
} from './remote-instance.js'
import { appPackTierForGlibc, buildAppProbeCommand, buildOfflineGuardExports, buildRuntimeProbeCommand, provisionOffline, sshRun, sshRunWithStdin, type AppPackTier, type SshResult } from './remote-instance-push.js'
import {
  buildAuthPushScript, buildConfigApplyScript, buildPeerConfigReadScript, diffConfig, discardStaging,
  parsePeerConfigRead, planConfigSync, readLocalConfig, stageConfigTree,
} from './instance-config.js'
import { defaultComponentSources, installPreparedComponent, pluginEntryFor, prepareComponent, registerPeerPlugins } from './components.js'
import { renderConfig } from './config-merge.js'
import { askpassEnv } from './ssh-askpass.js'
import { clearForwardMarker, describeHolders, findHolder, writeForwardMarker, type ForwardKind } from './forward-ownership.js'
import type { RemoteInstancesStore } from './remote-instances.js'

const log = createLogger('remote-instance')

/** How often external mode re-checks the far side it cannot watch. */
const EXTERNAL_MONITOR_MS = 20_000

export type InstanceState =
  | 'unknown' | 'checking' | 'provisioning' | 'starting' | 'online'
  | 'offline' | 'error' | 'disabled'

export interface InstanceStatus {
  id: string
  state: InstanceState
  detail?: string
  since?: number
  /** `http://127.0.0.1:<localPort>` — the URL the user actually opens. */
  url: string
  /** Who owns the UI tunnel: this manager (`self`) or the desktop shell (`external`). */
  tunnelOwner?: 'self' | 'external'
  forwardPid?: number
  forwardAttempts?: number
  /** D7: one line per forward leg that has a holder on disk (ui/relay/pair),
   *  with pid and role — the difference between "nobody holds it" and "someone
   *  else does" used to be invisible, and that is what broke egress once. */
  holders?: string[]
  engine?: { path: string; version: string }
  runtime?: string
  app?: string
  inspected?: InstanceInspection
  /** P6: 终端能不能用（node-pty 的 GLIBCXX 依赖在 EL7 上是硬伤）；未修就如实标注。 */
  terminal?: { ok: boolean; reason?: string }
  /** R9: where the controlled host's egress comes out, and what it has dialled. */
  proxy?: { enabled: boolean; localPort: number; remotePort: number; listening: boolean; connects: string[] }
  /** D1: the egress **decision** (not just the relay config) with its reason, so
   *  a peer that is direct by design never looks like a missing relay. */
  egress?: { mode: EgressMode; relay: boolean; reason: string; probe?: EgressProbe; cached: boolean }
  logTail: string[]
}

export interface InstanceInspection {
  uname?: string
  glibc?: string
  home?: string
}

export interface InstancePlan {
  id: string
  target: string
  reachable: boolean
  sshError?: string
  inspected?: InstanceInspection
  runtime?: string
  app?: string
  engine?: { path: string; version: string }
  engineError?: string
  engineCandidates: EngineCandidate[]
  actions: string[]
  url: string
  /** A3: the effective egress policy, probed while planning when the mode is
   *  `auto` — "auto" is only a choice, the user still has to see what it picked. */
  egress?: { mode: EgressMode; relay: boolean; reason: string; probe?: EgressProbe }
  /** A3: 推包 or 复用已有 — what the 装机 button will do. */
  provision?: ProvisionMode
  /** A3: which app pack this peer gets, decided by its glibc (legacy rebuilds
   *  node-pty). Shown read-only — it is derived, never a user choice. */
  tier?: AppPackTier
  /** A3: is the instance port already taken on the peer? `unknown` when neither
   *  our runtime nor `ss`/`netstat` could answer — never silently "free". */
  peerPort?: 'open' | 'closed' | 'unknown'
}

export interface InstanceOutcome { ok: boolean; detail: string }

/** C1: what a sync would change, as the panel shows it before anything moves. */
export interface InstanceConfigDiff {
  localDir: string
  add: string[]
  change: string[]
  same: string[]
  peerOnly: string[]
  unknown: string[]
  auth: { local: boolean; peer: boolean }
  /** What one sync would do right now (the same plan the apply step uses). */
  plan: {
    basename: string
    configChanged: boolean
    files: string[]
    deletes: string[]
    keyDeletes: { requested: string[]; removed: string[] }
    keyDeleteCandidates: Array<{ collection: string; key: string }>
    /** v2 `plugins` entries the components being installed require. */
    managedPlugins: string[]
    droppedManagedKeys: string[]
    secretsReplaced: Array<{ path: string; env: string }>
    baseUrlRewrites: Array<{ provider: string; from?: string; to: string }>
    commentsWillBeLost?: boolean
    /** Keys the peer's own commented layer will keep overriding (see
     *  `findShadowedKeys`): the reason a sync can look like it did nothing. */
    shadowed: string[]
    notes: string[]
  }
  peerError?: string
}

export interface InstanceConfigOutcome { ok: boolean; detail: string }

export interface RemoteInstanceManager {
  plan(id: string): Promise<InstancePlan>
  /** P2: push runtime + engine + app (offline path) — the engine gate runs first. */
  apply(id: string, opts?: { force?: boolean; engineVersion?: string; guard?: boolean; trace?: string; onLog?: (line: string) => void; tier?: AppPackTier; components?: string[]; componentsFromPins?: boolean }): Promise<InstanceOutcome>
  /** D5: move this peer to the control side's app pin. The version is a **pin,
   *  not a choice** (the user settled that), so the only upgrade question is
   *  "the peer is on an older pin than I am" — this answers it and does the
   *  apply in one step. */
  upgrade(id: string): Promise<InstanceOutcome & { from: string; to: string; changed: boolean }>
  /** Ensure the instance is serving on the far side and the tunnel is up.
   *  `guard` starts it under the poisoned-egress env (§5.3 offline proof). */
  up(id: string, opts?: { guard?: boolean }): Promise<InstanceOutcome>
  /** Stop the instance and tear the tunnel down (records are kept). */
  down(id: string): Promise<InstanceOutcome>
  /** 实测（不是读内存状态）：隧道能不能通 + 实例自己报的版本。
   *  CLI/路由在**另一个进程**里也能据此说真话——内存状态只在拥有隧道的进程里。
   *  `remote` 表示"远端实例在跑，但本地转发不在这个进程/这个端口上"（桌面壳自选端口、
   *  或另一进程持有隧道）——不把它当成 unknown。 */
  probe(id: string): Promise<{ online: boolean; version?: string; detail?: string; remote?: boolean }>
  /** Ask the peer's own openchamber for a single-use pairing link (identity stays
   *  upstream's: the link is redeemed for a per-device, revocable token). We only
   *  hold the `-L` that makes its URL reachable. */
  pairLink(id: string): Promise<{ ok: boolean; detail: string; link?: string; expiresAt?: string; url?: string }>
  status(id: string): InstanceStatus | undefined
  statusAll(): InstanceStatus[]
  /** D1: decide (and cache) where this peer's egress goes. `status` reads the
   *  cache only — it must not cost an ssh round trip — so a caller that wants a
   *  real answer on a cold process asks for it explicitly. */
  egress(id: string): Promise<{ mode: EgressMode; relay: boolean; reason: string; probe?: EgressProbe }>
  /** C1: local-vs-peer config diff, both directions. Read-only.
   *  `components` adds their plugin entries to the "what a sync would write" view. */
  configDiff(id: string, opts?: { components?: string[] }): Promise<InstanceConfigDiff>
  /** C1–C4: one explicit push of the whitelisted config (+ explicit deletions).
   *  `dryRun` computes everything and writes nothing. */
  syncConfig(id: string, opts?: { deletes?: string[]; keyDeletes?: string[]; dryRun?: boolean; preferCommentedTarget?: boolean; components?: string[] }): Promise<InstanceConfigOutcome>
  /** C3: provider credentials (`auth.json`) over ssh stdin, 0600 on the peer. */
  syncAuth(id: string): Promise<InstanceConfigOutcome>
  logs(id: string): string[]
  /** D3: the **peer-side** logs (our serve redirect + the instance's own), in one
   *  round trip. `logs` is the control side's tunnel log — different machine,
   *  different story, and a failure is rarely explained by both at once. */
  peerLogs(id: string, opts?: { lines?: number }): Promise<PeerLogs & { ok: boolean; error?: string }>
  /** Boot restore (R10 `restoreOnStart`): bring up every enabled record. */
  ensureAll(): void
  dispose(): void
}

const LOG_CAP = 200
/** How long a probe result is trusted before asking the peer again. */
const EGRESS_TTL_MS = 5 * 60_000

/** Effective R9 config for one instance (defaults filled in). */
export function proxyConfig(instance: RemoteInstance): InstanceProxyConfig {
  return {
    enabled: instance.proxy?.enabled ?? PROXY_DEFAULTS.enabled,
    localPort: instance.proxy?.localPort && instance.proxy.localPort > 0 ? instance.proxy.localPort : PROXY_DEFAULTS.localPort,
    remotePort: instance.proxy?.remotePort && instance.proxy.remotePort > 0 ? instance.proxy.remotePort : PROXY_DEFAULTS.remotePort,
    allow: instance.proxy?.allow ?? [],
  }
}

/** Is something already listening on the control-side relay port? (A detached
 *  `ocrc remote proxy-serve` from an earlier `up`, or an unrelated service —
 *  both mean "do not bind here".) */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.connect(port, '127.0.0.1')
    const done = (v: boolean) => {
      srv.destroy()
      resolve(v)
    }
    srv.once('connect', () => done(true))
    srv.once('error', () => done(false))
    srv.setTimeout(1_000, () => done(false))
  })
}

/** ssh prints advisory lines that are not our story (post-quantum warning, host
 *  key notices). Kept out of log tails so a real error is readable. */
export function cleanSshNoise(text: string): string {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => !/^\*\* WARNING: connection is not using/.test(l))
    .filter((l) => !/^\*\* This session may be vulnerable/.test(l))
    .filter((l) => !/^\*\* The server may need to be upgraded/.test(l))
    .filter((l) => !/^Warning: Permanently added /.test(l))
    .join('\n')
}

/** Remote: one round of environment facts (uname / glibc / HOME). */
export function buildInstanceEnvProbeCommand(): string {
  return [
    'echo "UNAME=$(uname -s -m 2>/dev/null)"',
    'echo "LDD=$(ldd --version 2>/dev/null | head -1)"',
    'echo "HOME=$HOME"',
  ].join('; ')
}

/** Remote: HTTP health of the instance **on the controlled host** — answered
 *  before any tunnel exists, so `up` can tell "start it" from "just forward it".
 *  Uses the runtime we pushed (a host may have no curl), and always prints one
 *  line: the status code, or `000`. */
export function buildRemoteHealthCommand(appVersion: string, port: number): string {
  const node = instancePaths(appVersion).node
  const js = `const h=require('http');const r=h.get({host:'127.0.0.1',port:${port},path:'/health',timeout:3000},s=>{console.log(s.statusCode);process.exit(0)});r.on('error',()=>{console.log('000');process.exit(0)});r.on('timeout',()=>{console.log('000');r.destroy();process.exit(0)})`
  return `if [ -x ${node} ]; then ${node} -e "${js}"; else echo 000; fi`
}

export function parseEnvProbe(out: string): InstanceInspection {
  const kv = new Map<string, string>()
  for (const line of (out ?? '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  return {
    uname: kv.get('UNAME') || undefined,
    glibc: parseGlibcVersion(kv.get('LDD')),
    home: kv.get('HOME') || undefined,
  }
}

interface InstanceRuntime {
  state: InstanceState
  detail?: string
  since?: number
  logs: string[]
  inspected?: InstanceInspection
  terminal?: { ok: boolean; reason?: string }
  runtimeVersion?: string
  appVersion?: string
  engine?: { path: string; version: string }
  forward?: ChildProcess
  forwardPid?: number
  /** The `-L` we hold for the pairing URL, when the desktop shell is not the one
   *  forwarding. Kept apart from `forward` so the relay bookkeeping is untouched. */
  pairForward?: ChildProcess
  /** Cached egress decision for this peer (see egressFor). */
  egress?: { relay: boolean; reason: string; probe?: EgressProbe; at: number }
  /** An `-R` relay adoption check is in flight (see ensureExternalRelayAsync). */
  relayPending?: boolean
  /** External-mode re-check timer (no child process to watch in that mode). */
  monitorTimer?: ReturnType<typeof setInterval>
  forwardAttempts: number
  forwardTimer?: ReturnType<typeof setTimeout>
  stopping: boolean
}

/** D7: which role is spawning a forward — the marker records it, because the two
 *  owners behave differently when they exit (a CLI tunnel is detached and
 *  outlives the command; a service tunnel dies with the service). */
function ownerRoleFor(detachedForwards: boolean): 'service' | 'cli' {
  return detachedForwards ? 'cli' : 'service'
}

/** Local port of the tunnel URL. */
export function instanceUrl(localPort: number): string {
  return `http://127.0.0.1:${localPort}`
}

/** The ssh fields every forward spec needs, taken from one place so no site can
 *  forget the auth mode — a tunnel that authenticates differently from the probe
 *  that just succeeded shows up as "预演通过，启动失败" and nothing else. */
function sshFields(instance: RemoteInstance): Pick<ForwardSpec, 'host' | 'port' | 'user' | 'sshAuth' | 'sshPassword'> {
  return {
    host: instance.host,
    port: instance.port,
    user: instance.user,
    sshAuth: instance.sshAuth,
    sshPassword: instance.sshPassword,
  }
}

export function createRemoteInstanceManager(opts: {
  store: RemoteInstancesStore
  /** Extra env prefix for the instance's own serve line (P3 injects the proxy). */
  serveEnvPrefix?: (instance: RemoteInstance) => string
  /**
   * Control-side env var names to forward into the instance's serve line.
   * Defaults to `OCRC_INSTANCE_ENV` (comma-separated). This is a **generic**
   * passthrough: ocrc does not know which var is a credential or what it is
   * for — it only makes `{env:VAR}` in the peer's config resolvable.
   */
  envPassthrough?: readonly string[]
  /**
   * How the tunnel process is owned:
   *   · `supervised` (default; the panel host) — piped stdio so the log tail is
   *     live, and `dispose()` tears it down;
   *   · `detached` (the CLI) — the tunnel must **outlive the command** that
   *     created it: spawned detached with stderr appended to
   *     `<ocrcHome>/remote-forward.log`, `unref()`ed so the CLI can exit, and
   *     `dispose()` leaves it alone. Without this split one of the two is wrong:
   *     a piped child keeps the CLI's event loop alive (so `up` hangs), and
   *     killing it on dispose makes `up` pointless.
   */
  forwards?: 'supervised' | 'detached'
  /**
   * Who owns the UI tunnel:
   *   · `self` (default) — this manager spawns `-L`/`-R` and reconnects;
   *   · `external` — the openchamber desktop shell owns the UI's `-L`. This
   *     manager still runs the local relay listener and owns the reverse `-R`
   *     leg, uses a short-lived verification forward for probes, and never
   *     spawns or kills the user's UI tunnel.
   */
  tunnelOwner?: 'self' | 'external'
  /** Override the control-side home used for the forward log. */
  home?: string
  forwardLogPath?: string
  /** C1: where the control side's opencode config lives (defaults to
   *  `~/.config/opencode`; the CLI/panel pass nothing). Injectable so the config
   *  sync can be exercised without touching the developer's own config. */
  localConfigDir?: string
  /** C3: the control side's `auth.json` (defaults to
   *  `~/.local/share/opencode/auth.json`). */
  localAuthPath?: string
}): RemoteInstanceManager {
  const runtimes = new Map<string, InstanceRuntime>()
  const detachedForwards = opts.forwards === 'detached'
  const externalTunnel = opts.tunnelOwner === 'external'
  const forwardLogPath = opts.forwardLogPath ?? join(opts.home ?? ocrcHome(), 'remote-forward.log')
  const passthroughNames = opts.envPassthrough
    ?? (process.env.OCRC_INSTANCE_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  /** Values for the names the *control side* chose; absent vars are dropped. */
  const passthroughEnv = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const name of passthroughNames) {
      const value = process.env[name]
      if (value !== undefined && value !== '') out[name] = value
    }
    return out
  }

  const rt = (id: string): InstanceRuntime => {
    let r = runtimes.get(id)
    if (!r) {
      r = { state: 'unknown', logs: [], forwardAttempts: 0, stopping: false }
      runtimes.set(id, r)
    }
    return r
  }

  const pushLog = (id: string, line: string) => {
    const clean = cleanSshNoise(line).trim()
    if (!clean) return
    const r = rt(id)
    for (const one of clean.split('\n')) if (one.trim()) r.logs.push(one.trim())
    if (r.logs.length > LOG_CAP) r.logs.splice(0, r.logs.length - LOG_CAP)
  }

  const setState = (id: string, state: InstanceState, detail?: string) => {
    const r = rt(id)
    r.state = state
    r.detail = detail
    r.since = Date.now()
    log.info(`instance ${id}: ${state}${detail ? ` — ${detail}` : ''}`)
  }

  const need = (id: string): RemoteInstance => {
    const instance = opts.store.get(id)
    if (!instance) throw new Error(`unknown remote instance ${id}`)
    return instance
  }

  const ssh = (instance: SshTargetRef, command: string, timeoutMs = 60_000) => sshRun(instance, command, { timeoutMs })

  // ── D7: forward ownership ───────────────────────────────────────────────────
  // A leg with no owner is what made the egress incident possible: nobody could
  // tell "nobody holds it" from "someone else holds it". Every spawn now writes a
  // marker, and every spawn looks first.

  const ownerRole = ownerRoleFor(detachedForwards)

  /** Look before spawning. A live holder means reuse (a second `-L` on the same
   *  port is a reconnect loop under `ExitOnForwardFailure`; a second `-R` on the
   *  same peer port just fails). A stale marker is cleaned up and ignored. */
  function holderOf(instance: RemoteInstance, kind: ForwardKind) {
    const lookup = findHolder(instance.id, kind, opts.home)
    if (lookup.staleCleared) pushLog(instance.id, `${kind} 的持有者标记是陈旧的（进程已不在），已清理`)
    return lookup.holder
  }

  function markForward(instance: RemoteInstance, kind: ForwardKind, child: ChildProcess, ports: { localPort?: number; remotePort?: number }): void {
    if (!child.pid) return
    writeForwardMarker({
      instanceId: instance.id, kind, pid: child.pid, owner: ownerRole,
      localPort: ports.localPort, remotePort: ports.remotePort, startedAt: Date.now(), host: instance.host,
    }, opts.home)
  }

  /**
   * Pipe a staged directory into one remote script on stdin (`tar -xzf -`).
   *
   * System `tar` on purpose, same posture as system `ssh`: the payload is our
   * own staged tree, the far side is POSIX sh + coreutils, and a hand-rolled
   * archive writer would be a second thing to get wrong. The tar process's
   * failure has to reach the caller too — an empty archive still extracts
   * "successfully", so a tar error would otherwise look like a clean sync.
   */
  function pipeTarToSsh(instance: SshTargetRef, dir: string, script: string, timeoutMs = 120_000): Promise<SshResult> {
    return new Promise((resolve) => {
      const tar = spawn('tar', ['-czf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const remote = spawn('ssh', buildSshExecArgs(instance, script), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: askpassEnv(instance),
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
      const timer = setTimeout(() => {
        try { remote.kill('SIGKILL') } catch { /* gone */ }
        try { tar.kill('SIGKILL') } catch { /* gone */ }
        done({ code: null, stdout, stderr: `${stderr}\ntimeout after ${timeoutMs}ms` })
      }, timeoutMs)
      remote.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      remote.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      remote.on('error', (err) => done({ code: null, stdout, stderr: `${stderr}\n${err.message}` }))
      remote.on('close', (code) => done({ code, stdout, stderr }))
      remote.stdin?.on('error', () => { /* the remote side's stderr is the story */ })
      tar.on('error', (err) => {
        try { remote.kill() } catch { /* gone */ }
        done({ code: null, stdout, stderr: `${stderr}\ntar: ${err.message}` })
      })
      tar.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      tar.stdout?.pipe(remote.stdin!)
    })
  }

  // ── probes ──────────────────────────────────────────────────────────────────

  async function probeEnv(instance: RemoteInstance): Promise<InstanceInspection | undefined> {
    const r = await ssh(instance, buildInstanceEnvProbeCommand(), 25_000)
    if (r.code !== 0) return undefined
    return parseEnvProbe(r.stdout)
  }

  /** R12 gate. A pinned path must itself pass; an unpinned host is searched in
   *  preference order and the winner becomes the pin. */
  async function resolveEngine(instance: RemoteInstance): Promise<EnginePick> {
    const candidates = instance.enginePath
      ? [instance.enginePath]
      : DEFAULT_ENGINE_CANDIDATES
    const r = await ssh(instance, buildEngineProbeCommand(candidates), 45_000)
    const parsed = parseEngineProbe(r.stdout)
    const pick = pickV2Engine(parsed)
    if (!pick.ok && instance.enginePath) {
      return {
        ok: false,
        seen: parsed,
        error: `pin 的 OpenCode 不满足 v2 门禁：${parsed.map((c) => `${c.path} → ${c.raw || '（版本未知）'}`).join('；') || instance.enginePath}`,
      }
    }
    return pick
  }

  async function remoteHealth(instance: RemoteInstance): Promise<string> {
    const r = await ssh(instance, buildRemoteHealthCommand(instance.appVersion, instance.instancePort), 20_000)
    return (r.stdout ?? '').trim().split('\n').pop()?.trim() || '000'
  }

  async function waitHealthy(instance: RemoteInstance, timeoutMs = 45_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await remoteHealth(instance)) === '200') return true
      await new Promise((r) => setTimeout(r, 1_500))
    }
    return false
  }

  // ── instance process (remote) ───────────────────────────────────────────────

  async function startInstance(instance: RemoteInstance, enginePath: string, guard = false): Promise<InstanceOutcome> {
    const prefix = guard ? buildOfflineGuardExports() : opts.serveEnvPrefix?.(instance) ?? ''
    // R9: the engine's egress goes to its own loopback, which the reverse
    // forward brings back to the control side's relay. Loopback stays out of it
    // (NO_PROXY) so the instance can still talk to its engine locally. Only when
    // this peer actually needs us — see egressFor().
    // The URL comes from `relayProxyUrl` on both sides (inject here, compare in
    // `up`): two spellings of the same string would look like a permanent
    // mismatch and restart the instance on every `up`.
    const relay = (await egressFor(instance)).relay
      ? relayProxyUrl(proxyConfig(instance).remotePort)
      : undefined
    const script = `${prefix}${buildInstanceServeCommand({
      appVersion: instance.appVersion,
      port: instance.instancePort,
      uiPassword: instance.uiPassword,
      enginePath,
      proxy: relay ? { httpProxy: relay, httpsProxy: relay } : undefined,
      extraEnv: passthroughEnv(),
      detached: true,
    })}`
    pushLog(instance.id, `$ instance serve :${instance.instancePort}（engine ${enginePath}）`)
    const r = await ssh(instance, script, 60_000)
    if (r.code !== 0) return { ok: false, detail: `启动实例失败：${cleanSshNoise(r.stderr || r.stdout).trim().split('\n').pop() ?? `exit ${r.code}`}` }
    if (!(await waitHealthy(instance))) {
      const tail = await tailRemoteLog(instance)
      return { ok: false, detail: `实例启动后 /health 未就绪${tail ? `；远端日志尾：${tail}` : ''}` }
    }
    return { ok: true, detail: `实例在 :${instance.instancePort} 就绪` }
  }

  async function tailRemoteLog(instance: RemoteInstance): Promise<string> {
    const p = instancePaths(instance.appVersion)
    const r = await ssh(instance, `tail -n 5 ${p.log} 2>/dev/null || true`, 15_000)
    return cleanSshNoise(r.stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ')
  }

  /** Which egress the **running** instance carries (`none` / a URL / `unknown`).
   *  Read from the peer's own process env, because that is the only place the
   *  decision actually lives once the instance is up. */
  async function probeInstanceProxy(instance: RemoteInstance): Promise<'none' | 'unknown' | string> {
    const r = await ssh(instance, buildInstanceProxyProbeCommand(instance.appVersion, instance.instancePort), 25_000)
    if (r.code !== 0 && !r.stdout.trim()) return 'unknown'
    return parseInstanceProxyProbe(r.stdout)
  }

  async function stopInstance(instance: RemoteInstance): Promise<InstanceOutcome> {    const r = await ssh(instance, buildInstanceStopCommand(instance.appVersion, instance.instancePort), 45_000)
    const code = (await remoteHealth(instance)) === '200'
    if (code) return { ok: false, detail: `实例仍在 :${instance.instancePort} 上响应（stop 未生效）` }
    // exit code is 0 even when nothing was running (the `|| true`), so the health
    // probe — not the exit code — is the assertion.
    pushLog(instance.id, `$ instance stop :${instance.instancePort}`)
    return { ok: true, detail: r.stdout.trim().split('\n').pop() || '已停' }
  }

  // ── components (reeve / deep-memory / anything with provision.json) ─────────

  /**
   * Install components declared by `provision.json` and register their engine
   * plugin entries. ocrc knows nothing about what the components do; it only
   * reads their contract. Every step is idempotent, and the extension install is
   * explicitly non-blocking (a missing console must not stop the instance).
   */
  async function installComponents(
    instance: RemoteInstance,
    sources: readonly string[],
    onLog?: (line: string) => void,
  ): Promise<{ ok: boolean; details: string[]; plugins: string[] }> {
    const log = (line: string) => { pushLog(instance.id, line); onLog?.(line) }
    const prepared = []
    for (const source of sources) {
      log(`组件：准备 ${source}`)
      prepared.push(await prepareComponent(source))
    }
    const home = (await ssh(instance, 'printf %s "$HOME"', 20_000)).stdout.trim()
    if (!home) return { ok: false, details: ['读不到对端的 $HOME'], plugins: [] }
    const running = (await remoteHealth(instance)) === '200'
    const details: string[] = []
    const plugins: string[] = []
    let ok = true
    let extensionInstalled = false
    for (const component of prepared) {
      log(`组件：安装 ${component.manifest.name} ${component.manifest.version}`)
      const result = await installPreparedComponent(instance, component, {
        log,
        uiPassword: instance.uiPassword,
        instancePort: instance.instancePort,
        remoteHome: home,
        instanceRunning: running,
      })
      details.push(...result.details)
      plugins.push(...result.plugins)
      extensionInstalled = extensionInstalled || result.extensionInstalled
      if (!result.ok) ok = false
    }
    if (plugins.length > 0) {
      const registered = await registerPeerPlugins(instance, plugins, {
        readScript: buildPeerConfigReadScript(),
        log,
        componentNames: prepared.map((c) => c.manifest.name),
      })
      details.push(registered.detail)
      if (!registered.ok) ok = false
    }
    for (const component of prepared) {
      for (const check of component.manifest.verify ?? []) {
        if (check.kind === 'file') {
          if (check.when === 'directory' && component.manifest.enginePlugin?.kind !== 'directory') continue
          const path = check.path.replace(/^~\//, '$HOME/')
          const mode = check.mode ? `stat -c %a "$f"` : 'echo PRESENT'
          const r = await ssh(instance, `f="${path}"; if [ ! -f "$f" ]; then echo MISSING; else ${mode}; fi`, 30_000)
          const out = r.stdout.trim().split('\n').pop() ?? ''
          if (out === 'MISSING') {
            details.push(`验证失败：${check.path} 不存在`)
            ok = false
          } else if (check.mode && out.replace(/^0+/, '') !== check.mode.replace(/^0+/, '')) {
            details.push(`验证失败：${check.path} 模式 ${out} ≠ ${check.mode}`)
            ok = false
          } else {
            details.push(`验证通过：${check.path}`)
          }
        } else if (check.kind === 'engine-plugin-loaded') {
          const dir = `$HOME/.ocrc/components/${component.manifest.name}/package`
          const r = await ssh(instance, `test -f "${dir}/package.json" && { test -e "${dir}/index.js" || test -e "${dir}/server.js"; } && echo ok`, 30_000)
          if (!/ok/.test(r.stdout)) {
            details.push(`验证失败：${component.manifest.name} 的插件树不在 ${dir}`)
            ok = false
          } else {
            details.push(`验证通过：${component.manifest.name} 插件树已就位`)
          }
        } else if (check.kind === 'guest-installed') {
          // Non-blocking by design: the instance keeps running without its console.
          details.push(extensionInstalled
            ? `验证通过：扩展 ${check.id} 已安装`
            : `注意：扩展 ${check.id} 未确认安装（不阻断实例启动）`)
        }
      }
    }
    return { ok, details, plugins }
  }

  async function installComponentsIfRequested(
    instance: RemoteInstance,
    applyOpts: { components?: string[]; componentsFromPins?: boolean; onLog?: (line: string) => void },
  ): Promise<{ ok: boolean; details: string[]; plugins: string[] } | undefined> {
    const sources = [
      ...(applyOpts.components ?? []),
      ...(applyOpts.componentsFromPins ? defaultComponentSources() : []),
    ]
    if (sources.length === 0) return undefined
    return installComponents(instance, sources, applyOpts.onLog)
  }

  /** Plugin entries for a config-only operation (diff/sync) without installing.
   *  Returns the manifest names too: they tell `planConfigSync` which local
   *  package specs are replaced by the installed directory entries. */
  async function componentPluginsFor(
    instance: RemoteInstance,
    sources: readonly string[] | undefined,
  ): Promise<{ plugins: string[]; names: string[] }> {
    if (!sources || sources.length === 0) return { plugins: [], names: [] }
    const home = (await ssh(instance, 'printf %s "$HOME"', 20_000)).stdout.trim()
    if (!home) throw new Error('读不到对端的 $HOME')
    const plugins: string[] = []
    const names: string[] = []
    for (const source of sources) {
      const prepared = await prepareComponent(source)
      const entry = pluginEntryFor(prepared.manifest, home, 'directory')
      if (entry) plugins.push(entry)
      names.push(prepared.manifest.name)
    }
    return { plugins, names }
  }

  // ── egress relay (R9) ───────────────────────────────────────────────────────

  /** One relay per control-side port, owned here when this process is the
   *  long-lived one (the panel host). A detached `ocrc remote proxy-serve` from
   *  an earlier CLI `up` shows up as `external` — both are fine, we just must not
   *  bind the same port twice. */
  const proxies = new Map<number, InstanceProxy>()

  /** Where this peer's egress goes. Cached briefly: a laptop moving between
   *  networks changes the answer, but not between two calls in the same tick. */
  async function egressFor(instance: RemoteInstance): Promise<{ relay: boolean; reason: string; probe?: EgressProbe }> {
    const r = rt(instance.id)
    if (r.egress && Date.now() - r.egress.at < EGRESS_TTL_MS) return r.egress
    const mode = instance.egress
    let probe: EgressProbe | undefined
    // Anything that is not an explicit `relay`/`direct` is decided by the probe,
    // so an unrecognized mode behaves like `auto` rather than silently relaying.
    if (mode !== 'relay' && mode !== 'direct') {
      // 30s: the probe budgets 8s itself, the rest is ssh setup on a slow host.
      const out = await ssh(instance, buildEgressProbeCommand({ appVersion: instance.appVersion }), 30_000)
      probe = parseEgressProbe(out.stdout)
    }
    const decision = resolveEgressPolicy({ mode, relayAllowed: proxyConfig(instance).enabled, probe })
    r.egress = { ...decision, probe, at: Date.now() }
    pushLog(instance.id, `联网方式：${decision.relay ? '经本机转发' : '直连'}（${decision.reason}）`)
    return r.egress
  }

  /** D1: the decision as the panel/CLI should show it. From the cache only — a
   *  status read must not cost an ssh round trip. `cached: false` means "nobody
   *  has decided yet in this process", which is a different statement from
   *  "the peer is offline", so it is said out loud instead of guessed. */
  function egressView(instance: RemoteInstance): InstanceStatus['egress'] {
    const mode = instance.egress ?? EGRESS_DEFAULT
    const cached = rt(instance.id).egress
    if (!cached) return { mode, relay: false, reason: '尚未探测（跑一次检查或启动就会决定）', cached: false }
    return { mode, relay: cached.relay, reason: cached.reason, probe: cached.probe, cached: true }
  }

  async function ensureProxy(instance: RemoteInstance): Promise<'in-process' | 'external' | 'off'> {
    const cfg = proxyConfig(instance)
    if (!cfg.enabled) return 'off'
    // A peer that can reach the internet itself must not be routed through us:
    // the detour costs latency and makes the control machine a single point of
    // failure for a peer that was never offline to begin with.
    if (!(await egressFor(instance)).relay) return 'off'
    if (proxies.has(cfg.localPort)) return 'in-process'
    if (await isListening(cfg.localPort)) {
      pushLog(instance.id, `出网转发已在 :${cfg.localPort} 上监听（外部进程，复用）`)
      return 'external'
    }
    try {
      const proxy = await createInstanceProxy({
        port: cfg.localPort,
        allow: cfg.allow,
        onLog: (line) => pushLog(instance.id, `relay: ${line}`),
      })
      proxies.set(cfg.localPort, proxy)
      pushLog(instance.id, `出网转发起在 127.0.0.1:${cfg.localPort}（远程机器经 ssh -R 127.0.0.1:${cfg.remotePort} 进来到这）`)
      return 'in-process'
    } catch (err) {
      pushLog(instance.id, `出网转发起不来：${(err as Error).message}`)
      return 'off'
    }
  }

  // ── forward supervision (R10) ───────────────────────────────────────────────

  function stopForward(id: string): void {
    const r = rt(id)
    if (r.forwardTimer) {
      clearTimeout(r.forwardTimer)
      r.forwardTimer = undefined
    }
    const child = r.forward
    r.forward = undefined
    r.forwardPid = undefined
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* already gone */ }
    }
    // D7: our leg is gone, so the marker must go with it — a marker that
    // outlives its process would look like a holder to the next start.
    clearForwardMarker(id, 'ui', opts.home)
    clearForwardMarker(id, 'relay', opts.home)
  }

  /** Only tears down a `-L` this process spawned — if the desktop shell is the
   *  one forwarding, there is nothing here to kill and the shell's own leg stays. */
  function stopPairForward(id: string): void {
    const child = rt(id).pairForward
    rt(id).pairForward = undefined
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* already gone */ }
    }
    clearForwardMarker(id, 'pair', opts.home)
  }

  /** External mode has no child process to watch: nobody can tell us the
   *  desktop shell's tunnel or the far-side server went away. So we look
   *  ourselves, on a slow timer — re-start a stopped remote instance and
   *  re-establish the egress leg when it is gone. */
  function startExternalMonitor(id: string): void {
    if (!externalTunnel) return
    const r = rt(id)
    if (r.monitorTimer) return
    const tick = async () => {
      const here = rt(id)
      if (here.stopping) return
      try { opts.store.reload() } catch { /* best effort */ }
      const fresh = opts.store.get(id)
      if (!fresh || fresh.enabled === false) return
      const health = await remoteHealth(fresh)
      if (health !== '200') {
        if (fresh.reconnect === false) {
          setState(id, 'offline', '远程实例未响应（reconnect 关，不自动重启）')
          return
        }
        const pick = await resolveEngine(fresh)
        if (!pick.ok) {
          setState(id, 'error', `OpenCode 不满足 v2 门禁：${pick.error}`)
          return
        }
        const relay = await ensureProxy(fresh)
        if (relay !== 'off') pushLog(id, `出网转发：${relay}`)
        await ensureExternalRelayAsync(fresh)
        const started = await startInstance(fresh, pick.candidate.path)
        setState(id, started.ok ? 'online' : 'error', started.ok ? `实例已重新拉起（${instanceUrl(fresh.localPort)}）` : started.detail)
        if (started.ok) pushLog(id, started.detail)
        return
      }
      await ensureExternalRelayAsync(fresh)
      // Same rule as probe(): the desktop shell owns its own local port, so
      // "online" here means the far side + the egress leg are healthy.
      if (here.state !== 'online') setState(id, 'online', '远程实例已就绪（转发由桌面应用持有）')
    }
    const timer = setInterval(() => { void tick().catch(() => { /* next tick */ }) }, EXTERNAL_MONITOR_MS)
    timer.unref?.()
    r.monitorTimer = timer
  }

  function stopExternalMonitor(id: string): void {
    const r = runtimes.get(id)
    if (r?.monitorTimer) {
      clearInterval(r.monitorTimer)
      r.monitorTimer = undefined
    }
  }

  /** Is the remote egress port already served by a tunnel this process did not
   *  spawn? The CLI's detached `up` and the extension service are separate
   *  processes; only one of them can hold a given remote listen port, and the
   *  other must adopt rather than fight (ssh fails the whole forward otherwise). */
  async function remoteRelayPresent(instance: RemoteInstance): Promise<boolean> {
    const cfg = proxyConfig(instance)
    if (!cfg.enabled) return false
    const probe = await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, cfg.remotePort), 20_000)
    return probe.stdout.trim().endsWith('open')
  }

  function ensureForward(instance: RemoteInstance): void {
    void ensureForwardAsync(instance)
  }

  async function ensureForwardAsync(instance: RemoteInstance): Promise<void> {
    if (externalTunnel) return
    const r = rt(instance.id)
    if (r.forward && r.forward.exitCode === null) return
    if (r.relayPending) return
    // D7: someone else already holds the UI leg (the CLI's detached tunnel, or a
    // previous service) — adopting beats fighting over the local port.
    const uiHolder = holderOf(instance, 'ui')
    if (uiHolder) {
      pushLog(instance.id, `本地 :${uiHolder.localPort ?? instance.localPort} 由另一个持有者占着（pid ${uiHolder.pid}，${uiHolder.owner}）——本进程不再起 -L，按 external 方式对待`)
      setState(instance.id, 'online', `转发由另一个持有者（pid ${uiHolder.pid}，${uiHolder.owner}）持有`)
      return
    }
    const cfg = proxyConfig(instance)
    r.relayPending = true
    let adopted = false
    try {
      adopted = await remoteRelayPresent(instance)
    } finally {
      r.relayPending = false
    }
    if (adopted) pushLog(instance.id, `远端 ${cfg.remotePort} 已在监听——主隧道不带 -R（复用既有出网转发）`)
    // R9 rides the same ssh process: `-L` gives us the UI, `-R` gives the
    // controlled host its egress. One tunnel, one reconnect loop.
    const reverse = cfg.enabled && !adopted ? { remotePort: cfg.remotePort, localPort: cfg.localPort } : undefined
    const args = buildForwardArgs({
      ...sshFields(instance),
      localPort: instance.localPort,
      remotePort: instance.instancePort,
      reverse,
    })
    pushLog(instance.id, `$ ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort}${reverse ? ` -R 127.0.0.1:${reverse.remotePort}:127.0.0.1:${reverse.localPort}` : ''} ${instance.user ? `${instance.user}@` : ''}${instance.host}`)
    const child = detachedForwards
      ? spawn('ssh', args, { stdio: ['ignore', 'ignore', openSync(forwardLogPath, 'a')], detached: true, env: askpassEnv(instance) })
      : spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: askpassEnv(instance) })
    r.forward = child
    r.forwardPid = child.pid
    markForward(instance, 'ui', child, { localPort: instance.localPort, remotePort: reverse ? reverse.remotePort : undefined })
    if (detachedForwards) {
      // No pipes on purpose: pipes would hold this process's event loop open, so
      // `ocrc remote up` would never return. ssh's own story goes to the log file.
      child.unref()
      pushLog(instance.id, `隧道以 detached 方式起（stderr → ${forwardLogPath}），本进程退出后继续活着`)
      return
    }
    child.stdout?.on('data', (d: Buffer) => pushLog(instance.id, d.toString()))
    child.stderr?.on('data', (d: Buffer) => pushLog(instance.id, d.toString()))
    child.on('error', (err) => {
      pushLog(instance.id, `ssh: ${err.message}`)
      setState(instance.id, 'error', `转发进程起不来：${err.message}`)
    })
    child.on('exit', (code) => {
      const current = rt(instance.id)
      if (current.forward === child) {
        current.forward = undefined
        current.forwardPid = undefined
      }
      if (current.stopping) return
      if (code === 0) {
        setState(instance.id, 'offline', '转发已退出')
        return
      }
      // Unexpected exit: reconnect while the record says so (R10 开关 ①).
      // Reload first — the switch may have been flipped by another process
      // (CLI/panel) while this supervisor was running.
      try { opts.store.reload() } catch { /* best effort */ }
      const fresh = opts.store.get(instance.id)
      if (!fresh?.enabled || fresh.reconnect === false) {
        setState(instance.id, 'offline', `转发退出（reconnect 关）：exit ${code}`)
        return
      }
      current.forwardAttempts += 1
      const delay = nextRetryDelay(current.forwardAttempts)
      setState(instance.id, 'offline', `转发断开，${Math.round(delay / 1000)}s 后重连（第 ${current.forwardAttempts} 次）`)
      current.forwardTimer = setTimeout(() => {
        current.forwardTimer = undefined
        const again = opts.store.get(instance.id)
        if (!again || again.enabled === false || again.reconnect === false || current.stopping) return
        void resumeForward(again)
      }, delay)
      current.forwardTimer.unref?.()
    })
  }

  /** Re-establish a dropped tunnel: the far-side instance is usually still up,
   *  so this is "forward again and re-verify", not "restart everything". */
  async function resumeForward(instance: RemoteInstance): Promise<void> {
    await ensureForwardAsync(instance)
    await new Promise((r) => setTimeout(r, 800))
    const probe = await probeThroughForward(instance)
    if (probe.ok) {
      setState(instance.id, 'online', `转发已恢复（${probe.version}）`)
      rt(instance.id).forwardAttempts = 0
    } else {
      pushLog(instance.id, `重连后探活失败：${probe.error}`)
    }
  }

  /** `/api/version` through the tunnel: proves forward + instance + capability
   *  in one call (the same judgement openchamber's own host probe makes). */
  async function probeThroughForward(instance: RemoteInstance) {
    try {
      const res = await fetch(`${instanceUrl(instance.localPort)}/api/version`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
      const payload = (await res.json()) as Record<string, unknown>
      return judgeInstanceVersion(payload)
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  }

  /** A free loopback port for a one-shot verification forward. */
  async function freeLocalPort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free loopback port'))))
      })
    })
  }

  /** Run `fn` through a short-lived `-L` forward. External-tunnel mode needs the
   *  instance's HTTP surface for verification, but must not bind the user's
   *  configured localPort — the desktop shell owns that one. */
  async function withTempForward<T>(instance: RemoteInstance, fn: (temp: RemoteInstance) => Promise<T>): Promise<T> {
    const port = await freeLocalPort()
    const temp: RemoteInstance = { ...instance, localPort: port }
    const args = buildForwardArgs({
      ...sshFields(instance),
      localPort: port,
      remotePort: instance.instancePort,
    })
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], env: askpassEnv(instance) })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`临时转发起不来：${cleanSshNoise(stderr).trim() || `exit ${child.exitCode}`}`)
      }
      if (await isListening(port)) break
      await new Promise((r) => setTimeout(r, 150))
    }
    if (!(await isListening(port))) {
      try { child.kill() } catch { /* already gone */ }
      throw new Error('临时转发未在 8s 内监听')
    }
    try {
      return await fn(temp)
    } finally {
      try { child.kill() } catch { /* already gone */ }
    }
  }

  /** Hold a `-L` on the instance's configured localPort so the pairing link's
   *  URL (`http://127.0.0.1:<localPort>`) resolves. Reused when the desktop
   *  shell already forwards there; otherwise we own a detached ssh for it, kept
   *  in `pairForward` so the relay bookkeeping in `forward` stays untouched. */
  async function ensurePairingForwardAsync(instance: RemoteInstance): Promise<boolean> {
    if ((await probeThroughForward(instance)).ok) return true
    const r = rt(instance.id)
    // D7: if a marker says someone holds the pairing leg, wait for their forward
    // to answer rather than binding the same port ourselves.
    const pairHolder = holderOf(instance, 'pair')
    if (pairHolder) pushLog(instance.id, `配对用的 -L 由另一个持有者占着（pid ${pairHolder.pid}，${pairHolder.owner}）——等它通，不抢端口`)
    if (!pairHolder && !(r.pairForward && r.pairForward.exitCode === null)) {
      const args = buildForwardArgs({
        ...sshFields(instance),
        localPort: instance.localPort,
        remotePort: instance.instancePort,
      })
      pushLog(instance.id, `$ ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort} ${instance.user ? `${instance.user}@` : ''}${instance.host}`)
      const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', openSync(forwardLogPath, 'a')], detached: true, env: askpassEnv(instance) })
      child.unref()
      r.pairForward = child
      markForward(instance, 'pair', child, { localPort: instance.localPort })
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if ((await probeThroughForward(instance)).ok) return true
      if (r.pairForward && r.pairForward.exitCode !== null) return false
      await new Promise((res) => setTimeout(res, 250))
    }
    return (await probeThroughForward(instance)).ok
  }

  /** Ask the peer's own CLI for a single-use pairing link and hand it back for
   *  the app to redeem. openchamber owns identity here: the link's secret is
   *  exchanged for a per-device, revocable client token, so nothing of ours
   *  stores a credential. */
  async function pairLink(id: string): Promise<{ ok: boolean; detail: string; link?: string; expiresAt?: string; url?: string }> {
    const instance = opts.store.get(id)
    if (!instance) return { ok: false, detail: `没有这个实例：${id}` }
    const forwarded = await ensurePairingForwardAsync(instance)
    if (!forwarded) {
      return { ok: false, detail: `本地转发 127.0.0.1:${instance.localPort} 起不来或远程机器不可达——先启动实例（配对链接要求它在跑）` }
    }
    // The pairing link replaces the desktop shell's instance entry, and that
    // entry used to carry the reverse leg. Without it the peer's panel and
    // engine fail every outbound call — our serve env points HTTP(S)_PROXY at
    // the peer's own loopback, so whoever holds this leg is the peer's egress.
    await ensureExternalRelayAsync(instance)
    // "Running" is not "monitored": without the monitor nothing re-ensures that
    // leg, so it dies with whatever transient process started it (this is how
    // the peer ended up with 69 ECONNREFUSED 127.0.0.1:2711 in its log). The
    // panel reaches an instance through this call first, so start monitoring here.
    startExternalMonitor(id)
    const url = instanceUrl(instance.localPort)
    const r = await ssh(instance, buildPairLinkCommand({
      appVersion: instance.appVersion,
      instancePort: instance.instancePort,
      serverUrl: url,
      label: instance.name?.trim() || instance.id,
    }), 45_000)
    const link = parsePairLink(r.stdout)
    if (!link) {
      return { ok: false, detail: `远程机器没给出配对链接：${(r.stdout + r.stderr).replace(/\s+/g, ' ').slice(-200)}` }
    }
    const info = describePairLink(link)
    pushLog(id, `配对链接已生成（一次性${info?.expiresAt ? `，${info.expiresAt} 过期` : ''}，${info?.candidates ?? 0} 条路由）`)
    return { ok: true, detail: '配对链接已生成——在桌面版里打开它，或复制到「导入链接」', link, ...(info?.expiresAt ? { expiresAt: info.expiresAt } : {}), url }
  }

  /** External-tunnel mode: the desktop shell owns the UI's `-L`; this manager
   *  owns the reverse leg that gives the peer engine its egress. Separate ssh
   *  process, so the two never fight over the local port. */
  function ensureExternalRelay(instance: RemoteInstance): void {
    void ensureExternalRelayAsync(instance)
  }
  async function ensureExternalRelayAsync(instance: RemoteInstance): Promise<void> {
    const cfg = proxyConfig(instance)
    if (!cfg.enabled) return
    // Same rule as the proxy env: no relay leg for a peer that gets out itself.
    if (!(await egressFor(instance)).relay) return
    const r = rt(instance.id)
    if (r.forward && r.forward.exitCode === null) return
    // D7: a second `-R` on the same peer port fails outright, and a live holder
    // marker tells us that is what would happen before we try.
    const relayHolder = holderOf(instance, 'relay')
    if (relayHolder) {
      pushLog(instance.id, `出网腿由另一个持有者占着（pid ${relayHolder.pid}，${relayHolder.owner}）——复用，不再起 -R`)
      return
    }
    // The check below costs a round trip; two callers in the same `up()` would
    // otherwise both pass it and spawn two very short-lived ssh processes.
    if (r.relayPending) return
    r.relayPending = true
    try {
      // A CLI `up` (or the desktop shell) may already carry the reverse leg; a
      // second `-R` on the same remote port would fail and drop us into a
      // reconnect loop, so adopt what is there instead.
      if (await remoteRelayPresent(instance)) {
        pushLog(instance.id, `远端 ${cfg.remotePort} 已在监听（出网转发由既有隧道提供，复用）`)
        return
      }
    } finally {
      r.relayPending = false
    }
    const args = buildRelayForwardArgs({
      ...sshFields(instance),
      localPort: cfg.localPort,
      remotePort: instance.instancePort,
      reverse: { remotePort: cfg.remotePort, localPort: cfg.localPort },
    })
    pushLog(instance.id, `$ ssh -N -R 127.0.0.1:${cfg.remotePort}:127.0.0.1:${cfg.localPort} ${instance.user ? `${instance.user}@` : ''}${instance.host}`)
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: askpassEnv(instance) })
    r.forward = child
    r.forwardPid = child.pid
    markForward(instance, 'relay', child, { localPort: cfg.localPort, remotePort: cfg.remotePort })
    child.stdout?.on('data', (d: Buffer) => pushLog(instance.id, d.toString()))
    child.stderr?.on('data', (d: Buffer) => pushLog(instance.id, d.toString()))
    child.on('error', (err) => {
      pushLog(instance.id, `ssh -R: ${err.message}`)
      setState(instance.id, 'error', `出网转发起不来：${err.message}`)
    })
    child.on('exit', (code) => {
      const current = rt(instance.id)
      if (current.forward === child) {
        current.forward = undefined
        current.forwardPid = undefined
      }
      if (current.stopping) return
      if (code === 0) {
        setState(instance.id, 'offline', '出网转发已退出')
        return
      }
      try { opts.store.reload() } catch { /* best effort */ }
      const fresh = opts.store.get(instance.id)
      if (!fresh?.enabled || fresh.reconnect === false) {
        setState(instance.id, 'offline', `出网转发退出（reconnect 关）：exit ${code}`)
        return
      }
      current.forwardAttempts += 1
      const delay = nextRetryDelay(current.forwardAttempts)
      setState(instance.id, 'offline', `出网转发断开，${Math.round(delay / 1000)}s 后重连（第 ${current.forwardAttempts} 次）`)
      current.forwardTimer = setTimeout(() => {
        current.forwardTimer = undefined
        const again = opts.store.get(instance.id)
        if (!again || again.enabled === false || again.reconnect === false || current.stopping) return
        ensureExternalRelay(again)
      }, delay)
      current.forwardTimer.unref?.()
    })
  }

  /** Which engine is really behind the panel (R12 assertion point ③). Needs the
   *  UI session: log in with the stored password, reuse the cookie for the one
   *  authenticated read. */
  async function probeEngineCompat(instance: RemoteInstance): Promise<ReturnType<typeof judgeEngineCompat>> {
    const base = instanceUrl(instance.localPort)
    try {
      const headers: Record<string, string> = {}
      if (instance.uiPassword) {
        const login = await fetch(`${base}/auth/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: instance.uiPassword, trustDevice: true }),
          signal: AbortSignal.timeout(8_000),
        })
        const cookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? ''
        if (!login.ok || !cookie) return { ok: false as const, error: `登录实例失败：HTTP ${login.status}` }
        headers.cookie = cookie.split(';')[0]!
      }
      const res = await fetch(`${base}/api/opencode/compatibility`, { headers, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { ok: false as const, error: `兼容性接口 HTTP ${res.status}` }
      return judgeEngineCompat((await res.json()) as EngineCompatPayload)
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  }

  // ── public surface ──────────────────────────────────────────────────────────

  const manager: RemoteInstanceManager = {
    async plan(id) {
      const instance = need(id)
      setState(id, 'checking')
      const target = `${instance.user ? `${instance.user}@` : ''}${instance.host}:${instance.port}`
      const actions: string[] = []
      const url = instanceUrl(instance.localPort)
      const env = await probeEnv(instance)
      if (!env) {
        setState(id, 'error', 'ssh 不可达')
        const how = instance.sshAuth === 'password' ? '密码档（askpass）' : 'BatchMode'
        return { id, target, reachable: false, sshError: `ssh ${target} 连不上（${how}）`, engineCandidates: [], actions, url }
      }
      rt(id).inspected = env

      const engineCmd = await ssh(instance, buildEngineProbeCommand(instance.enginePath ? [instance.enginePath] : DEFAULT_ENGINE_CANDIDATES), 45_000)
      const candidates = parseEngineProbe(engineCmd.stdout)
      const pick = await resolveEngine(instance)
      if (pick.ok) rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version }

      const runtimeProbe = await ssh(instance, buildRuntimeProbeCommand(), 25_000)
      const runtimeRaw = runtimeProbe.stdout.trim().split('\n').pop() ?? ''
      const runtime = runtimeRaw && runtimeRaw !== 'MISSING' ? runtimeRaw : undefined
      rt(id).runtimeVersion = runtime

      // P6：终端可用性（node-pty 的 GLIBCXX 依赖）——预演里就说清楚，别等用户点终端
      const termProbe = await ssh(instance, buildTerminalProbeCommand(instance.appVersion), 25_000)
      const terminal = parseTerminalProbe(termProbe.stdout)
      rt(id).terminal = terminal.ok ? { ok: true } : { ok: false, reason: terminal.reason }

      const appProbe = await ssh(instance, buildAppProbeCommand(instance.appVersion), 45_000)
      const appRaw = appProbe.stdout.trim().split('\n').pop() ?? ''
      const app = appRaw && appRaw !== 'MISSING' ? appRaw : undefined
      rt(id).appVersion = app

      // The "将要做的" list is a pure function of what the peer already has, so
      // 推包 and 复用档 can never describe the same peer differently.
      actions.push(...provisionActions({
        provision: instance.provision,
        runtime,
        app,
        targetAppVersion: instance.appVersion,
        engineOk: pick.ok,
        engineError: pick.ok ? undefined : pick.error,
      }))
      const term = rt(id).terminal
      if (term && term.ok === false) {
        actions.push(`注意：终端暂不可用（${term.reason ?? '原因未知'}）——实例其余功能不受影响`)
      }
      actions.push(pick.ok
        ? `启动实例：serve --hostname 127.0.0.1 --port ${instance.instancePort}（OpenCode ${pick.candidate.path} → ${pick.candidate.version}）`
        : `启动实例前先装 OpenCode：opencode ${DEFAULT_ENGINE_PIN} → ~/.ocrc/remote/engine/opencode（远程机器现有 v1 一律不动）`)
      actions.push(`建转发：ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort} → 打开 ${url}`)
      // A3: `auto` must show what it picked, and the probe costs an ssh round
      // trip we can afford here (this is the "look before you leap" step).
      const egress = await egressFor(instance)
      actions.push(`联网方式：${egress.relay ? '经本机转发' : '直连'}（${egress.reason}）`)
      // A busy instance port is the failure the user can still fix here.
      const portOut = await ssh(instance, buildPeerPortProbeCommand(instance.appVersion, instance.instancePort), 20_000)
      const peerPort = parsePortProbe(portOut.stdout)
      if (peerPort === 'open') actions.push(`注意：实例端口 ${instance.instancePort} 在远程机器已被占用——换个实例端口，或确认那是上一次的实例（启动会复用）`)
      if (peerPort === 'unknown') actions.push(`实例端口 ${instance.instancePort}：远程机器既没有我们的运行时也没有 ss/netstat，占用情况无法判定（启动时才会知道）`)
      setState(id, 'unknown')
      return {
        id, target, reachable: true, inspected: env, runtime, app,
        engine: pick.ok ? { path: pick.candidate.path, version: pick.candidate.version } : undefined,
        engineError: pick.ok ? undefined : pick.error,
        engineCandidates: candidates,
        actions,
        url,
        egress: { mode: instance.egress ?? EGRESS_DEFAULT, relay: egress.relay, reason: egress.reason, probe: egress.probe },
        provision: instance.provision ?? 'push',
        tier: appPackTierForGlibc(env.glibc),
        peerPort,
      }
    },

    /**
     * D5: one step from "the peer is on an older pin" to "the peer is on my pin".
     *
     * The app version is deliberately **not** a form field (the user settled that
     * pins are derived, not chosen), so the only meaningful upgrade action is this
     * one: compare the record against the control side's pin, and if they differ,
     * move the record and run the normal apply. Nothing happens when they already
     * match — an "upgrade" that reinstalls the same version is noise.
     */
    async upgrade(id) {
      const instance = need(id)
      const from = instance.appVersion
      const to = DEFAULT_APP_VERSION
      if (from === to) {
        return { ok: true, changed: false, from, to, detail: `已经是远程机器该有的那一份：${to}（pin 来自控制端）` }
      }
      pushLog(id, `升级：${from} → ${to}（旧树留 .ocrc-bak，一份就够）`)
      opts.store.update(id, { appVersion: to })
      const result = await manager.apply(id, { force: false })
      return { ...result, changed: true, from, to }
    },

    async apply(id, applyOpts = {}) {
      const instance = need(id)
      // 复用档：不推字节，只检查并把引擎 pin 下来。用同一套探测命令，所以
      // "检查通过" 与 "推包会做什么" 说的是一件事，不是两套判断。
      if (instance.provision === 'reuse' && !applyOpts.force) {
        setState(id, 'provisioning', '复用已安装：只检查，不写远程机器')
        const runtime = (await ssh(instance, buildRuntimeProbeCommand(), 25_000)).stdout.trim().split('\n').pop() ?? 'MISSING'
        const appRaw = (await ssh(instance, buildAppProbeCommand(instance.appVersion), 45_000)).stdout.trim().split('\n').pop() ?? ''
        const pick = await resolveEngine(instance)
        const detail = `复用已安装：运行时 ${runtime === 'MISSING' ? '缺失' : runtime}；OpenChamber ${appRaw === instance.appVersion ? instance.appVersion : `不符（${appRaw || '缺失'}）`}；OpenCode ${pick.ok ? `${pick.candidate.version} @ ${pick.candidate.path}` : '不满足 v2 门禁'}`
        pushLog(id, detail)
        if (runtime === 'MISSING' || appRaw !== instance.appVersion || !pick.ok) {
          setState(id, 'error', '复用已安装检查未通过')
          return { ok: false, detail: `${detail} —— 复用已安装不写任何字节；改用「推送安装」或先在远程机器上装好 ${instance.appVersion}` }
        }
        if (pick.ok) {
          opts.store.update(id, { enginePath: pick.candidate.path, engineVersion: pick.candidate.version })
          rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version }
        }
        setState(id, 'offline', '复用已安装检查通过（未启动）')
        const components = await installComponentsIfRequested(instance, applyOpts)
        if (components) {
          const full = `${detail}；组件：${components.details.join('；')}`
          setState(id, components.ok ? 'offline' : 'error', components.ok ? '复用检查 + 组件安装完成（未启动）' : '组件安装未完全通过')
          return { ok: components.ok, detail: full }
        }
        return { ok: true, detail }
      }
      // The pack tier follows the target's glibc, not the control host's:
      // EL7 gets the legacy tier (rebuilt node-pty), modern hosts get the
      // modern tier. An explicit tier wins (tests / forced packs).
      const inspected = await probeEnv(instance)
      const tier: AppPackTier = applyOpts.tier ?? appPackTierForGlibc(inspected?.glibc)
      pushLog(id, `OpenChamber 包兼容档：${tier}${inspected?.glibc ? `（远程机器 glibc ${inspected.glibc}）` : ''}`)
      applyOpts.onLog?.(`OpenChamber 包兼容档：${tier}${inspected?.glibc ? `（远程机器 glibc ${inspected.glibc}）` : ''}`)
      const ourEngine = `${instancePaths('x').engineDir}/opencode`
      // A foreign pin (explicit --engine-path) is asserted, never replaced; the
      // default path deploys **our own** pinned v2 into our namespace, which is
      // what makes a controlled host with only a v1 usable at all (R12).
      const foreignPin = instance.enginePath && instance.enginePath !== ourEngine ? instance.enginePath : undefined
      if (foreignPin) {
        setState(id, 'provisioning', '断言 pin 的 OpenCode')
        const pick = await resolveEngine(instance)
        if (!pick.ok) {
          setState(id, 'error', 'OpenCode 不满足 v2 门禁')
          return { ok: false, detail: `${pick.error}（R12：不许回落 v1）` }
        }
        rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version }
      } else {
        setState(id, 'provisioning', '推送运行时 / OpenCode / OpenChamber')
      }
      const result = await provisionOffline(instance, instance.appVersion, {
        force: applyOpts.force,
        skipEngine: !!foreignPin,
        engineVersion: applyOpts.engineVersion,
        guard: applyOpts.guard,
        trace: applyOpts.trace,
        tier,
        onLog: (line) => { pushLog(id, line); applyOpts.onLog?.(line) },
      })
      const enginePath = (result.engine as { path?: string }).path ?? ourEngine
      if (result.engine.ok && !foreignPin) {
        // Pin what we deployed: every later start uses this exact path, never PATH.
        opts.store.update(id, { enginePath, engineVersion: result.engine.version })
        rt(id).engine = { path: enginePath, version: result.engine.version ?? '' }
      }
      if (result.runtime.ok) rt(id).runtimeVersion = result.runtime.detail.replace(/^已推送 |^已在位 /, '')
      if (result.app.ok) rt(id).appVersion = instance.appVersion
      const parts = `运行时：${result.runtime.detail}；OpenCode：${result.engine.detail}；OpenChamber：${result.app.detail}`
      if (!result.ok) {
        setState(id, 'error', parts)
        return { ok: false, detail: parts }
      }
      const components = await installComponentsIfRequested(instance, applyOpts)
      const full = components ? `${parts}；组件：${components.details.join('；')}` : parts
      setState(id, components && !components.ok ? 'error' : 'offline', components && !components.ok ? '组件安装未完全通过' : '安装完成（未启动）')
      return { ok: components ? components.ok : true, detail: full }
    },

    async up(id, upOpts = {}) {
      const instance = need(id)
      setState(id, 'starting')
      if (externalTunnel) startExternalMonitor(id)
      const pick = await resolveEngine(instance)
      if (!pick.ok) {
        setState(id, 'error', 'OpenCode 不满足 v2 门禁')
        return { ok: false, detail: `${pick.error}（R12：不许回落 v1）` }
      }
      const runtime = await ssh(instance, buildRuntimeProbeCommand(), 25_000)
      if ((runtime.stdout.trim().split('\n').pop() ?? 'MISSING') === 'MISSING') {
        setState(id, 'error', '运行时缺失')
        return { ok: false, detail: '目标机上还没有运行时/应用——先跑 ocrc remote apply <id>' }
      }
      if ((await remoteHealth(instance)) !== '200') {
        // R9 relay must be up BEFORE the instance starts: the serve line hands the
        // engine a proxy URL, and a dead port there is a broken engine later.
        const relay = await ensureProxy(instance)
        if (relay !== 'off') pushLog(instance.id, `出网转发：${relay}`)
        if (externalTunnel) ensureExternalRelay(instance)
        const started = await startInstance(instance, pick.candidate.path, upOpts.guard)
        if (!started.ok) {
          setState(id, 'error', started.detail)
          return started
        }
        pushLog(id, started.detail)
      } else {
        // A running instance carries the egress decision it was **started** with.
        // If the peer's connectivity changed since (which is the whole point of
        // probing), "复用，不重启" leaves it online-with-no-egress — measured on EL7
        // when its internet was cut: the policy flipped to relay, the instance
        // still had zero proxy variables, and `up` reported online anyway.
        const wantsRelay = (await egressFor(instance)).relay
        const running = await probeInstanceProxy(instance)
        const expected = wantsRelay ? relayProxyUrl(proxyConfig(instance).remotePort) : 'none'
        if (running === 'unknown') {
          pushLog(id, `实例已在 :${instance.instancePort} 上服务（复用；读不到远程机器进程的 env，联网是否与策略一致未知）`)
        } else if (running === expected) {
          pushLog(id, `实例已在 :${instance.instancePort} 上服务（复用，不重启；出口 ${running === 'none' ? '直连' : running} 与策略一致）`)
        } else {
          const why = wantsRelay ? '策略要求经本机转发（远程机器出不了网），但实例是在直连档起的' : '策略是直连，但实例还挂在我们转发上'
          pushLog(id, `${why}——重启实例让 env 跟上（现在 ${running}，期望 ${expected}）`)
          const stopped = await stopInstance(instance)
          if (!stopped.ok) {
            setState(id, 'error', stopped.detail)
            return stopped
          }
          const relay = await ensureProxy(instance)
          if (relay !== 'off') pushLog(instance.id, `出网转发：${relay}`)
          if (externalTunnel) ensureExternalRelay(instance)
          const restarted = await startInstance(instance, pick.candidate.path, upOpts.guard)
          if (!restarted.ok) {
            setState(id, 'error', restarted.detail)
            return restarted
          }
          pushLog(id, `${restarted.detail}（因出口策略变化而重启）`)
        }
      }
      // The relay is needed either way: a reused instance may have been started
      // without one and its engine would then have no egress.
      if (proxyConfig(instance).enabled) await ensureProxy(instance)
      if (externalTunnel) {
        ensureExternalRelay(instance)
        // The desktop shell owns the user's -L. Verify through a short-lived
        // forward, then hand off; do not bind the configured localPort here.
        const verified = await withTempForward(instance, async (temp) => {
          let probe = await probeThroughForward(temp)
          const deadline = Date.now() + 20_000
          while (!probe.ok && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1_000))
            probe = await probeThroughForward(temp)
          }
          if (!probe.ok) return { ok: false as const, detail: `实例已起但转发探活失败：${probe.error}` }
          const compat = await probeEngineCompat(temp)
          if (!compat.ok) return { ok: false as const, detail: `实例在跑，但OpenCode门禁未过：${compat.error}` }
          return { ok: true as const, version: probe.version, compat }
        }).catch((err: unknown) => ({ ok: false as const, detail: (err as Error).message }))
        if (!verified.ok) {
          setState(id, 'error', verified.detail)
          return { ok: false, detail: verified.detail }
        }
        const r = rt(id)
        r.forwardAttempts = 0
        r.engine = { path: verified.compat.binary, version: verified.compat.version }
        setState(id, 'online', `openchamber ${verified.version}（OpenCode ${verified.compat.version} @ ${verified.compat.binary}；转发由桌面应用持有）`)
        return { ok: true, detail: `远端实例在线；转发由桌面应用持有（${instanceUrl(instance.localPort)}；openchamber ${verified.version}，OpenCode ${verified.compat.version} @ ${verified.compat.binary}）` }
      }
      // A tunnel from an earlier CLI run is invisible to this process. Reuse it
      // only when it carries the -R relay too; otherwise say so instead of
      // letting ssh die on a busy port (or silently stealing the port).
      if (await isListening(instance.localPort)) {
        const relayLive = proxyConfig(instance).enabled
          ? (await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, proxyConfig(instance).remotePort), 20_000)).stdout.trim().endsWith('open')
          : true
        if (relayLive) {
          pushLog(id, `本地 ${instance.localPort} 已在监听且带 -R 转发——复用这条隧道`)
        } else {
          const detail = `本地 127.0.0.1:${instance.localPort} 已被占用，但它没有 -R 出网转发（多半是旧命令留下的隧道）——先停掉它再 up`
          setState(id, 'error', detail)
          return { ok: false, detail }
        }
      }
      ensureForward(instance)
      // Through-the-tunnel verification: this is the URL the user opens.
      const deadline = Date.now() + 20_000
      let probe = await probeThroughForward(instance)
      while (!probe.ok && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_000))
        probe = await probeThroughForward(instance)
      }
      if (!probe.ok) {
        setState(id, 'error', `转发探活失败：${probe.error}`)
        return { ok: false, detail: `实例已起但转发探活失败：${probe.error}` }
      }
      // R12 ③：实例自己说它用的是哪个引擎——这才是「引擎是 v2」的证据，
      // 而不是我们「请求它用 v2」。复用到既有实例时这一步尤其重要。
      const compat = await probeEngineCompat(instance)
      if (!compat.ok) {
        setState(id, 'error', `OpenCode门禁未过：${compat.error}`)
        return { ok: false, detail: `实例在跑，但OpenCode门禁未过：${compat.error}` }
      }
      const r = rt(id)
      r.forwardAttempts = 0
      r.engine = { path: compat.binary, version: compat.version }
      setState(id, 'online', `openchamber ${probe.version}（OpenCode ${compat.version} @ ${compat.binary}）`)
      return { ok: true, detail: `online：${instanceUrl(instance.localPort)}（openchamber ${probe.version}，OpenCode ${compat.version} @ ${compat.binary}）` }
    },

    async down(id) {
      const instance = need(id)
      const r = rt(id)
      r.stopping = true
      stopExternalMonitor(id)
      try {
        stopForward(id)
        stopPairForward(id)
        const stopped = await stopInstance(instance)
        setState(id, stopped.ok ? 'offline' : 'error', stopped.detail)
        return stopped
      } finally {
        r.stopping = false
      }
    },

async probe(id) {
      const instance = opts.store.get(id)
      if (!instance) return { online: false, detail: 'no such instance' }
      if (externalTunnel) {
        // The desktop shell picks its own local port, so the configured
        // `localPort` is not a reliable "connected" signal. What this manager
        // can honestly assert is the pair it owns: the far-side instance is
        // serving and the egress leg is up.
        const health = await remoteHealth(instance)
        if (health !== '200') {
          const r = rt(id)
          if (r.state === 'online') setState(id, 'offline', `远程实例未响应（health ${health}）`)
          return { online: false, detail: `远程实例未响应（health ${health}）` }
        }
        await ensureExternalRelayAsync(instance)
        // Only a peer that needs us is required to have the leg up: for one with
        // its own egress a missing relay is the correct state, not a fault.
        const relayUp = !(await egressFor(instance)).relay
          || (await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, proxyConfig(instance).remotePort), 20_000)).stdout.trim().endsWith('open')
        if (!relayUp) return { online: false, detail: `远程实例在跑，但出网转发 :${proxyConfig(instance).remotePort} 未建立` }
        const r = rt(id)
        // Read the version through a one-shot forward: the desktop shell's own
        // port is not ours to use, and "online" deserves a real version, not a
        // guess.
        const probe = await withTempForward(instance, (temp) => probeThroughForward(temp))
          .catch(() => ({ ok: false as const, error: '临时转发失败' }))
        const version = probe.ok ? probe.version : undefined
        const ui = (await isListening(instance.localPort)) ? `；本地转发 :${instance.localPort} 也在听` : '；转发由桌面应用持有'
        if (r.state !== 'online') setState(id, 'online', version ? `openchamber ${version}（远端实测）` : `远程机器就绪${ui}`)
        return { online: true, version, detail: `远程实例在线${ui}` }
      }
      const probe = await probeThroughForward(instance)
      if (probe.ok) {
        // 顺手把本进程的状态也对齐（拥有隧道的进程里 status 立刻变 online）
        const r = rt(id)
        if (r.state !== 'online') setState(id, 'online', `openchamber ${probe.version}（实测）`)
        return { online: true, version: probe.version }
      }
      // The local forward is not ours in this process. Say what the far side
      // actually is instead of "unknown": the desktop shell picks its own local
      // port, and a CLI `status` must not call that offline.
      const health = await remoteHealth(instance)
      if (health === '200') {
        return {
          online: false,
          remote: true,
          detail: `远端实例在线（health 200）；本地转发 :${instance.localPort} 未起——隧道可能由桌面版或另一个进程持有`,
        }
      }
      return { online: false, detail: probe.error }
    },

    pairLink(id) {
      return pairLink(id)
    },

    status(id) {
      const instance = opts.store.get(id)
      const r = runtimes.get(id)
      if (!instance) return undefined
      const cfg = proxyConfig(instance)
      const proxy = proxies.get(cfg.localPort)
      return {
        id,
        state: r?.state ?? (instance.enabled ? 'unknown' : 'disabled'),
        detail: r?.detail,
        since: r?.since,
        url: instanceUrl(instance.localPort),
        tunnelOwner: externalTunnel ? 'external' : 'self',
        forwardPid: r?.forwardPid,
        forwardAttempts: r?.forwardAttempts,
        /** D7: who holds each leg, so "端口被占" has a name attached. */
        holders: describeHolders(instance.id, opts.home),
        engine: r?.engine ?? (instance.enginePath ? { path: instance.enginePath, version: instance.engineVersion ?? "" } : undefined),
        runtime: r?.runtimeVersion,
        app: r?.appVersion,
        inspected: r?.inspected,
        terminal: r?.terminal,
        proxy: {
          ...cfg,
          listening: !!proxy,
          connects: (proxy?.connects ?? []).slice(-20).map((t) => `${t.host}:${t.port}`),
        },
        egress: egressView(instance),
        logTail: r?.logs.slice(-40) ?? [],
      }
    },

    statusAll() {
      return opts.store.list().map((i) => manager.status(i.id)).filter((s): s is InstanceStatus => !!s)
    },

    async egress(id) {
      const instance = need(id)
      const decision = await egressFor(instance)
      return { mode: instance.egress ?? EGRESS_DEFAULT, ...decision }
    },

    // ── C1–C4: config and credentials for the peer's engine ────────────────────

    async configDiff(id, diffOpts = {}) {
      const instance = need(id)
      const local = readLocalConfig({ dir: opts.localConfigDir, authPath: opts.localAuthPath })
      const read = await ssh(instance, buildPeerConfigReadScript(), 45_000)
      const peer = parsePeerConfigRead(read.stdout)
      const peerError = read.code === 0 ? undefined : cleanSshNoise(read.stderr || read.stdout).trim().split('\n').pop()
      const diff = diffConfig(local, peer)
      const component = await componentPluginsFor(instance, diffOpts.components)
      const plan = planConfigSync(local, peer, {
        diff,
        providerBaseUrl: instance.providerBaseUrl,
        componentPlugins: component.plugins,
        componentNames: component.names,
      })
      // The config files are merged, not copied: leaving them in the file lists
      // would show "opencode.jsonc 会推过去" for a file we never send.
      const notConfig = (rel: string) => rel !== 'opencode.json' && rel !== 'opencode.jsonc'
      return {
        localDir: local.dir,
        add: diff.add.filter(notConfig),
        change: diff.change.filter(notConfig),
        same: diff.same.filter(notConfig),
        peerOnly: diff.peerOnly.filter(notConfig),
        unknown: diff.unknown.filter(notConfig),
        auth: diff.auth,
        plan: {
          basename: plan.basename,
          configChanged: plan.configChanged,
          files: plan.files,
          deletes: plan.deletes,
          keyDeletes: plan.keyDeletes,
          keyDeleteCandidates: plan.keyDeleteCandidates,
          managedPlugins: plan.managedPlugins,
          droppedManagedKeys: plan.droppedManagedKeys,
          secretsReplaced: plan.secretsReplaced,
          baseUrlRewrites: plan.baseUrlRewrites,
          commentsWillBeLost: plan.commentsWillBeLost,
          shadowed: plan.shadowed,
          notes: plan.notes,
        },
        peerError,
      }
    },

    async syncConfig(id, syncOpts = {}) {
      const instance = need(id)
      const local = readLocalConfig({ dir: opts.localConfigDir, authPath: opts.localAuthPath })
      const read = await ssh(instance, buildPeerConfigReadScript(), 45_000)
      if (read.code !== 0) {
        const detail = `读远程机器配置失败：${cleanSshNoise(read.stderr || read.stdout).trim().split('\n').pop() ?? `exit ${read.code}`}`
        pushLog(id, detail)
        return { ok: false, detail }
      }
      const peer = parsePeerConfigRead(read.stdout)
      const diff = diffConfig(local, peer)
      const component = await componentPluginsFor(instance, syncOpts.components)
      const plan = planConfigSync(local, peer, {
        diff,
        deletes: syncOpts.deletes,
        keyDeletes: syncOpts.keyDeletes,
        providerBaseUrl: instance.providerBaseUrl,
        preferCommentedTarget: syncOpts.preferCommentedTarget,
        componentPlugins: component.plugins,
        componentNames: component.names,
      })
      const nothing = plan.files.length === 0 && plan.deletes.length === 0
      if (nothing) {
        pushLog(id, 'sync-config: 无差异，未写远程机器')
        return { ok: true, detail: '无差异：远程机器已经和本地一致（未写任何文件）' }
      }
      if (syncOpts.dryRun) {
        return {
          ok: true,
          detail: `试运行：将写 ${plan.files.length} 个文件${plan.deletes.length ? `、删 ${plan.deletes.length} 个` : ''}；${plan.notes.join('；')}`,
        }
      }
      // Staging, not a copy of the local dir: the peer's config file must receive
      // the MERGED document (peer-only keys preserved), not our bytes. Only the
      // entries that actually differ are staged — a directory travels as a unit,
      // because tar-ing a subset of one buys nothing and risks a half-tree.
      const staging = mkdtempSync(join(tmpdir(), 'ocrc-cfgsync-'))
      try {
        const content = plan.merged && plan.configChanged ? renderConfig(plan.merged) : undefined
        const topLevel = [...new Set(plan.files.map((rel) => rel.split('/')[0]!).filter((e) => e !== plan.basename))]
        const staged = stageConfigTree({
          sourceDir: local.dir,
          destDir: staging,
          entries: topLevel,
          mergedConfig: content ? { basename: plan.basename, content } : undefined,
        })
        if (staged.length === 0 && plan.deletes.length === 0) {
          pushLog(id, 'sync-config: 无差异，未写远程机器')
          return { ok: true, detail: '无差异：远程机器已经和本地一致（未写任何文件）' }
        }
        pushLog(id, `$ sync-config ${staged.join(' ')}${plan.deletes.length ? ` (delete ${plan.deletes.join(' ')})` : ''}`)
        const result = await pipeTarToSsh(instance, staging, buildConfigApplyScript(plan.deletes), 120_000)
        for (const line of result.stdout.split('\n')) if (line.trim()) pushLog(id, line.trim())
        if (result.code !== 0) {
          const detail = `sync-config 失败（exit ${result.code}）：${cleanSshNoise(result.stderr || result.stdout).trim().split('\n').pop() ?? ''}`
          pushLog(id, detail)
          return { ok: false, detail }
        }
        const written = result.stdout.split('\n').filter((l) => l.startsWith('new:') || l.startsWith('backup:')).length
        const backedUp = result.stdout.split('\n').filter((l) => l.startsWith('backup:')).length
        const deleted = result.stdout.split('\n').filter((l) => l.startsWith('deleted:')).length
        const detail = `同步 ${written} 个文件${backedUp ? `（${backedUp} 个旧件留 .ocrc-bak）` : ''}${deleted ? `，删 ${deleted} 个（也留 .ocrc-bak）` : ''}`
          + (plan.droppedManagedKeys.length ? `；跳过 ${plan.droppedManagedKeys.join('/')}（远程机器自己的插件层）` : '')
        pushLog(id, detail)
        if (plan.secretsReplaced.length > 0) pushLog(id, `密钥改写为 {env:…}：${plan.secretsReplaced.map((s) => s.env).join(', ')}（值不落远程机器文件）`)
        return { ok: true, detail }
      } finally {
        discardStaging(staging)
      }
    },

    async syncAuth(id) {
      const instance = need(id)
      const local = readLocalConfig({ dir: opts.localConfigDir, authPath: opts.localAuthPath })
      if (!local.authPresent) {
        return { ok: false, detail: `本机没有 ${local.authPath}——先在本机登录 provider（opencode auth login）` }
      }
      const content = readFileSync(local.authPath)
      const result = await sshRunWithStdin(instance, buildAuthPushScript(), content, { timeoutMs: 45_000 })
      if (result.code !== 0) {
        const detail = `凭据同步失败（exit ${result.code}）：${cleanSshNoise(result.stderr || result.stdout).trim().split('\n').pop() ?? ''}`
        pushLog(id, detail)
        return { ok: false, detail }
      }
      // Never log the content, and never echo it: the log says what happened,
      // not what was copied.
      pushLog(id, 'sync-auth: 凭据已写到远程机器（0600，旧件留 .ocrc-bak）')
      return { ok: true, detail: `凭据已同步（${content.length} 字节 → 远程机器 0600）` }
    },

    logs(id) {
      return rt(id).logs.slice(-LOG_CAP)
    },

    async peerLogs(id, logOpts = {}) {
      const instance = need(id)
      const lines = logOpts.lines && logOpts.lines > 0 ? Math.min(logOpts.lines, 400) : 40
      const r = await ssh(instance, buildPeerLogCommand(instance.appVersion, instance.instancePort, lines), 30_000)
      const parsed = parsePeerLogs(r.stdout)
      if (r.code !== 0) {
        return { ...parsed, ok: false, error: cleanSshNoise(r.stderr || r.stdout).trim().split('\n').pop() ?? `exit ${r.code}` }
      }
      return { ...parsed, ok: true }
    },

    ensureAll() {
      for (const instance of opts.store.list()) {
        if (!instance.enabled) {
          setState(instance.id, 'disabled')
          continue
        }
        if (instance.restoreOnStart === false) {
          pushLog(instance.id, 'restoreOnStart 关：不自动拉起（R10 开关 ②）')
          continue
        }
        // Boot restore is background: the host must come up even when a
        // controlled host is unreachable (its own reconnect loop takes over).
        void manager.up(instance.id).catch((err: unknown) => {
          setState(instance.id, 'error', `自恢复失败：${(err as Error).message}`)
        })
      }
    },

    dispose() {
      // Detached forwards belong to the machine, not to this process: `ocrc remote
      // down` is the only thing that stops them (a panel restart must not kill
      // tunnels someone still uses).
      if (!detachedForwards) {
        for (const id of runtimes.keys()) {
          const r = rt(id)
          r.stopping = true
          stopExternalMonitor(id)
          stopForward(id)
        }
      }
      for (const [port, proxy] of proxies) {
        void proxy.close().catch(() => { /* closing */ })
        proxies.delete(port)
      }
    },
  }

  return manager
}
