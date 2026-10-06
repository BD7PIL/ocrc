/**
 * OpencodeBackend — AgentBackend over the opencode SDK + plugin. This is the only
 * backend today; it keeps every opencode-specific shape (session/message JSON,
 * the raw `tui/select-session` POST, config/provider maps) behind the interface so
 * the relay and transports stay backend-agnostic. See docs/ACP_BACKEND_DESIGN.md.
 */
import type { OpencodeClient } from '@opencode-ai/sdk'
import type {
  AgentBackend, AgentInfo, BackendCapabilities, CommandInfo, DiffEntry, McpServer, ModelProvider, SubagentInfo,
  SkillInfo, FileEntry, WorktreeInfo,
  QuestionRequest, QuestionAnswerResult,
  PermissionDecision, PromptInput, SessionContext, SessionMeta, SessionRef, SessionSummary,
} from './backend.js'
import { buildDiffEntry, buildDiffEntryFromPatch } from './diff-util.js'
import type { ContentBlock, StructuredCard } from '../structured-card.js'
import { submitPrompt, markEphemeralSession } from '../../opencode/submit.js'
import { listAllSessions } from '../../opencode/list-sessions.js'
import { listWorkspaces as listWorkspacesImpl } from '../../opencode/workspaces.js'
import { cardsFromMessages, summarizeToolArgs } from '../history.js'
import { createLogger } from '../../utils/logger.js'
import { execFile } from 'node:child_process'
import { ocFetch } from '../../utils/oc-server-auth.js'

const log = createLogger('opencode-backend')

// Sidebar hygiene (epoch ms). Matches the previous fetchSessionSummaries rules.
const STALE_MS = 14 * 24 * 60 * 60 * 1000
const EMPTY_GRACE_MS = 60 * 60 * 1000

// Context-window overrides for models whose opencode/models.dev catalog entry is
// stale. Keyed by modelID; takes precedence over the catalog's limit.context.
const MODEL_CONTEXT_OVERRIDES: Record<string, number> = {
  'MiniMax-M3': 1_000_000, // catalog says 512k; real window is 1M
}

function isEmptySession(s: any): boolean {
  const created = s.time?.created ?? 0
  const updated = s.time?.updated ?? created
  return !s.title && updated === created
}

export interface OpencodeBackendDeps {
  client: OpencodeClient
  /** opencode server base URL — used to navigate the TUI (`tui/select-session`). */
  baseUrl?: string
  /** 0.26.0 remote instances: per-backend auth transport (Basic from
   *  remotes.json) replacing the env-backed ocFetch default. */
  fetchImpl?: typeof ocFetch
  /** Display host for /api/backends (remote hostname instead of local). */
  host?: string
  /** Backend id override ('remote:<id>'); default 'opencode'. */
  id?: string
  /** 0.26.0 remote derates: no local-TUI navigation, no live local-session
   *  mirroring, and no local-git VCS (the only methods that read the LOCAL
   *  filesystem — everything else here speaks HTTP and works remote as-is). */
  remote?: boolean
}

