import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { createLogger } from '../utils/logger.js'
import type { RemoteHost, RemotesStore } from './remotes.js'

const log = createLogger('remote-host')

/**
 * 0.26.0 remote host lifecycle — ZCode's deploy-on-connect model adapted to
 * ocrc + system ssh (no new deps, ~/.ssh/config and ProxyJump come free):
 *
 *   detecting → provisioning → launching → online
 *   failing states: needs-auth (no remote credentials) / error / offline
 *
 * One ssh process does BOTH the local forward and the remote serve:
 *   ssh -N -L local:127.0.0.1:remotePort host 'opencode serve --port remotePort'
 * When it dies, everything it started dies with it — no daemon left behind,
 * no stale server, no version drift. Official baseline install only, pinned
 * to the local opencode's version (the 1.18.x family is production-proven on
 * glibc 2.17 AND is the only HTTP API shape ocrc speaks). No musl path.
 */

export type RemoteState =
  | 'unknown' | 'detecting' | 'provisioning' | 'launching'
  | 'online' | 'needs-auth' | 'error' | 'offline' | 'disabled'

export interface RemoteInspection {
  platform?: string
  arch?: string
  glibc?: string
  opencodePath?: string
  version?: string
  authPresent?: boolean
  portListening?: boolean
}

export interface RemoteStatus {
  id: string
  state: RemoteState
  detail?: string
  localPort?: number
  pid?: number
  since?: number
  inspection?: RemoteInspection
  logTail: string[]
}

export interface RemoteHostManager {
  /** Reserve the local forward port NOW (boot) so SDK clients can be built
   *  before any tunnel exists; start() reuses it. */
  assignPort(id: string): Promise<number>
  inspect(id: string): Promise<RemoteInspection>
  provision(id: string): Promise<{ ok: boolean; detail: string }>
  start(id: string): void
  stop(id: string): void
  syncAuth(id: string): Promise<{ ok: boolean; detail: string }>
  /** 0.26.6: push the local opencode config whitelist (opencode.json incl.
   *  its mcp section, AGENTS/CLAUDE.md, command/, agent/, skill/) to the
   *  remote — the ocrc answer to ZCode's selective skills/MCP export-import.
   *  Never overwrites silently: remote collisions back up to *.ocrc-bak. */
  syncConfig(id: string): Promise<{ ok: boolean; detail: string }>
  status(id: string): RemoteStatus | undefined
  statusAll(): RemoteStatus[]
  /** Boot-time: start every enabled remote (tunnels come up in background). */
  ensureAll(): void
  dispose(): void
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

export function sshTarget(remote: Pick<RemoteHost, 'host' | 'user'>): string {
  return remote.user ? `${remote.user}@${remote.host}` : remote.host
}

/** ssh argv for a long-lived tunnel (+ optional remote command). */
export function buildSshArgs(
  remote: RemoteHost,
  localPort: number,
  command?: string,
): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=no',
    // A session whose -L cannot bind must die (respawn logic), not linger.
    '-o', 'ExitOnForwardFailure=yes',
    '-p', String(remote.port || 22),
    '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remote.remotePort}`,
    sshTarget(remote),
    ...(command ? [command] : []),
  ]
}

/** The remote shell line that runs ocrc's own serve instance. */
export function buildServeCommand(opencodePath: string, remotePort: number, password: string): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  return `export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"; OPENCODE_SERVER_PASSWORD=${q(password)} ${q(opencodePath)} serve --hostname 127.0.0.1 --port ${remotePort}`
}

/** "ldd (GNU libc) 2.17" → "2.17" */
export function parseGlibcVersion(firstLine: string | undefined): string | undefined {
  const m = firstLine?.match(/(\d+\.\d+)/)
  return m?.[1]
}

/** Exponential respawn backoff: 2s → 4s → 8s … capped at 60s. */
export function nextRetryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1))
}

/** Run the official installer remotely, pinned to `version` (empty = latest). */
export function buildProvisionCommand(version: string): string {
  const pin = version ? ` --version ${version}` : ''
  return `curl -fsSL https://opencode.ai/install | bash -s --${pin}`
}

// ── config sync (0.26.6, see docs/remote-provisioning-design.md §3) ──────────

