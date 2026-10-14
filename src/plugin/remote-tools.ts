import { tool } from '@opencode-ai/plugin'
import type { RemoteHostManager } from '../core/remote-host.js'
import type { RemotesStore } from '../core/remotes.js'
import type { BackendRegistry } from '../core/agent/registry.js'
import type { AttachedOpts } from './attached.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('remote-tools')

/**
 * 批次 3（2.0.0-alpha.3）: the ocrc remote-channel tool face — 四工具全套.
 *
 * The ocrc remote channel (remotes.json + SSH tunnels) is something the MODEL
 * can use directly: list remotes, push a workspace, provision opencode, and
 * open a session on a remote engine. Channel-agnostic by construction — the
 * tools live in the engine, so Telegram, the web panel and any other transport
 * all see the same capability.
 *
 * One handler layer, three mountings (see docs/research/e2-verdict.md):
 *  - V1 PRIMARY  → hooks.tool via `tool()` (same as rc-status/notify here)
 *  - V1 ATTACHED → same handlers, but every call is a thin HTTP call to the
 *    host's token-guarded API (the host owns the manager)
 *  - V2 setup    → `context.tool.transform((o) => o.add(...))` — the E2-verified
 *    runtime registration surface the SDK types don't mention. Requires
 *    `options: { namespace: 'ocrc' }` or the tool never reaches the model face,
 *    and `execute` must return `{ output }` with a matching `output` schema.
 *
 * Safety defaults:
 *  - remote_list only sees remotes with enabled=true (the panel's allowlist).
 *  - remote_create_session only targets `remote:<id>` backends that exist in
 *    the registry; its description forbids recursion (calling it FROM the
 *    session it creates) — the engine cannot enforce that, the contract says it.
 *  - remote_sync_workspace validates entries against the local root and only
 *    accepts absolute remote targets (manager-side too).
 */

/** The raw-JSON schema shape v2's transform.add takes for `args`/`output`.
 *  v1's zod `tool()` face is derived from the same declarations. */
export interface RemoteToolSpec {
  name: string
  description: string
  args: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>
  output?: { type: 'string' }
}

/** Mounting-neutral handler deps. Exactly one of `local` / `attached` is set. */
export interface RemoteToolDeps {
  local?: {
    remotes: RemotesStore
    manager: RemoteHostManager
    registry: BackendRegistry
  }
  attached?: AttachedOpts
}

const SPEC_REMOTE_LIST: RemoteToolSpec = {
  name: 'remote_list',
  description:
    'List ocrc remote hosts (SSH machines ocrc can drive as agent engines) with their lifecycle state. ' +
    'Only enabled remotes are visible. Use this before any other ocrc_remote_* tool to pick a target id.',
  args: {},
}

const SPEC_REMOTE_SYNC: RemoteToolSpec = {
  name: 'remote_sync_workspace',
  description:
    'Push a local workspace directory to an ocrc remote host over SSH (tar pipeline; collisions on the ' +
    'remote are backed up to *.ocrc-bak, never silently overwritten). Use after remote_list. ' +
    'remoteTarget must be an absolute path on the remote (/, ~ or $HOME form).',
  args: {
    remote_id: { type: 'string', description: 'Remote id from ocrc_remote_list', required: true },
    local_root: { type: 'string', description: 'Absolute local directory to push', required: true },
    remote_target: { type: 'string', description: 'Absolute remote target directory (e.g. ~/workspaces/demo)', required: true },
    entries: { type: 'string', description: 'Optional space-separated subset of entries relative to local_root (defaults to everything)' },
  },
}

const SPEC_REMOTE_PROVISION: RemoteToolSpec = {
  name: 'remote_provision',
  description:
    'Ensure opencode is installed on an ocrc remote host and report version drift. Path "auto" installs ' +
    'via the official installer (pinned) and falls back to a binary push when the remote has no internet; ' +
    '"push" forces the local/pinned binary; "install" forces the remote self-install. Use after remote_list.',
  args: {
    remote_id: { type: 'string', description: 'Remote id from ocrc_remote_list', required: true },
    path: { type: 'string', description: 'auto (default) | push | install' },
  },
}

