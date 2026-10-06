/**
 * Builds the backend set for the standalone host from an OCRC_BACKENDS spec and
 * wires each backend's event source to the relay. This is what lets one host
 * serve multiple agents (opencode + kimi + …) with in-UI switching (Phase 3).
 *
 * Event sources differ by backend:
 *  - ACP backends own their stream (backend.onEvent → relay; busy/idle → push).
 *  - opencode has no onEvent: the host spawns its OWN opencode server
 *    (createOpencodeServer — validated reachable from a standalone process) and
 *    consumes the global event SSE, normalizing → relay and forwarding permission
 *    events to the approval bridge. opencode events feed push natively.
 */
import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk'
import { buildBasicHeaders } from '../utils/oc-server-auth.js'
import type { RemotesStore } from '../core/remotes.js'
import type { RemoteHostManager } from '../core/remote-host.js'
import { ocServerHeaders } from '../utils/oc-server-auth.js'
import type { AgentEvent } from '../core/agent/event.js'
import type { RegisteredBackend } from '../core/agent/registry.js'
import { createAcpBackend, type AcpPermissionRequest } from '../core/agent/acp-backend.js'
import type { McpServer } from '../core/agent/backend.js'
import type { AcpStore } from '../core/agent/acp-store.js'
import { makeAcpConnect, parseAcpCommand } from '../core/agent/acp-connect.js'
import { createOpencodeBackend } from '../core/agent/opencode-backend.js'
import { normalizeOpencodeEvent } from '../core/agent/opencode-normalizer.js'
import { startGlobalEvents } from '../opencode/global-events.js'
import type { OcEvent } from '../core/opencode-events.js'
import { createLogger } from '../utils/logger.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const log = createLogger('host-backends')

/**
 * Discover the working directories kimi has sessions in, by reading its global
 * session index ($KIMI_CODE_HOME/session_index.jsonl — one {sessionId, workDir,
 * sessionDir} per line). ACP `session/list` is per-cwd, so this lets OCRC surface
 * sessions you created in the kimi TUI in directories OCRC never used. Best-effort
 * + kimi-specific (file absent / other agents → []).
 */
function kimiWorkDirs(): string[] {
  try {
    const home = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
    const dirs = new Set<string>()
    for (const line of readFileSync(join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue
      try { const d = JSON.parse(t); if (typeof d.workDir === 'string') dirs.add(d.workDir) } catch { /* skip bad line */ }
    }
    return [...dirs]
  } catch { return [] }
}

/** kimi's own configured MCP servers (~/.kimi-code/mcp.json) — surfaced in the MCP panel. */
function kimiMcp(): McpServer[] {
  try {
    const home = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
    const raw = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { url?: string; type?: string; disabled?: boolean }>
    }
    return Object.entries(raw.mcpServers ?? {}).map(([name, cfg]) => ({
      name,
      type: cfg?.url ? (cfg.type ?? 'http') : 'stdio',
      status: cfg?.disabled ? 'disabled' : 'configured',
    }))
  } catch { return [] }
}

export interface BackendSpec {
  id: string
  kind: 'opencode' | 'acp'
  /** ACP spawn command (e.g. "kimi acp"); unused for opencode. */
  command?: string
}

/**
 * Parse OCRC_BACKENDS. Entries: `opencode` or `<id>=<acp command>`. When empty,
 * falls back to a single ACP backend from OCRC_ACP_CMD (legacy single-backend host).
 */
export function parseBackendsSpec(spec: string, fallbackAcpCmd: string): BackendSpec[] {
  const entries = spec.split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) {
    const cmd = parseAcpCommand(fallbackAcpCmd)
    return [{ id: `acp:${cmd.command}`, kind: 'acp', command: fallbackAcpCmd }]
  }
  return entries.map((e): BackendSpec => {
    if (e === 'opencode') return { id: 'opencode', kind: 'opencode' }
    const eq = e.indexOf('=')
    if (eq === -1) {
      const cmd = parseAcpCommand(e)
      return { id: `acp:${cmd.command}`, kind: 'acp', command: e }
    }
    const rawId = e.slice(0, eq).trim()
    const command = e.slice(eq + 1).trim()
    return { id: rawId.includes(':') ? rawId : `acp:${rawId}`, kind: 'acp', command }
  })
}

export interface RelayLike { handleEvent(e: AgentEvent): Promise<void> }
export interface PushLike { handleEvent(ev: unknown): void | Promise<void> }

