/** Tunnel supervisor — owns the ssh child process, reconnects with backoff,
 *  and probes the controlled engine through the forward. Pure-ish core (no
 *  node imports at module top level beyond child_process/http) so vitest can
 *  drive it with a fake spawn. */
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { buildSshArgs, type SshProfile, type TunnelStatus } from '../shared/protocol.js'

export interface SupervisorDeps {
  spawnSsh?: (args: string[]) => ChildProcess
  probeEngine?: (port: number) => Promise<boolean>
  now?: () => number
}

const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 60_000

export function createTunnelSupervisor(deps: SupervisorDeps = {}) {
  const spawnSsh = deps.spawnSsh ?? ((args) => spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] }))
  const probeEngine = deps.probeEngine ?? defaultProbeEngine
  const now = deps.now ?? (() => Date.now())

  let child: ChildProcess | undefined
  let profile: SshProfile | undefined
  let stopped = true
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let lastExitDetail = ''

  function status(): TunnelStatus {
    if (!profile) return { profileId: null, tunnel: 'down', engine: 'unknown', detail: 'no profile' }
    const up = !stopped && child && child.exitCode === null
    return {
      profileId: profile.id,
      tunnel: up ? 'up' : stopped ? 'down' : 'starting',
      engine: 'unknown',
      detail: lastExitDetail || undefined,
      since: up ? now() : undefined,
    }
  }

  function start(p: SshProfile): void {
    stop()
    profile = p
    stopped = false
    retryAttempt = 0
    launch()
  }

  function launch(): void {
    if (stopped || !profile) return
    const args = buildSshArgs(profile)
    child = spawnSsh(args)
    let errTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).split('\n').slice(-3).join('\n')
    })
    child.on('exit', (code, signal) => {
      if (stopped) return
      lastExitDetail = `ssh exited (${signal ?? code})${errTail ? `: ${errTail.split('\n')[0]}` : ''}`
      child = undefined
      const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 5), RETRY_MAX_MS)
      retryAttempt += 1
      retryTimer = setTimeout(launch, delay)
      retryTimer.unref?.()
    })
  }

  function stop(): void {
    stopped = true
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined }
    if (child) { try { child.kill('SIGTERM') } catch { /* gone */ } child = undefined }
  }

  async function statusProbed(): Promise<TunnelStatus> {
    if (!profile) return status()
    const s = status()
    if (s.tunnel !== 'up') return s
    const reachable = await probeEngine(profile.localPort).catch(() => false)
    return { ...s, engine: reachable ? 'reachable' : 'unreachable' }
  }

  return { start, stop, status, statusProbed, get profile() { return profile } }
}

/** Probe the controlled engine through the local forward: any HTTP response
 *  (even 401/404) proves the tunnel + server are up. */
export function defaultProbeEngine(port: number, timeoutMs = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/global/health', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode > 0)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}