const SPEC_REMOTE_CREATE_SESSION: RemoteToolSpec = {
  name: 'remote_create_session',
  description:
    'Open a new agent session on an ocrc remote host engine (in a given directory ON THE REMOTE filesystem). ' +
    'Returns the session id — hand work to it via normal messaging. NEVER call this tool from inside a ' +
    'session it created (no recursion); remote sessions are for delegating work, not for self-nesting. ' +
    'Use remote_sync_workspace first if the remote directory needs the current workspace files.',
  args: {
    remote_id: { type: 'string', description: 'Remote id from ocrc_remote_list', required: true },
    directory: { type: 'string', description: 'Absolute directory on the REMOTE filesystem', required: true },
    title: { type: 'string', description: 'Optional human-readable session title' },
  },
}

export const REMOTE_TOOL_SPECS = [SPEC_REMOTE_LIST, SPEC_REMOTE_SYNC, SPEC_REMOTE_PROVISION, SPEC_REMOTE_CREATE_SESSION]

// ── handlers (mounting-neutral; one result string per call) ───────────────────

type Args = Record<string, string | undefined>

async function hRemoteList(deps: RemoteToolDeps): Promise<string> {
  if (deps.attached) {
    const res = await call<{ remotes: Array<Record<string, unknown>> }>(deps.attached, '/api/remotes')
    const enabled = res.remotes.filter((r) => r.enabled === true || r.enabled === undefined && r.status)
    return formatRemotes(enabled as never)
  }
  const { remotes, manager } = requireLocal(deps)
  const list = remotes.list().filter((r) => r.enabled)
  return formatRemotes(list.map((r) => ({ ...r, status: manager.status(r.id) ?? null })))
}

async function hRemoteSync(deps: RemoteToolDeps, args: Args): Promise<string> {
  const id = args.remote_id?.trim()
  if (!id) return 'remote_sync_workspace failed: remote_id is required'
  const localRoot = args.local_root?.trim()
  if (!localRoot) return 'remote_sync_workspace failed: local_root is required'
  const remoteTarget = args.remote_target?.trim()
  if (!remoteTarget) return 'remote_sync_workspace failed: remote_target is required'
  const entries = args.entries?.trim() ? args.entries.trim().split(/\s+/) : undefined
  if (deps.attached) {
    const res = await call<{ ok?: boolean; detail?: string; error?: string }>(deps.attached, `/api/remotes/${encodeURIComponent(id)}/sync-workspace`, {
      method: 'POST',
      body: JSON.stringify({ localRoot, remoteTarget, entries }),
    })
    return res.detail ?? res.error ?? (res.ok ? 'synced' : 'sync failed')
  }
  const { manager } = requireLocal(deps)
  const result = await manager.syncDirectory(id, { localRoot, entries, remoteTarget })
  return result.detail
}

async function hRemoteProvision(deps: RemoteToolDeps, args: Args): Promise<string> {
  const id = args.remote_id?.trim()
  if (!id) return 'remote_provision failed: remote_id is required'
  const pathArg = (args.path?.trim() || 'auto') as 'auto' | 'push' | 'install'
  if (!['auto', 'push', 'install'].includes(pathArg)) {
    return 'remote_provision failed: path must be auto | push | install'
  }
  if (deps.attached) {
    const res = await call<{ ok?: boolean; detail?: string; error?: string }>(deps.attached, `/api/remotes/${encodeURIComponent(id)}/provision`, {
      method: 'POST',
      body: JSON.stringify({ path: pathArg }),
    })
    return res.detail ?? res.error ?? (res.ok ? 'provisioned' : 'provision failed')
  }
  const { manager } = requireLocal(deps)
  const result = await manager.provision(id, pathArg)
  return result.detail
}

async function hRemoteCreateSession(deps: RemoteToolDeps, args: Args): Promise<string> {
  const id = args.remote_id?.trim()
  if (!id) return 'remote_create_session failed: remote_id is required'
  const directory = args.directory?.trim()
  if (!directory) return 'remote_create_session failed: directory (on the remote) is required'
  const backendId = `remote:${id}`
  const body = JSON.stringify({ backendId, directory, ...(args.title?.trim() ? { title: args.title.trim() } : {}) })
  if (deps.attached) {
    const res = await call<{ id?: string; backendId?: string; error?: string }>(deps.attached, '/api/session', {
      method: 'POST',
      body,
    })
    if (res.id) return `session ${res.id} created on ${backendId} in ${directory}`
    return `remote_create_session failed: ${res.error ?? 'unknown error'}`
  }
  const { registry } = requireLocal(deps)
  const backend = registry.get(backendId)
  if (!backend) return `remote_create_session failed: no backend ${backendId} (is the remote enabled?)`
  try {
    const { id: sid } = await backend.createSession({ directory, ...(args.title?.trim() ? { title: args.title.trim() } : {}) })
    registry.tag(sid, backendId)
    return `session ${sid} created on ${backendId} in ${directory}`
  } catch (err) {
    log.warn(`remote_create_session: ${(err as Error).message}`)
    return `remote_create_session failed: ${(err as Error).message}`
  }
}