export function createOpencodeBackend(deps: OpencodeBackendDeps): AgentBackend {
  const { client, baseUrl } = deps
  const xfetch = deps.fetchImpl ?? ocFetch

  const capabilities: BackendCapabilities = {
    liveMirror: !deps.remote, // opencode mirrors the user's live local session
    tuiSelect: !!baseUrl && !deps.remote,
    workspaces: true,
    freeformWorkspace: false, // opencode enumerates projects; the UI uses a picker
    diff: true,
    todos: true,
    catalog: true,
    mcp: true,
    commands: true,
    sessionControls: false, // opencode keeps its own agent/model override chip
    imageInput: true, // prompt carries image attachments as inline file parts
    suggestions: process.env.OCRC_SUGGESTIONS !== 'off', // Tier2 follow-up generation
    skills: true, // GET /skill verified on 1.18.32
    files: true, // GET /file + /file/content
    worktrees: true, // GET/POST/DELETE /experimental/worktree (beta upstream)
    questions: true, // GET /question + reply/reject (question tool, 1.18+)
  }

  async function prompt(sessionId: string, input: PromptInput): Promise<void> {
    await submitPrompt(client, {
      text: input.text,
      sessionId,
      agent: input.agent,
      model: input.model,
      variant: (input as { variant?: string }).variant,
      images: input.images,
      signal: input.signal,
    })
  }

  /**
   * Tier2 suggested follow-ups: run a throwaway session asking for three
   * concise follow-ups, parse the JSON array from the reply, then delete the
   * throwaway session — the source conversation is never touched.
   *
   * Transport = raw ocFetch, NOT the SDK client. The SDK flow (session.create
   * + promptAsync + poll) never logged a single success or failure in
   * production while every raw-fetch feature worked — so the flow is rebuilt
   * on primitives proven live (POST /session, POST /session/:id/message — the
   * raw message POST is synchronous and returns the assistant reply directly).
   * Every exit path logs.
   */
  async function suggestFollowUps(
    sessionId: string,
    exchange: { user: string; assistant: string },
  ): Promise<string[]> {
    if (process.env.OCRC_SUGGESTIONS === 'off') return []
    let tmpId: string | undefined
    try {
      const created = await xfetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'ocrc-suggestions' }),
      })
      if (!created.ok) {
        log.warn(`suggestFollowUps: session create failed (${created.status})`)
        return []
      }
      tmpId = ((await created.json()) as any)?.id
      if (!tmpId) { log.warn('suggestFollowUps: session create returned no id'); return [] }
      markEphemeralSession(tmpId)
      const instruction = [
        'Below is an exchange between the user and their coding assistant.',
        '',
        `User: ${exchange.user}`,
        '',
        `Assistant: ${exchange.assistant}`,
        '',
        'Suggest 3 short follow-up instructions the user might send next.',
        'Rules: same language as the exchange; each at most 8 words; no numbering, no quotes, no explanations.',
        'Reply with ONLY a JSON array of 3 strings.',
      ].join('\n')
      // The raw message POST runs the turn synchronously — the response IS the
      // assistant message (info + parts). 45s cap: a stuck/permission-blocked
      // turn must not hold this fire-and-forget forever.
      const res = await xfetch(`${baseUrl}/session/${encodeURIComponent(tmpId)}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: instruction }] }),
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) {
        log.warn(`suggestFollowUps: prompt failed (${res.status})`)
        return []
      }
      const body = (await res.json()) as any
      const parts = (body?.parts ?? body?.info?.parts ?? []) as Array<{ type?: string; text?: string }>
      const reply = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('')
      const start = reply.indexOf('[')
      const end = reply.lastIndexOf(']')
      let items: string[] = []
      if (start !== -1 && end > start) {
        try {
          const arr = JSON.parse(reply.slice(start, end + 1))
          if (Array.isArray(arr)) items = arr.filter((x) => typeof x === 'string')
        } catch { /* fall through to line parse */ }
      }
      if (items.length === 0) {
        items = reply.split('\n').map((l) => l.trim().replace(/^[-\d.*\s]+/, '').replace(/^["']|["']$/g, '')).filter(Boolean)
      }
      log.info(`suggestFollowUps: ${items.length} suggestions parsed`)
      return items.slice(0, 3)
    } catch (err) {
      log.warn(`suggestFollowUps failed: ${(err as Error).message}`)
      return []
    } finally {
      if (tmpId) { try { await xfetch(`${baseUrl}/session/${encodeURIComponent(tmpId)}`, { method: 'DELETE' }) } catch { /* best effort */ } }
    }
  }

  async function abort(id: string): Promise<void> {
    try {
      await client.session.abort({ path: { id } })
    } catch {
      /* best-effort */
    }
  }

  async function hasSession(id: string): Promise<boolean> {
    // Only an explicit 404 (or error-free empty result) means "session gone".
    // Transport errors reject out of the await; other HTTP errors are rethrown —
    // the relay must NOT treat "can't tell" as "gone" and misroute the message.
    const res = await client.session.get({ path: { id } })
    if (res.data) return true
    const status = (res as { response?: { status?: number } }).response?.status
    const err = (res as { error?: unknown }).error
    if (status === 404 || (!status && !err)) return false
    const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
    throw new Error(`session.get failed${status ? ` (HTTP ${status})` : ''}: ${detail ?? 'unknown'}`)
  }

  async function listSessions(): Promise<SessionRef[]> {
    const sessions = (await listAllSessions(client)) as Array<{
      id: string; parentID?: string; time?: { created?: number; updated?: number }
    }>
    return sessions.map((s) => ({
      id: s.id, parentID: s.parentID, createdAt: s.time?.created, updatedAt: s.time?.updated,
    }))
  }

  async function listSessionSummaries(): Promise<SessionSummary[]> {
    const all = await listAllSessions(client)
    const now = Date.now()
    const roots = all.filter((s) => !s.parentID) // subagent children never shown
    const visible: any[] = []
    for (const s of roots) {
      const created = s.time?.created ?? 0
      const updated = s.time?.updated ?? created
      if (isEmptySession(s)) {
        if (now - created > EMPTY_GRACE_MS) continue // hide stale empties (non-destructive)
        visible.push(s); continue
      }
      if (now - updated > STALE_MS) continue // hide long-idle (non-destructive)
      visible.push(s)
    }
    visible.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
    // cost is OCRC state, not an opencode field — left undefined here; the caller
    // merges it from SessionState.getSessionCost().
    return visible.map((s) => ({
      id: s.id,
      title: s.title ?? '',
      agent: typeof s.agent === 'string' ? s.agent : s.agent?.name,
      model: typeof s.model === 'string' ? s.model : s.model?.id,
      cost: undefined,
      lastActiveAt: s.time?.updated ?? s.time?.created ?? 0,
      unread: false,
      directory: typeof s.directory === 'string' ? s.directory : undefined,
      additions: s.summary?.additions,
      deletions: s.summary?.deletions,
    }))
  }

  async function createSession(opts: { directory: string; title?: string }): Promise<{ id: string }> {
    // `as any`: the SDK's create() type omits the `directory` query param, but
    // opencode accepts it (creates the session in that directory).
    const res = await client.session.create({
      query: { directory: opts.directory },
      body: opts.title ? { title: opts.title } : {},
    } as any)
    const id = (res.data as { id?: string } | undefined)?.id
    if (!id) {
      log.error(`session.create no id: status=${res.response?.status} error=${JSON.stringify(res.error ?? null).slice(0, 300)} dataKeys=${res.data ? Object.keys(res.data as object).join(',') : 'null'}`)
      throw new Error('create failed')
    }
    return { id }
  }

  async function deleteSession(id: string): Promise<void> {
    await client.session.delete({ path: { id } })
  }

  async function renameSession(id: string, title: string): Promise<void> {
    await client.session.update({ path: { id }, body: { title } } as any)
  }

  async function getSessionMeta(id: string): Promise<SessionMeta> {
    const meta: SessionMeta = {}
    try {
      const s = ((await client.session.get({ path: { id } })).data ?? {}) as any
      if (typeof s.cost === 'number') meta.cost = s.cost
      const tin = typeof s.tokens?.input === 'number' ? s.tokens.input : undefined
      const tout = typeof s.tokens?.output === 'number' ? s.tokens.output : undefined
      if (tin !== undefined && tout !== undefined) meta.tokens = { input: tin, output: tout }
      if (s.agent?.name) meta.agent = s.agent.name
      if (typeof s.model === 'string') meta.model = s.model.split('/').pop() ?? s.model
    } catch { /* optional */ }
    return meta
  }

  // Per-second readers (ContextRing + Inspector tick) hit getContext during
  // streaming — it re-parses the FULL message list each call (MBs on long
  // sessions). Short TTL keeps the UI live at a bounded cost.
  const HOT_TTL_MS = 1500
  const hotCache = new Map<string, { at: number; data: unknown }>()
  function hotCached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = hotCache.get(key)
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data as T)
    return load().then((data) => { hotCache.set(key, { at: Date.now(), data }); return data })
  }

  async function getContext(id: string): Promise<SessionContext> {
    return hotCached(`ctx:${id}`, HOT_TTL_MS, async () => {
    const s = ((await client.session.get({ path: { id } })).data ?? {}) as any

    // A session can switch models mid-way, and the live context window belongs to
    // whichever model produced the LATEST turn — so resolve BOTH the model and the
    // current usage from the last assistant message (keeping used + max same-model).
    let providerId: string | undefined
    let modelId: string | undefined
    let used: number | undefined
    try {
      const msgs = ((await client.session.messages({ path: { id } })).data ?? []) as any[]
      // Scan up to 3 recent assistant messages: the newest often has no tokens
      // yet (turn in flight) — the previous settled ones carry the honest
      // "current context" estimate.
      let assistantSeen = 0
      for (let i = msgs.length - 1; i >= 0 && assistantSeen < 3; i--) {
        const info = (msgs[i]?.info ?? msgs[i]) as any
        if (info?.role !== 'assistant') continue
        assistantSeen += 1
        const t = info?.tokens
        if (t && used == null) {
          used = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
        }
        if (info?.modelID) { modelId = info.modelID; providerId = info.providerID; break }
      }
    } catch { /* best-effort */ }

    // Fall back to the session's configured model (opencode stores { id, providerID }).
    const modelObj = s.model && typeof s.model === 'object' ? s.model : undefined
    if (!modelId) modelId = modelObj?.id ?? (typeof s.model === 'string' ? s.model : undefined)
    if (!providerId) providerId = modelObj?.providerID
    if (used == null && s.tokens) used = (s.tokens.input ?? 0) + (s.tokens.output ?? 0)

    // max = the active model's context window. Prefer the providers catalog (models.dev),
    // but override models whose catalog entry is known-stale (verified real limits).
    let max: number | undefined = modelId ? MODEL_CONTEXT_OVERRIDES[modelId] : undefined
    if (max == null) {
      try {
        const providers = (((await client.config.providers()).data as any)?.providers ?? []) as any[]
        const m =
          providers.find((p) => p.id === providerId)?.models?.[modelId ?? ''] ??
          providers.map((p) => p?.models?.[modelId ?? '']).find(Boolean)
        const lim = (m as any)?.limit?.context
        if (typeof lim === 'number' && lim > 0) max = lim
      } catch { /* best-effort */ }
    }

    // Only surface used/max when known — never leak undefined keys (consumers
    // read tokens.used / tokens.max and treat absence as "unknown").
    const tokens: Record<string, number> = { ...(s.tokens ?? {}) }
    if (typeof used === 'number') tokens.used = used
    if (typeof max === 'number') tokens.max = max

    return {
      agent: s.agent?.name,
      model: modelId,
      tokens,
      cost: typeof s.cost === 'number' ? s.cost : undefined, // caller falls back to state
      directory: typeof s.directory === 'string' ? s.directory : undefined,
    }
    })
  }

  async function getHistory(id: string, limit?: number, offset?: number): Promise<StructuredCard[]> {
    const res = await client.session.messages({ path: { id } })
    const messages = (res.data ?? []) as any[]
    return cardsFromMessages(id, messages, limit, offset)
  }

  async function getMessageBlocks(sessionId: string, messageId: string): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = []
    try {
      const m = ((await client.session.message({ path: { id: sessionId, messageID: messageId } })).data ?? {}) as any
      for (const part of m.parts ?? []) {
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text })
        if (part.type === 'tool' && typeof part.tool === 'string') {
          const st = part.state?.status ?? 'running'
          blocks.push({
            type: 'tool', tool: part.tool,
            args: summarizeToolArgs(part.tool, part.state?.input ?? {}).slice(0, 60),
            status: st === 'error' ? 'error' : st === 'done' || st === 'completed' ? 'done' : 'running',
          })
        }
      }
    } catch (err) {
      log.info('getMessageBlocks fallback fetch failed', (err as Error).message)
    }
    return blocks
  }

  async function getDiff(id: string): Promise<DiffEntry[]> {
    const res = await (client.session as any).diff({ path: { id } } as any)
    // 1.18.32 returns SnapshotFileDiff[] {file, patch, additions, deletions,
    // status} — the old before/after parse silently produced empty diffs.
    const raw = (res.data ?? []) as Array<any>
    return raw
      .filter((d) => (d.file ?? d.path) != null)
      .map((d) => typeof d.patch === 'string'
        ? buildDiffEntryFromPatch(String(d.file ?? d.path), d.patch, d.additions, d.deletions)
        : buildDiffEntry(d.file ?? d.path ?? '', d.before ?? '', d.after ?? ''))
  }

  async function getTodos(id: string): Promise<unknown[]> {
    const res = await (client.session as any).todo({ path: { id } } as any)
    return (res.data ?? []) as unknown[]
  }

  async function getSessionsStatus(): Promise<unknown> {
    return (await client.session.status()).data
  }

  async function ping(): Promise<boolean> {
    try { await client.session.status(); return true } catch { return false }
  }

  async function getAgents(directory?: string): Promise<AgentInfo[]> {
    let agents: Record<string, { model?: string; description?: string }> = {}
    try { agents = (((await client.config.get(directory ? { query: { directory } } : {})).data as any)?.agent ?? {}) } catch { /* empty */ }
    return Object.entries(agents)
      .filter(([, v]) => typeof v?.model === 'string')
      .map(([name, v]) => ({ name, model: v!.model as string, description: v?.description ?? '' }))
  }

  async function getModels(directory?: string): Promise<ModelProvider[]> {
    let providers: Array<{ id: string; name: string; models: Record<string, { name?: string }> }> = []
    try { providers = (((await client.config.providers(directory ? { query: { directory } } : {})).data as any)?.providers ?? []) } catch { /* empty */ }
    // opencode's config-level filters (what the native picker honors): an
    // enabled_providers whitelist, a disabled_providers blacklist, and a
    // per-provider provider.<id>.models whitelist. The connected set above is
    // already auth-scoped; this layer is the user's explicit curation.
    try {
      const cfg: any = ((await client.config.get(directory ? { query: { directory } } : {})).data) ?? {}
      const enabled: string[] | undefined = cfg.enabled_providers
      const disabled: string[] | undefined = cfg.disabled_providers
      const cfgModels = (cfg.provider ?? {}) as Record<string, { models?: Record<string, unknown> }>
      if (enabled?.length) providers = providers.filter((p) => enabled.includes(p.id))
      if (disabled?.length) providers = providers.filter((p) => !disabled.includes(p.id))
      providers = providers.map((p) => {
        const whitelist = cfgModels[p.id]?.models
        const allowed = whitelist ? Object.keys(whitelist) : []
        if (!allowed.length) return p
        const keep = new Set(allowed)
        return { ...p, models: Object.fromEntries(Object.entries(p.models ?? {}).filter(([id]) => keep.has(id))) }
      })
    } catch { /* config unavailable — fall back to the unfiltered connected set */ }
    return providers.map((p) => ({
      id: p.id, name: p.name,
      models: Object.entries(p.models ?? {}).map(([id, m]) => ({
        id, name: m?.name ?? id,
        // reasoning-effort variants (v1.18 model.variants) — e.g. glm-5.3-flash
        // exposes low/high/max. Absent = model has no variants.
        variants: (m as any)?.variants ? Object.keys((m as any).variants) : undefined,
      })),
    }))
  }

  async function getSubagents(sessionId: string): Promise<SubagentInfo[]> {
    return hotCached(`subs:${sessionId}`, 2000, async () => {
    const all = (await listAllSessions(client)) as Array<{
      id: string; parentID?: string; title?: string; time?: { updated?: number }
    }>
    const children = all.filter((s) => s.parentID === sessionId).slice(0, 8)
    const out: SubagentInfo[] = []
    for (const c of children) {
      let done = 0
      let total = 0
      try {
        const todos = await getTodos(c.id)
        total = todos.length
        done = todos.filter((t) => (t as { status?: string })?.status === 'completed').length
      } catch { /* child without todos */ }
      out.push({ id: c.id, title: c.title ?? '', updatedAt: c.time?.updated, done, total })
    }
    return out
    })
  }

  async function getMcp(directory?: string): Promise<McpServer[]> {
    let mcp: Record<string, { type?: string; enabled?: boolean }> = {}
    try { mcp = (((await client.config.get(directory ? { query: { directory } } : {})).data as any)?.mcp ?? {}) } catch { /* empty */ }
    return Object.entries(mcp).map(([name, v]) => ({
      name, type: v?.type, status: v?.enabled === false ? 'disabled' : 'configured',
    }))
  }

  function listWorkspaces() {
    return listWorkspacesImpl(client)
  }

  // ── M8: skills / files / worktree sandboxes ────────────────────────────────
  // /skill and /experimental/worktree have no typed SDK members in 1.17.13 —
  // raw fetch against the server (same posture as selectTuiSession).

  async function getSkills(directory?: string): Promise<SkillInfo[]> {
    try {
      const q = new URLSearchParams()
      if (directory) q.set('directory', directory)
      const res = await xfetch(`${baseUrl}/skill?${q.toString()}`)
      if (!res.ok) return []
      const raw = (await res.json()) as Array<{ name?: string; description?: string }>
      return (raw ?? []).map((s) => ({ name: String(s?.name ?? ''), description: s?.description }))
    } catch { return [] }
  }

  async function listFiles(directory: string | undefined, path: string): Promise<FileEntry[]> {
    try {
      const q = new URLSearchParams({ path })
      if (directory) q.set('directory', directory)
      const res = await xfetch(`${baseUrl}/file?${q.toString()}`)
      if (!res.ok) return []
      const raw = (await res.json()) as Array<{ name?: string; path?: string; type?: string }>
      return (raw ?? []).map((f) => ({
        name: String(f?.name ?? ''),
        path: String(f?.path ?? ''),
        type: f?.type === 'directory' ? 'directory' : 'file',
      }))
    } catch { return [] }
  }

  async function readFile(directory: string | undefined, path: string): Promise<{ type: string; content: string }> {
    const q = new URLSearchParams({ path })
    if (directory) q.set('directory', directory)
    const res = await xfetch(`${baseUrl}/file/content?${q.toString()}`)
    if (!res.ok) throw new Error(`file/content ${res.status}`)
    const body = (await res.json()) as { type?: string; content?: string }
    return { type: body?.type ?? 'text', content: body?.content ?? '' }
  }

  async function listWorktreeSandboxes(directory?: string): Promise<WorktreeInfo[]> {
    try {
      const q = new URLSearchParams()
      if (directory) q.set('directory', directory)
      const res = await xfetch(`${baseUrl}/experimental/worktree?${q.toString()}`)
      if (!res.ok) return []
      const raw = (await res.json()) as Array<{ name?: string; directory?: string }> | string[]
      return (Array.isArray(raw) ? raw : []).map((w) =>
        typeof w === 'string' ? { name: w } : { name: String(w?.name ?? ''), directory: w?.directory },
      )
    } catch { return [] }
  }

  async function createWorktreeSandboxes(directory: string | undefined, name: string): Promise<WorktreeInfo | null> {
    const q = new URLSearchParams()
    if (directory) q.set('directory', directory)
    const res = await xfetch(`${baseUrl}/experimental/worktree?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { name?: string; directory?: string } | null
    return body ? { name: body.name ?? name, directory: body.directory } : { name, directory: undefined }
  }

  async function removeWorktreeSandboxes(directory: string | undefined, name: string): Promise<boolean> {
    const q = new URLSearchParams()
    if (directory) q.set('directory', directory)
    const res = await xfetch(`${baseUrl}/experimental/worktree?${q.toString()}`, { method: 'DELETE' })
    return res.ok
  }

  // ── M10: interactive questions (question tool) ─────────────────────────────
  // /question has no typed SDK members in 1.17.13 — raw fetch. The endpoints
  // are directory-scoped, and the reply/reject paths don't carry the session,
  // so resolve the directory from the session first (verified posture).

  async function sessionDirectory(sessionId: string): Promise<string | undefined> {
    try {
      const res = await xfetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}`)
      if (!res.ok) return undefined
      const body = (await res.json()) as { directory?: string }
      return typeof body?.directory === 'string' ? body.directory : undefined
    } catch { return undefined }
  }

  async function listQuestions(directory?: string): Promise<QuestionRequest[]> {
    try {
      const q = new URLSearchParams()
      if (directory) q.set('directory', directory)
      const res = await xfetch(`${baseUrl}/question?${q.toString()}`)
      if (!res.ok) return []
      const raw = (await res.json()) as Array<any>
      return (raw ?? []).map((r) => ({
        id: String(r?.id ?? ''),
        sessionId: String(r?.sessionID ?? r?.sessionId ?? ''),
        questions: Array.isArray(r?.questions) ? r.questions : [],
        tool: r?.tool ? { messageID: r.tool.messageID, callID: r.tool.callID } : undefined,
      }))
    } catch { return [] }
  }

  async function answerQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<QuestionAnswerResult> {
    const directory = await sessionDirectory(sessionId)
    if (directory === undefined) return { ok: false }
    const q = new URLSearchParams({ directory })
    const res = await xfetch(`${baseUrl}/question/${encodeURIComponent(requestId)}/reply?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    })
    if (res.status === 404) return { ok: false, stale: true } // resolved elsewhere
    return { ok: res.ok }
  }

  async function rejectQuestion(sessionId: string, requestId: string): Promise<QuestionAnswerResult> {
    const directory = await sessionDirectory(sessionId)
    if (directory === undefined) return { ok: false }
    const q = new URLSearchParams({ directory })
    const res = await xfetch(`${baseUrl}/question/${encodeURIComponent(requestId)}/reject?${q.toString()}`, { method: 'POST' })
    if (res.status === 404) return { ok: false, stale: true }
    return { ok: res.ok }
  }

  async function listCommands(): Promise<CommandInfo[]> {
    const data = ((await client.command.list()).data ?? []) as Array<{ name: string; description?: string }>
    return data.map((d) => ({ name: d.name, description: d.description ?? '' }))
  }

  async function runCommand(id: string, command: string, args?: string): Promise<void> {
    await client.session.command({ path: { id }, body: { command, arguments: args ?? '' } } as any)
  }

  async function resolvePermission(id: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await (client as any).postSessionIdPermissionsPermissionId({
      path: { id, permissionID: requestId },
      body: { response: decision },
    })
  }

  /** Navigate the TUI via POST /tui/select-session (SDK v1 has no typed method). */
  async function selectTuiSession(id: string, signal?: AbortSignal): Promise<void> {
    if (!baseUrl) return
    try {
      const normalized = baseUrl.replace(/\/+$/, '')
      const timeoutSignal = AbortSignal.timeout(2000)
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const res = await xfetch(`${normalized}/tui/select-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionID: id }), signal: combined,
      })
      if (!res.ok) log.debug(`tui/select-session HTTP ${res.status}`)
    } catch (err) {
      log.debug(`tui/select-session skipped: ${(err as Error).message}`)
    }
  }

  // ── 0.18: tool output pages + git pane ────────────────────────────────────
  // Raw ocFetch (the proven in-plugin transport — see suggestFollowUps).

  async function getMessageRaw(sessionId: string, messageId: string): Promise<{ info: unknown; parts: unknown[] } | undefined> {
    try {
      const res = await xfetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`)
      if (!res.ok) return undefined
      return (await res.json()) as { info: unknown; parts: unknown[] }
    } catch { return undefined }
  }

  /** Read-only git exec (fixed args, no user input) — the opencode server's
   *  /vcs endpoints are unusably slow on huge worktrees. */
  function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout))
      })
    })
  }

  // Server-side git scans on big worktrees take tens of seconds — cache
  // results per session for 2 minutes so pane re-opens are instant.
  const VCS_TTL = 120_000
  const vcsCache = new Map<string, { at: number; data: unknown }>()
  function vcsCached<T>(key: string, load: () => Promise<T>): Promise<T | undefined> {
    const hit = vcsCache.get(key)
    if (hit && Date.now() - hit.at < VCS_TTL) return Promise.resolve(hit.data as T)
    return load().then((data) => { vcsCache.set(key, { at: Date.now(), data }); return data })
      .catch(() => { vcsCache.delete(key); return undefined })
  }

  async function getVcs(sessionId?: string): Promise<{ branch?: string; defaultBranch?: string; status: Array<{ file: string; additions?: number; deletions?: number; status?: string }> } | undefined> {
    return vcsCached(`vcs:${sessionId ?? ''}`, async () => {
      // opencode's own /vcs endpoints take minutes on huge worktrees (observed
      // 279s → 404 on production) — spawn read-only git directly instead.
      const dir = sessionId ? await sessionDirectory(sessionId) : undefined
      if (!dir) return undefined
      const [branch, status] = await Promise.all([
        git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(dir, ['status', '--porcelain=v1', '-uno']),
      ])
      const kindOf = (x: string) => (x === 'A' ? 'added' : x === 'D' ? 'deleted' : x ? 'modified' : '')
      return {
        branch: branch.trim(),
        status: status.split('\n').filter(Boolean).map((line) => ({
          file: line.slice(3),
          status: kindOf(line[0]) || kindOf(line[1]),
        })),
      }
    })
  }

  async function getVcsDiff(sessionId?: string, file?: string): Promise<{ file: string; patch: string } | undefined> {
    return vcsCached(`vcsdiff:${sessionId ?? ''}:${file ?? ''}`, async () => {
      const dir = sessionId ? await sessionDirectory(sessionId) : undefined
      if (!dir || !file) return undefined
      // Whole-tree diffs reach tens of MB here — one file at a time, capped.
      const patch = await git(dir, ['diff', 'HEAD', '--patch', '--no-color', '--', file])
      const MAX = 400_000
      return { file, patch: patch.length > MAX ? patch.slice(0, MAX) + '\n… (patch truncated)' : patch }
    })
  }


  async function revertOrUnrevert(sessionId: string, action: 'revert' | 'unrevert', messageId?: string): Promise<{ id: string; revert?: { messageID: string } } | undefined> {
    try {
      // revert REQUIRES {messageID} (revert up to and including that message);
      // unrevert takes no body (restores the last revert).
      const res = await xfetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'revert' ? { messageID: messageId } : {}),
      })
      if (!res.ok) { log.warn(`session ${action} HTTP ${res.status}`); return undefined }
      const body = (await res.json()) as any
      return { id: String(body?.id ?? sessionId), revert: body?.revert ?? undefined }
    } catch (err) { log.warn(`session ${action} failed`, (err as Error).message); return undefined }
  }
  const revertSession = (sessionId: string, messageId: string) => revertOrUnrevert(sessionId, 'revert', messageId)
  const unrevertSession = (sessionId: string) => revertOrUnrevert(sessionId, 'unrevert')

  async function getSessionRevert(sessionId: string): Promise<{ reverted: boolean; messageID?: string } | undefined> {
    try {
      const res = await xfetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}`)
      if (!res.ok) return undefined
      const body = (await res.json()) as any
      return body?.revert?.messageID
        ? { reverted: true, messageID: String(body.revert.messageID) }
        : { reverted: false }
    } catch { return undefined }
  }

  return {
    id: deps.id ?? 'opencode',
    host: deps.host,
    capabilities,
    prompt, abort,
    hasSession, listSessions, listSessionSummaries, createSession, deleteSession, renameSession,
    getSessionMeta, getContext, getHistory, getMessageBlocks, getDiff, getTodos, getSessionsStatus, ping,
    getAgents, getModels, getMcp, getSubagents, getSkills, listFiles, readFile,
    listWorktreeSandboxes, createWorktreeSandboxes, removeWorktreeSandboxes,
    getMessageRaw,
    ...(deps.remote ? {} : { getVcs, getVcsDiff }),
    revertSession, unrevertSession, getSessionRevert,
    listQuestions, answerQuestion, rejectQuestion,
    listWorkspaces, listCommands, runCommand,
    resolvePermission,
    selectTuiSession,
    suggestFollowUps,
  }
}