/** The ~/.config/opencode whitelist pushed by syncConfig. `plugin/` is
 *  deliberately absent — the remote opencode must not load ocrc itself. */
export const CONFIG_SYNC_ENTRIES = ['opencode.json', 'AGENTS.md', 'CLAUDE.md', 'command', 'agent', 'skill'] as const

/** Which whitelist entries exist locally (pure via the injected exists fn). */
export function buildConfigEntries(
  configDir: string,
  exists: (p: string) => boolean = (p) => existsSync(p),
): string[] {
  return CONFIG_SYNC_ENTRIES.filter((entry) => exists(join(configDir, entry)))
}

/**
 * The remote side of syncConfig, fed a gzipped tar on stdin: untar into a
 * staging dir, move every file into ~/.config/opencode backing up any
 * collision to *.ocrc-bak (ZCode's no-silent-overwrite semantics), echo one
 * `new:`/`backup:` line per file for the panel's log drawer, clean up.
 */
export function buildConfigApplyScript(): string {
  return [
    'set -e',
    'D="$HOME/.config/opencode"',
    'S="$D/.ocrc-sync.$$"',
    'mkdir -p "$S"',
    'tar -xzf - -C "$S"',
    'cd "$S"',
    'find . -type f | sed \'s#^\\./##\' | while IFS= read -r rel; do',
    '  tgt="$D/$rel"',
    '  mkdir -p "$(dirname "$tgt")"',
    '  if [ -f "$tgt" ]; then',
    '    cp -p "$tgt" "$tgt.ocrc-bak"',
    '    echo "backup: $rel"',
    '  else',
    '    echo "new: $rel"',
    '  fi',
    '  mv "$S/$rel" "$tgt"',
    'done',
    'rm -rf "$S"',
    'echo "sync-config: applied"',
  ].join('\n')
}

// ── manager ───────────────────────────────────────────────────────────────────

const LOG_CAP = 200

interface RemoteRuntime {
  state: RemoteState
  detail?: string
  localPort?: number
  pid?: number
  since?: number
  inspection?: RemoteInspection
  logs: string[]
  ssh?: ChildProcess
  retryTimer?: ReturnType<typeof setTimeout>
  probeTimer?: ReturnType<typeof setTimeout>
  retryAttempt: number
  stopping: boolean
}