// ── formatting / plumbing ─────────────────────────────────────────────────────

function formatRemotes(list: Array<{ id: string; host: string; port: number; remotePort: number; enabled?: boolean; status?: { state?: string; detail?: string; localPort?: number; inspection?: { version?: string; platform?: string; arch?: string } } | null }>): string {
  if (list.length === 0) {
    return [
      'No enabled ocrc remotes.',
      'Manage remotes in the ocrc web panel (远程主机) or via POST /api/remotes, then retry.',
    ].join('\n')
  }
  const rows = list.map((r) => {
    const st = r.status
    const ver = st?.inspection?.version ? ` opencode ${st.inspection.version}` : ''
    const plat = st?.inspection?.platform ? ` (${st.inspection.platform}/${st.inspection.arch ?? '?'})` : ''
    const port = st?.localPort ? ` → local :${st.localPort}` : ''
    return `- ${r.id}: ${st?.state ?? 'unknown'} — ${r.host}:${r.remotePort}${port}${ver}${plat}${st?.detail ? ` · ${st.detail}` : ''}`
  })
  return ['Enabled ocrc remotes:', ...rows].join('\n')
}

function requireLocal(deps: RemoteToolDeps): NonNullable<RemoteToolDeps['local']> {
  if (!deps.local) throw new Error('local manager unavailable in this mounting')
  return deps.local
}