export interface BuildHostBackendsDeps {
  cwd: string
  /** ACP permission bridge (shared by all ACP backends). */
  onAcpPermission: (req: AcpPermissionRequest) => Promise<string | null>
  /** Persistent session+history store, shared by all ACP backends. */
  store?: AcpStore
  /** Session state (busy map) — subagents panel reads isSessionBusy. */
  state?: { setSessionBusy?: (id: string, busy: boolean) => void }
  /** Base port for spawned opencode servers (each opencode backend gets one). */
  opencodePort?: number
  /** Ports the probe must never claim (the web transport's own, typically). */
  skipPorts?: number[]
  /** ADOPT an already-running opencode server instead of spawning one — all
   *  backends/events point at this URL. This is the fix for the two-engine
   *  split: a user-run opencode (e.g. :4096) shares the session STORE with
   *  ours but NOT its event stream, so sessions driven there looked dead in
   *  the panel. Adopting the user's engine restores live streaming. */
  serverUrl?: string
  /** SSH remote hosts (0.26): one `remote:<id>` backend per enabled host.
   *  Ported from the plugin entry so HOST mode drives remotes too — the
   *  first-class topology was blind to them (panel could configure, engine
   *  could not drive). */
  remotesStore?: RemotesStore
  remoteManager?: RemoteHostManager
  /** Live busy/idle sink (web WS) — session.status events broadcast here so
   *  the composer shows 停止 for turns started outside the panel too. */
  statusSink?: { broadcast?: (frame: { sessionId: string; busy: boolean }) => void }
}

export interface BuiltHostBackends {
  backends: RegisteredBackend[]
  /**
   * Wire every backend's event source to the relay + push. `onOpencodePermission`
   * receives raw opencode permission events to forward to the approval UI.
   * Returns a disposer that tears down all sources + spawned servers.
   */
  wire(relay: RelayLike, push: PushLike, onOpencodePermission: (ev: OcEvent) => void): () => Promise<void>
}

const PERMISSION_TYPES = new Set(['permission.asked', 'permission.updated', 'permission.replied'])

/** How many consecutive ports to probe when spawning an opencode server. */
const PORT_PROBE_ATTEMPTS = 10

/**
 * Spawn an opencode server, probing forward from `startPort` when a port is
 * taken (previously a busy 4096 silently dropped the whole opencode backend).
 * Returns the server and the port it bound; rethrows the last error when every
 * probe fails.
 */
async function spawnOpencodeServer(startPort: number, skipPorts: number[] = []): Promise<{ server: any; port: number }> {
  let lastErr: unknown
  for (let port = startPort; port < startPort + PORT_PROBE_ATTEMPTS + skipPorts.length; port++) {
    if (skipPorts.includes(port)) continue
    try {
      const server = await createOpencodeServer({ hostname: '127.0.0.1', port, timeout: 15000 })
      if (port !== startPort) log.warn(`port ${startPort} unavailable — opencode backend bound to ${port} instead`)
      return { server, port }
    } catch (err) {
      lastErr = err
      log.warn(`opencode server failed on port ${port}: ${(err as Error).message}`)
    }
  }
  throw lastErr
}