export function createRemoteHostManager(opts: { store: RemotesStore }): RemoteHostManager {
  const runtimes = new Map<string, RemoteRuntime>()

  const rt = (id: string): RemoteRuntime => {
    let r = runtimes.get(id)
    if (!r) {
      r = { state: 'unknown', logs: [], retryAttempt: 0, stopping: false }
      runtimes.set(id, r)
    }
    return r
  }

  const pushLog = (id: string, line: string) => {
    const r = rt(id)
    r.logs.push(line)
    if (r.logs.length > LOG_CAP) r.logs.splice(0, r.logs.length - LOG_CAP)
  }

  const setState = (id: string, state: RemoteState, detail?: string) => {
    const r = rt(id)
    r.state = state
    r.detail = detail
    r.since = Date.now()
    log.info(`remote ${id}: ${state}${detail ? ` — ${detail}` : ''}`)
  }

  // One ssh exec round-trip; key=value lines parse back without scraping.
  function buildDetectCommand(remotePort: number): string {
    const ocProbe = '$' + '{OCBIN:-$HOME/.opencode/bin/opencode}'
    // ss lives in /usr/sbin — absent from a non-interactive SSH PATH on EL7.
    // Fallbacks: netstat, then /proc/net/tcp{,6} directly (st==0A = LISTEN).
    const hex = remotePort.toString(16).toUpperCase().padStart(4, '0')
    return [
      `export PATH="$PATH:/usr/sbin:/sbin"`,
      `echo "UNAME=$(uname -s -m 2>/dev/null)"`,
      `echo "LDD=$(ldd --version 2>/dev/null | head -1)"`,
      `echo "OCBIN=$(command -v opencode 2>/dev/null)"`,
      `echo "OCVER=$(${ocProbe} --version 2>/dev/null | head -1)"`,
      `echo "AUTHP=$([ -f "$HOME/.local/share/opencode/auth.json" ] && echo yes || echo no)"`,
      `echo "PORTUP=$({ command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':${remotePort} '; } || { command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -q ':${remotePort} '; } || grep -qiE ':${hex} +[^ ]+ +0A' /proc/net/tcp /proc/net/tcp6 2>/dev/null && echo yes || echo no)"`,
    ].join('; ')
  }

  function parseDetectOutput(out: string): RemoteInspection {
    const kv = new Map<string, string>()
    for (const line of out.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim())
    }
    const [platform, arch] = (kv.get('UNAME') ?? '').split(' ')
    return {
      platform: platform || undefined,
      arch: arch || undefined,
      glibc: parseGlibcVersion(kv.get('LDD')),
      opencodePath: kv.get('OCBIN') || undefined,
      version: kv.get('OCVER') || undefined,
      authPresent: kv.get('AUTHP') === 'yes',
      portListening: kv.get('PORTUP') === 'yes',
    }
  }

  function sshExec(
    remote: RemoteHost,
    command: string,
    opts: { timeoutMs?: number; onData?: (chunk: string) => void } = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const args = [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=no',
        '-p', String(remote.port || 22),
        sshTarget(remote),
        command,
      ]
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
        : undefined
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
        opts.onData?.(d.toString())
      })
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

  function freeLocalPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') return reject(new Error('no port'))
        srv.close(() => resolve(addr.port))
      })
      srv.on('error', reject)
    })
  }

  async function pingThroughTunnel(localPort: number, password: string | undefined): Promise<boolean> {
    try {
      const headers: Record<string, string> = {}
      if (password) headers.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      const res = await fetch(`http://127.0.0.1:${localPort}/global/event`, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(2000),
      })
      void res.body?.cancel().catch(() => {})
      // Any HTTP response — even 404/405 — proves the tunnel + server are up.
      return res.status > 0
    } catch {
      return false
    }
  }

  /** The local opencode version is the pin: same family = glibc-proven AND the
   *  only API shape ocrc speaks. The plugin runs inside opencode, so
   *  process.execPath usually IS the binary; PATH is the CLI-host fallback. */
  async function resolveLocalVersion(): Promise<string> {
    for (const candidate of ['opencode', process.execPath]) {
      try {
        const out = await new Promise<string>((resolve, reject) => {
          execFile(candidate, ['--version'], { timeout: 10_000 }, (err, stdout) =>
            err ? reject(err) : resolve(String(stdout)))
        })
        const v = out.trim().split('\n')[0]
        if (/^\d+\.\d+\.\d+/.test(v)) return v
      } catch { /* next candidate */ }
    }
    return ''
  }

  const manager: RemoteHostManager = {
    async assignPort(id) {
      const r = rt(id)
      if (!r.localPort) r.localPort = await freeLocalPort()
      return r.localPort
    },
    async inspect(id) {
      const remote = opts.store.get(id)
      if (!remote) throw new Error(`unknown remote ${id}`)
      setState(id, 'detecting')
      const { code, stdout, stderr } = await sshExec(remote, buildDetectCommand(remote.remotePort), { timeoutMs: 25_000 })
      if (code !== 0) {
        setState(id, 'error', `ssh detect failed (exit ${code}): ${stderr.trim().split('\n')[0] ?? ''}`)
        throw new Error(`detect failed: ${stderr.trim() || `exit ${code}`}`)
      }
      const inspection = parseDetectOutput(stdout)
      const r = rt(id)
      r.inspection = inspection
      setState(id, inspection.authPresent === false ? 'needs-auth' : 'unknown',
        inspection.opencodePath ? `opencode ${inspection.version ?? '?'} @ ${inspection.opencodePath}` : 'opencode not installed')
      return inspection
    },

    async provision(id) {
      const remote = opts.store.get(id)
      if (!remote) return { ok: false, detail: 'unknown remote' }
      setState(id, 'provisioning')
      pushLog(id, `$ provision ${remote.host}`)

      let inspection = rt(id).inspection
      try { inspection ??= await manager.inspect(id) } catch { /* detect error already recorded */ }
      if (rt(id).state === 'error') return { ok: false, detail: rt(id).detail ?? 'detect failed' }
      const insp = rt(id).inspection
      if (!insp) return { ok: false, detail: 'no inspection' }
      void inspection
      if (insp.opencodePath) {
        pushLog(id, `opencode already present: ${insp.opencodePath} (${insp.version ?? '?'})`)
        return { ok: true, detail: 'already installed' }
      }

      // Path 1: official installer, pinned to the local version.
      const pin = await resolveLocalVersion()
      pushLog(id, `installing official opencode${pin ? ` (pin ${pin})` : ' (latest — local version unresolved!)'}`)
      const install = await sshExec(remote, buildProvisionCommand(pin), {
        timeoutMs: 15 * 60_000,
        onData: (chunk) => chunk.split('\n').forEach((l) => l.trim() && pushLog(id, l)),
      })
      const verifyPath = '$HOME/.opencode/bin/opencode'
      const verify = await sshExec(remote, `${verifyPath} --version 2>&1 | head -1`, { timeoutMs: 30_000 })
      const version = verify.stdout.trim()
      if (install.code === 0 && /^\d+\.\d+/.test(version)) {
        pushLog(id, `installed: ${verifyPath} (${version})`)
        rt(id).inspection = { ...insp, opencodePath: verifyPath, version }
        setState(id, insp.authPresent === false ? 'needs-auth' : 'unknown', `installed ${version}`)
        return { ok: true, detail: `installed ${version}` }
      }

      // Path 2: no internet on the remote — scp the local binary (same
      // official artifact) when the platform matches. NEVER a musl/compat
      // build: the official baseline is the whole point of this project.
      pushLog(id, `installer failed (exit ${install.code}): ${(install.stderr || install.stdout).trim().split('\n').slice(-3).join(' | ')}`)
      const localPlatform = `${process.platform === 'darwin' ? 'darwin' : 'linux'} ${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`
      const remotePlatform = `${inspection?.platform ?? '?'} ${inspection?.arch ?? '?'}`
      if (inspection?.platform === 'linux' && inspection?.arch && localPlatform.includes(inspection.arch)) {
        pushLog(id, `falling back to scp of the local binary (${remotePlatform})`)
        const localBin = await new Promise<string>((resolve) => {
          execFile('sh', ['-c', 'command -v opencode || echo ""'], (err, stdout) => resolve(String(stdout).trim()))
        })
        const src = localBin || process.execPath
        const tmp = `.ocrc-opencode-upload.$$`
        const scp = await new Promise<{ code: number | null; err: string }>((resolve) => {
          const child = spawn('scp', [
            '-o', 'BatchMode=yes', '-P', String(remote.port || 22),
            src, `${sshTarget(remote)}:${tmp}`,
          ], { stdio: ['ignore', 'ignore', 'pipe'] })
          let err = ''
          child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
          child.on('error', (e) => resolve({ code: null, err: e.message }))
          child.on('close', (code) => resolve({ code, err }))
        })
        if (scp.code !== 0) {
          const detail = `scp failed: ${scp.err.trim().split('\n')[0] ?? ''}`
          setState(id, 'error', detail)
          return { ok: false, detail }
        }
        const place = await sshExec(remote,
          `mkdir -p "$HOME/.local/bin" && mv "$HOME/${tmp}" "$HOME/.local/bin/opencode" && chmod 755 "$HOME/.local/bin/opencode" && "$HOME/.local/bin/opencode" --version | head -1`,
          { timeoutMs: 60_000 })
        if (place.code === 0 && /^\d+\.\d+/.test(place.stdout.trim())) {
          pushLog(id, `installed via scp: ~/.local/bin/opencode (${place.stdout.trim()})`)
          rt(id).inspection = { ...insp, opencodePath: '$HOME/.local/bin/opencode', version: place.stdout.trim() }
          setState(id, insp.authPresent === false ? 'needs-auth' : 'unknown', `installed via scp`)
          return { ok: true, detail: `installed via scp (${place.stdout.trim()})` }
        }
        const detail = `scp install verify failed: ${(place.stderr || place.stdout).trim().split('\n')[0] ?? ''}`
        setState(id, 'error', detail)
        return { ok: false, detail }
      }

      const detail = `install failed and platform mismatch (local ${localPlatform} vs remote ${remotePlatform})`
      setState(id, 'error', detail)
      return { ok: false, detail }
    },

    start(id) {
      const remote = opts.store.get(id)
      const r = rt(id)
      if (!remote) return
      if (!remote.enabled) {
        setState(id, 'disabled')
        return
      }
      r.stopping = false
      if (r.retryTimer) { clearTimeout(r.retryTimer); r.retryTimer = undefined }
      if (r.probeTimer) { clearTimeout(r.probeTimer); r.probeTimer = undefined }
      if (r.ssh) { try { r.ssh.kill() } catch { /* already gone */ } r.ssh = undefined }

      void (async () => {
        if (!r.localPort) {
          try { r.localPort = await freeLocalPort() } catch (err) {
            setState(id, 'error', `no local port: ${(err as Error).message}`)
            return
          }
        }
        // Fresh start ⇒ fresh detect: whether the remote port already runs a
        // serve decides the session shape — pure tunnel (port up, e.g. a
        // user-managed serve) vs tunnel + our own serve. A stale inspection
        // would launch serve into a live port and respawn-loop forever.
        let insp = r.inspection
        if (!insp) {
          try {
            insp = await manager.inspect(id)
          } catch {
            // inspect already recorded state=error; retry on the same backoff.
            const delay = nextRetryDelay(++r.retryAttempt)
            r.retryTimer = setTimeout(() => manager.start(id), delay)
            r.retryTimer.unref?.()
            return
          }
        }
        const command = insp.portListening
          ? undefined
          : buildServeCommand(insp.opencodePath ?? '$HOME/.opencode/bin/opencode', remote.remotePort, remote.serverPassword ?? '')
        const args = buildSshArgs(remote, r.localPort!, command)
        setState(id, 'launching', `ssh → ${remote.host}:${remote.remotePort} (local :${r.localPort})`)
        // args end with the serve command which embeds the generated password —
        // log only the option/tunnel prefix.
        pushLog(id, `$ ssh ${buildSshArgs(remote, r.localPort!).join(' ')}`)
        const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
        r.ssh = child
        r.pid = child.pid
        child.stderr?.on('data', (d: Buffer) => {
          for (const line of d.toString().split('\n')) if (line.trim()) pushLog(id, line.trim())
        })
        child.on('error', (err) => pushLog(id, `ssh error: ${err.message}`))
        child.on('close', (code) => {
          if (r.ssh !== child) return // superseded by a newer start()
          r.ssh = undefined
          r.pid = undefined
          if (r.stopping) { setState(id, 'offline', 'stopped'); return }
          setState(id, 'offline', `ssh exited (${code})`)
          r.inspection = undefined // re-detect before the respawn relaunches
          const delay = nextRetryDelay(++r.retryAttempt)
          pushLog(id, `respawn in ${Math.round(delay / 1000)}s`)
          r.retryTimer = setTimeout(() => manager.start(id), delay)
          r.retryTimer.unref?.()
        })

        // Probe until the serve answers through the tunnel.
        let probes = 0
        const probe = () => {
          if (r.ssh !== child) return
          void pingThroughTunnel(r.localPort!, remote.serverPassword).then((up) => {
            if (r.ssh !== child) return
            if (up) {
              r.retryAttempt = 0
              setState(id, 'online', `opencode ${r.inspection?.version ?? ''} via :${r.localPort}`.trim())
            } else if (++probes < 45) {
              r.probeTimer = setTimeout(probe, 2000)
              r.probeTimer.unref?.()
            } else {
              setState(id, 'error', 'serve did not answer through the tunnel in 90s')
            }
          })
        }
        probe()
      })()
    },

    stop(id) {
      const r = rt(id)
      r.stopping = true
      if (r.retryTimer) { clearTimeout(r.retryTimer); r.retryTimer = undefined }
      if (r.probeTimer) { clearTimeout(r.probeTimer); r.probeTimer = undefined }
      if (r.ssh) { try { r.ssh.kill() } catch { /* already gone */ } }
      else setState(id, 'offline', 'stopped')
    },

    async syncAuth(id) {
      const remote = opts.store.get(id)
      if (!remote) return { ok: false, detail: 'unknown remote' }
      // Local credentials live at the canonical path regardless of host type.
      const localAuth = `${process.env.HOME ?? ''}/.local/share/opencode/auth.json`
      let content: Buffer | undefined
      try { content = readFileSync(localAuth) } catch { /* surfaced below */ }
      const scp = await new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn('ssh', [
          '-o', 'BatchMode=yes', '-p', String(remote.port || 22), sshTarget(remote),
          'mkdir -p "$HOME/.local/share/opencode" && cat > "$HOME/.local/share/opencode/auth.json" && chmod 600 "$HOME/.local/share/opencode/auth.json"',
        ], { stdio: ['pipe', 'ignore', 'pipe'] })
        let err = ''
        child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
        child.on('error', (e) => resolve({ code: null, err: e.message }))
        child.on('close', (code) => resolve({ code, err }))
        if (content) child.stdin?.end(content)
        else { child.kill(); resolve({ code: null, err: 'local auth.json unreadable' }) }
      })
      if (scp.code !== 0) {
        pushLog(id, `sync-auth failed: ${scp.err.trim().split('\n')[0] ?? ''}`)
        return { ok: false, detail: scp.err.trim().split('\n')[0] || `exit ${scp.code}` }
      }
      pushLog(id, 'sync-auth: credentials copied (0600)')
      const r = rt(id)
      if (r.inspection) r.inspection.authPresent = true
      if (r.state === 'needs-auth') setState(id, 'unknown', 'credentials synced')
      return { ok: true, detail: 'credentials synced' }
    },

    async syncConfig(id) {
      const remote = opts.store.get(id)
      if (!remote) return { ok: false, detail: 'unknown remote' }
      const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode')
      const entries = buildConfigEntries(configDir)
      if (entries.length === 0) {
        return { ok: false, detail: `nothing to sync — no whitelisted entries in ${configDir}` }
      }
      pushLog(id, `$ sync-config ${entries.join(' ')}`)

      // Local tar (system tar — same posture as system ssh/scp) piped into ONE
      // ssh round-trip running the apply script on stdin.
      const tar = spawn('tar', ['-czf', '-', '-C', configDir, ...entries], { stdio: ['ignore', 'pipe', 'pipe'] })
      const ssh = spawn('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=no',
        '-p', String(remote.port || 22),
        sshTarget(remote),
        buildConfigApplyScript(),
      ], { stdio: ['pipe', 'pipe', 'pipe'] })

      const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        let stdout = ''
        let stderr = ''
        ssh.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        ssh.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        ssh.on('error', (err) => resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` }))
        ssh.on('close', (code) => resolve({ code, stdout, stderr }))
        tar.on('error', (err) => {
          try { ssh.kill() } catch { /* gone */ }
          resolve({ code: null, stdout, stderr: `tar: ${err.message}` })
        })
        tar.stdout?.pipe(ssh.stdin)
      })
      const { code, stdout, stderr } = await result
      for (const line of stdout.split('\n')) if (line.trim()) pushLog(id, line.trim())
      if (code !== 0) {
        const detail = `sync-config failed (exit ${code}): ${(stderr || stdout).trim().split('\n')[0] ?? ''}`
        pushLog(id, detail)
        return { ok: false, detail }
      }
      const applied = stdout.split('\n').filter((l) => l.startsWith('new:') || l.startsWith('backup:')).length
      const backedUp = stdout.split('\n').filter((l) => l.startsWith('backup:')).length
      const detail = `synced ${applied} file(s)${backedUp ? `, ${backedUp} backed up to *.ocrc-bak` : ''}`
      pushLog(id, detail)
      return { ok: true, detail }
    },

    status(id) {
      const r = runtimes.get(id)
      if (!r) return undefined
      return {
        id, state: r.state, detail: r.detail, localPort: r.localPort, pid: r.pid,
        since: r.since, inspection: r.inspection, logTail: r.logs.slice(-40),
      }
    },
    statusAll() {
      return [...runtimes.keys()].map((id) => manager.status(id)!).filter(Boolean)
    },

    ensureAll() {
      for (const remote of opts.store.list()) {
        if (remote.enabled) manager.start(remote.id)
        else setState(remote.id, 'disabled')
      }
    },

    dispose() {
      for (const [id] of runtimes) manager.stop(id)
    },
  }

  return manager
}