async function call<T>(opts: AttachedOpts, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${opts.baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(opts.resolveToken() ? { Authorization: `Bearer ${opts.resolveToken()}` } : {}), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ocrc host ${path} → ${res.status}: ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** Tools never throw into the model — a failure reads as a normal tool result. */
function guard(deps: RemoteToolDeps, name: string, err: unknown): string {
  log.warn(`${name} failed: ${(err as Error).message}`)
  if (deps.attached) {
    return `${name} failed: ocrc host unreachable at ${deps.attached.baseUrl} (${(err as Error).message}).`
  }
  return `${name} failed: ${(err as Error).message}`
}

// ── mounting 1+2: v1 hooks.tool (PRIMARY here / ATTACHED via HTTP) ────────────

/** zod arg-shape builder from the neutral spec (v1 `tool()` takes zod types). */
function zodArgs(spec: RemoteToolSpec) {
  const out: Record<string, unknown> = {}
  for (const [key, a] of Object.entries(spec.args)) {
    let field: unknown
    if (a.type === 'number') field = tool.schema.number().describe(a.description)
    else if (a.type === 'boolean') field = tool.schema.boolean().describe(a.description)
    else field = tool.schema.string().describe(a.description)
    out[key] = a.required ? field : (field as { optional: () => unknown }).optional()
  }
  return out as never
}

export function createRemoteToolsV1(deps: RemoteToolDeps): Record<string, ReturnType<typeof tool>> {
  const t: Record<string, ReturnType<typeof tool>> = {
    [SPEC_REMOTE_LIST.name]: tool({
      description: SPEC_REMOTE_LIST.description,
      args: zodArgs(SPEC_REMOTE_LIST),
      async execute() {
        try { return await hRemoteList(deps) } catch (err) { return guard(deps, SPEC_REMOTE_LIST.name, err) }
      },
    }),
    [SPEC_REMOTE_SYNC.name]: tool({
      description: SPEC_REMOTE_SYNC.description,
      args: zodArgs(SPEC_REMOTE_SYNC),
      async execute(args: Record<string, string>) {
        try { return await hRemoteSync(deps, args) } catch (err) { return guard(deps, SPEC_REMOTE_SYNC.name, err) }
      },
    }),
    [SPEC_REMOTE_PROVISION.name]: tool({
      description: SPEC_REMOTE_PROVISION.description,
      args: zodArgs(SPEC_REMOTE_PROVISION),
      async execute(args: Record<string, string>) {
        try { return await hRemoteProvision(deps, args) } catch (err) { return guard(deps, SPEC_REMOTE_PROVISION.name, err) }
      },
    }),
    [SPEC_REMOTE_CREATE_SESSION.name]: tool({
      description: SPEC_REMOTE_CREATE_SESSION.description,
      args: zodArgs(SPEC_REMOTE_CREATE_SESSION),
      async execute(args: Record<string, string>) {
        try { return await hRemoteCreateSession(deps, args) } catch (err) { return guard(deps, SPEC_REMOTE_CREATE_SESSION.name, err) }
      },
    }),
  }
  return t
}

// ── mounting 3: v2 setup tool.transform (E2-verified contract) ────────────────

/** The structural slice of v2's tool domain ocrc touches (docs/research/e2-verdict.md). */
export interface V2ToolRegistrar {
  transform(fn: (o: {
    add(t: {
      name: string
      description: string
      options?: { namespace?: string; codemode?: boolean }
      args?: Record<string, unknown>
      output?: Record<string, unknown>
      execute: (args: unknown, context: unknown) => Promise<{ output: string } | string>
    }): void
    update(name: string, fn: (t: Record<string, unknown>) => void): void
    remove(name: string): void
    list(): Array<{ id?: string; name?: string }>
  }) => Promise<void> | void): Promise<void> | void
}

/**
 * Register the four ocrc_remote_* tools on a V2 host. The E2 spike proved the
 * shape: namespace 'ocrc' is what makes the tool reach the model face (unnamed
 * additions land in the registry but are filtered out of the agent toolset),
 * execute must return `{ output }`, and `output` must declare a matching schema.
 */
export async function registerRemoteToolsV2(ctxTool: V2ToolRegistrar, deps: RemoteToolDeps): Promise<void> {
  await ctxTool.transform((o) => {
    o.add({
      name: SPEC_REMOTE_LIST.name,
      description: SPEC_REMOTE_LIST.description,
      options: { namespace: 'ocrc', codemode: false },
      output: { output: { type: 'string' } },
      execute: async () => {
        try { return { output: await hRemoteList(deps) } } catch (err) { return { output: guard(deps, SPEC_REMOTE_LIST.name, err) } }
      },
    })
    o.add({
      name: SPEC_REMOTE_SYNC.name,
      description: SPEC_REMOTE_SYNC.description,
      options: { namespace: 'ocrc', codemode: false },
      args: specJsonArgs(SPEC_REMOTE_SYNC),
      output: { output: { type: 'string' } },
      execute: async (args) => {
        try { return { output: await hRemoteSync(deps, (args ?? {}) as Args) } } catch (err) { return { output: guard(deps, SPEC_REMOTE_SYNC.name, err) } }
      },
    })
    o.add({
      name: SPEC_REMOTE_PROVISION.name,
      description: SPEC_REMOTE_PROVISION.description,
      options: { namespace: 'ocrc', codemode: false },
      args: specJsonArgs(SPEC_REMOTE_PROVISION),
      output: { output: { type: 'string' } },
      execute: async (args) => {
        try { return { output: await hRemoteProvision(deps, (args ?? {}) as Args) } } catch (err) { return { output: guard(deps, SPEC_REMOTE_PROVISION.name, err) } }
      },
    })
    o.add({
      name: SPEC_REMOTE_CREATE_SESSION.name,
      description: SPEC_REMOTE_CREATE_SESSION.description,
      options: { namespace: 'ocrc', codemode: false },
      args: specJsonArgs(SPEC_REMOTE_CREATE_SESSION),
      output: { output: { type: 'string' } },
      execute: async (args) => {
        try { return { output: await hRemoteCreateSession(deps, (args ?? {}) as Args) } } catch (err) { return { output: guard(deps, SPEC_REMOTE_CREATE_SESSION.name, err) } }
      },
    })
  })
}

function specJsonArgs(spec: RemoteToolSpec): Record<string, { type: string; description: string }> {
  const out: Record<string, { type: string; description: string }> = {}
  for (const [k, a] of Object.entries(spec.args)) out[k] = { type: a.type, description: a.description }
  return out
}