export async function buildHostBackends(specs: BackendSpec[], deps: BuildHostBackendsDeps): Promise<BuiltHostBackends> {
  const backends: RegisteredBackend[] = []
  const opencodeServers: Array<{ id: string; client: any; close: () => Promise<void> }> = []
  /** ACP connect factories — dispose() kills their spawned agent children. */
  const acpConnects: Array<{ dispose(): void }> = []
  let nextPort = deps.opencodePort ?? 4096

  for (const spec of specs) {
    if (spec.kind === 'opencode') {
      try {
        let url: string
        let close: () => Promise<void>
        if (deps.serverUrl) {
          // ADOPT: drive the user's own engine. No spawn, nothing to close —
          // its lifecycle belongs to whoever started it.
          url = deps.serverUrl
          close = async () => { /* external process — leave it alone */ }
          log.info(`opencode backend ADOPTS external server @ ${url}`)
        } else {
          const { server, port } = await spawnOpencodeServer(nextPort, deps.skipPorts)
          nextPort = port + 1
          url = server.url
          close = async () => { try { await server.close() } catch { /* noop */ } }
        }
        // The adopted server may require Basic auth (OPENCODE_SERVER_PASSWORD
        // shared via config.env) — the client must authenticate the same way
        // the plugin's raw fetches do, or every call 401s and the backend
        // shows offline.
        const client = createOpencodeClient({
          baseUrl: url,
          headers: ocServerHeaders(),
        })
        const backend = createOpencodeBackend({ client, baseUrl: url })
        backends.push({ id: spec.id, backend })
        opencodeServers.push({ id: spec.id, client, close })
        log.info(`opencode backend ready @ ${url}`)
      } catch (err) {
        log.error(`failed to start opencode backend (skipping): ${(err as Error).message}`)
      }
    } else {
      const connect = makeAcpConnect(parseAcpCommand(spec.command ?? 'kimi acp'))
      acpConnects.push(connect)
      const backend = createAcpBackend({
        id: spec.id,
        cwd: deps.cwd,
        connect,
        onPermission: deps.onAcpPermission,
        store: deps.store,
        discoverDirs: kimiWorkDirs,
        discoverMcp: kimiMcp,
      })
      backends.push({ id: spec.id, backend })
      log.info(`acp backend ready: ${spec.id} (${spec.command})`)
    }
  }

  // SSH remote hosts — ported from the plugin entry (parity, 0.26.12): the
  // first-class topology must drive remotes exactly like the plugin does.
  if (deps.remotesStore && deps.remoteManager) {
    for (const r of deps.remotesStore.list()) {
      if (!r.enabled) continue
      try {
        const localPort = await deps.remoteManager.assignPort(r.id)
        const headers = buildBasicHeaders('opencode', r.serverPassword)
        const base = `http://127.0.0.1:${localPort}`
        backends.push({
          id: `remote:${r.id}`,
          backend: createOpencodeBackend({
            id: `remote:${r.id}`,
            host: r.host,
            remote: true,
            baseUrl: base,
            client: createOpencodeClient({ baseUrl: base, headers }) as never,
            fetchImpl: (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
          }),
        })
        log.info(`remote backend ready: remote:${r.id} (${r.host}) via :${localPort}`)
      } catch (err) {
        log.warn(`remote ${r.id} backend setup failed: ${(err as Error).message}`)
      }
    }
  }

  if (backends.length === 0) throw new Error('host: no backends could be started')

  return {
    backends,
    wire(relay, push, onOpencodePermission) {
      const disposers: Array<() => void> = []

      // push.handleEvent is async — fire-and-forget, but never let a rejection
      // escape to the global guard.
      const safePush = (ev: unknown) => {
        void Promise.resolve(push.handleEvent(ev)).catch((err) =>
          log.warn('push.handleEvent failed', err as Error),
        )
      }

      // ACP backends: own their stream.
      for (const { backend } of backends) {
        if (!backend.onEvent) continue
        const off = backend.onEvent((e) => {
          relay.handleEvent(e).catch((err) => log.error('relay.handleEvent failed', err as Error))
          if (e.kind === 'idle') safePush({ type: 'session.idle', properties: { sessionID: e.sessionId } })
          else if (e.kind === 'part' || e.kind === 'delta') safePush({ type: 'session.status', properties: { sessionID: e.sessionId, status: { type: 'busy' } } })
        })
        disposers.push(off)
      }

      // opencode backends: pull the global event SSE.
      for (const { client } of opencodeServers) {
        const handle = startGlobalEvents({
          client,
          onEvent: (ev) => {
            safePush(ev) // opencode events are already the shape push expects
            if ((ev as { type?: string }).type === 'session.status') {
              const p = (ev as { properties?: { sessionID?: string; status?: { type?: string } } }).properties
              if (p?.sessionID) {
                deps.statusSink?.broadcast?.({ sessionId: p.sessionID, busy: p.status?.type === 'busy' })
                deps.state?.setSessionBusy?.(p.sessionID, p.status?.type === 'busy')
              }
            }
            if (PERMISSION_TYPES.has(ev.type ?? '')) { onOpencodePermission(ev); return }
            const ae = normalizeOpencodeEvent(ev)
            if (ae) relay.handleEvent(ae).catch((err) => log.error('relay.handleEvent failed', err as Error))
          },
        })
        disposers.push(() => handle.stop())
      }

      return async () => {
        for (const d of disposers) { try { d() } catch { /* noop */ } }
        // Kill spawned ACP agent children so they don't outlive the host.
        for (const c of acpConnects) { try { c.dispose() } catch { /* noop */ } }
        for (const s of opencodeServers) await s.close()
      }
    },
  }
}
