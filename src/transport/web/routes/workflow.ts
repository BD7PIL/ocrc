import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { WorkflowManager } from '../../../core/workflow/manager.js'
import type { ArtifactStore } from '../../../core/workflow/artifacts.js'
import type { SavedWorkflowsStore } from '../../../core/workflow/saved.js'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { WorkflowApproval } from '../../../core/workflow/approval.js'
import type { EscalationRegistry } from '../../../core/workflow/escalations.js'
import { compileScript } from '../../../core/workflow/manager.js'
import {
  clampRunsLimit, projectArtifactItems, projectArtifacts, projectNodeResult, projectRunEvents,
  projectRunSummary, projectSavedWorkflowRun, projectWorkspace, readArtifactChunk,
  resolveRunToolCallIds, toolCardRows,
} from '../../../core/workflow/queries.js'
import { buildCreateWorkflowDisplay } from '../../../core/workflow/display.js'

/** The vendored `attachmentChunkMaxBytes` — the same 512 KiB block the attachment
 *  reads use, deliberately not a second constant. */
const ARTIFACT_CHUNK_MAX_BYTES = 512 * 1024

/**
 * P2 workflow surface. Deliberately thin: the manager owns run semantics and the
 * journal is the single source of truth, so these handlers only translate HTTP.
 *
 * P4-1a adds the projection endpoint (`/api/workflow/projection`), which is what the
 * `/z/` panel reads: the manager turns the journal into the vendored run state and this
 * route hands it over verbatim. Nothing here is UI-shaped — no route invents a field.
 */
export interface WorkflowRouteDeps {
  manager: WorkflowManager
  artifacts: ArtifactStore
  saved: SavedWorkflowsStore
  registry: BackendRegistry
  /** P3: the world.run approval gate (absent = no run can start a command). */
  approval?: WorkflowApproval
  /** P4-1a: the escalation registry (the run projection's pending questions). */
  escalations?: EscalationRegistry
}

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../vendor/zcode-dwf/skills/dynamic-workflows')

/**
 * Escalations raised by actor sessions. The records live in the host's registry
 * (`src/core/workflow/escalations.ts`) so the run projection and this route read the
 * same list — a question that the panel shows but the model cannot answer (or the
 * reverse) is the one failure mode worth designing out.
 */
function registryOf(deps: WorkflowRouteDeps): EscalationRegistry {
  if (!deps.escalations) throw new Error('workflow escalations registry is not wired')
  return deps.escalations
}

/** `ResolveWorkflowQuestion`: the parent-side answer to an actor's escalation. */
export function answerEscalation(deps: WorkflowRouteDeps, runId: string | undefined, question: string, answer: string): boolean {
  if (!runId) return false
  return registryOf(deps).answer(runId, question, answer)
}

export function registerWorkflow(app: Hono, deps: WorkflowRouteDeps) {
  const { manager, artifacts, saved } = deps

  /**
   * The page the panel itself reads for a session's rows (`/api/session/:id` defaults to
   * the same depth), so the two faces agree on which runs still have a card to open.
   */
  const ANCHOR_WINDOW = 200

  /**
   * runId → the engine's tool call id, resolved from the parent session's own tool cards.
   *
   * The run record cannot hold this id (the engine mints it *after* the tool call returns,
   * so the plugin only ever knows the message — see journal.ts `RunToolJoin`), and the
   * vendored summary is read by the run-directory page, which holds no rows of its own to
   * join against. The host therefore answers the pair it was given against the transcript
   * it already serves.
   *
   * Unresolved stays unresolved: a run submitted over HTTP has no join at all, and a card
   * that has been folded out of the window cannot be matched — the vendored model drops
   * such rows, and inventing an id would open the wrong page.
   */
  async function toolCallIdsFor(runIds: readonly string[], sessionId: string): Promise<Record<string, string>> {
    const joins: Record<string, { messageId: string; toolName: string }> = {}
    for (const runId of runIds) {
      const join = manager.runJoin(runId)
      if (join) joins[runId] = join
    }
    if (Object.keys(joins).length === 0) return {}
    try {
      const cards = await deps.registry.forSession(sessionId).getHistory(sessionId, ANCHOR_WINDOW)
      return resolveRunToolCallIds(joins, toolCardRows(cards))
    } catch {
      // A busy or adopted engine can refuse the read. The summaries are still worth
      // returning — they simply arrive without anchors, exactly as they would on a cold
      // session, rather than turning the directory into a 500.
      return {}
    }
  }

  app.get('/api/workflow/runs', (c) => {
    const sessionId = c.req.query('sessionId')
    const runs = sessionId ? manager.runsForSession(sessionId) : manager.list()
    return c.json({ runs })
  })

  /**
   * The panel's read face (P4-1a): the vendored run state for a session, recomputed
   * from the journal. The container revision is deliberately NOT here — the consumer
   * owns it, because the consumer is the one coalescing deltas against a prior state.
   *
   * `joins` is our own extra (not part of the vendored wire): runId → the tool call that
   * started it, so the panel can resolve the card join key against the rows it holds.
   * `sessions` likewise: runId → the parent session, which the vendored run schema has
   * no field for (the container is per-session there) but the sidebar's cross-session
   * activity summary needs.
   */
  app.get('/api/workflow/projection', (c) => {
    const sessionId = c.req.query('sessionId')
    const runs = manager.projectedRuns(sessionId || undefined)
    const joins: Record<string, { messageId: string; toolName: string }> = {}
    const sessions: Record<string, string> = {}
    for (const run of runs) {
      const join = manager.runJoin(run.runId)
      if (join) joins[run.runId] = join
      const record = manager.get(run.runId)?.record
      if (record?.parentSessionId) sessions[run.runId] = record.parentSessionId
    }
    return c.json({ runs, joins, sessions })
  })

  app.get('/api/workflow/projection/:id', (c) => {
    const run = manager.projectedRun(c.req.param('id'))
    if (!run) return c.json({ error: 'not_found' }, 404)
    return c.json({ run })
  })

  // Registered BEFORE `/runs/:id`: a literal path that comes after the parameterised one
  // is swallowed by it (`summaries` would match `:id` and 404 as an unknown run).
  /** ② workflowRuns — the restart-safe enumeration face (the projection is memory-only). */
  app.get('/api/workflow/runs/summaries', async (c) => {
    const sessionId = c.req.query('sessionId')
    if (!sessionId) return c.json({ error: 'sessionId required' }, 400)
    const limitRaw = c.req.query('limit')
    const summaries = manager.runSummaries(sessionId, clampRunsLimit(limitRaw !== undefined ? Number(limitRaw) : undefined))
    const toolCallIds = await toolCallIdsFor(summaries.map((s) => s.record.runId), sessionId)
    return c.json({ runs: summaries.map((s) => projectRunSummary(s.record, { updatedAt: s.updatedAt, toolCallId: toolCallIds[s.record.runId] })) })
  })

  app.get('/api/workflow/runs/:id', (c) => {
    const view = manager.get(c.req.param('id'))
    if (!view) return c.json({ error: 'not_found' }, 404)
    return c.json(view)
  })

  app.get('/api/workflow/runs/:id/events', (c) => {
    const id = c.req.param('id')
    const afterRaw = c.req.query('afterSequence')
    const limitRaw = c.req.query('limit')
    const events = manager.events(id, {
      ...(afterRaw !== undefined ? { afterSequence: Number(afterRaw) } : {}),
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
    })
    return c.json({ events, live: manager.live().includes(id) })
  })

  app.post('/api/workflow/runs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scriptText?: string; name?: string; cwd?: string; sessionId?: string
      tokenBudget?: number; maxConcurrency?: number
      actorModel?: { providerID: string; modelID: string }
      messageId?: string; toolName?: string
    }
    if (typeof body.scriptText !== 'string' || !body.scriptText.trim()) {
      return c.json({ error: 'scriptText required' }, 400)
    }
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : process.cwd()
    const res = await manager.submit({
      scriptText: body.scriptText,
      cwd,
      ...(body.name ? { name: body.name } : {}),
      ...(body.sessionId ? { parentSessionId: body.sessionId } : {}),
      ...(typeof body.tokenBudget === 'number' ? { tokenBudget: body.tokenBudget } : {}),
      ...(typeof body.maxConcurrency === 'number' ? { maxConcurrency: body.maxConcurrency } : {}),
      ...(body.actorModel ? { actorModel: body.actorModel } : {}),
      ...(body.messageId && body.toolName
        ? { toolJoin: { messageId: body.messageId, toolName: body.toolName } }
        : {}),
    })
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 400)
    return c.json({ runId: res.runId })
  })

  app.post('/api/workflow/runs/:id/cancel', (c) => {
    const id = c.req.param('id')
    // A 404 for an unknown run and a 409 for a known-but-not-running one: the panel
    // words its rejection from that distinction ("this run is not running" vs "no such
    // run"), so collapsing them into one status would lose a fact.
    if (!manager.get(id)) return c.json({ error: 'not_found' }, 404)
    const ok = manager.cancel(id)
    return c.json({ ok, ...(ok ? {} : { error: 'not_running' }) }, ok ? 200 : 409)
  })

  app.post('/api/workflow/runs/:id/resume', async (c) => {
    const res = await manager.resume(c.req.param('id'))
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 409)
    return c.json({ ok: true })
  })

  app.post('/api/workflow/runs/:id/amend', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scriptText?: string; messageId?: string; toolName?: string }
    if (typeof body.scriptText !== 'string' || !body.scriptText.trim()) return c.json({ error: 'scriptText required' }, 400)
    const res = await manager.amend(c.req.param('id'), body.scriptText, {
      ...(body.messageId && body.toolName ? { toolJoin: { messageId: body.messageId, toolName: body.toolName } } : {}),
    })
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 409)
    return c.json({ runId: res.runId })
  })

  /**
   * P4-1c: a live run's settings, in place. Only the concurrency knob has a real
   * implementation here; a model change on a live run is refused with a reason rather
   * than accepted-and-ignored (the actors already own their sessions).
   */
  app.post('/api/workflow/runs/:id/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { maxConcurrency?: number | null; subagentModel?: string | null }
    if (body.subagentModel !== undefined && body.subagentModel !== null) {
      return c.json({ error: 'subagent_model_immutable', message: 'A live run\'s subagent model cannot change: its actors already own their sessions. Amend the script to start a revision with a new model.' }, 409)
    }
    // `null` is the vendored "back to the default" value: the run drops its own limit and
    // runs on the process ceiling. The manager clamps, so asking for a huge number and
    // letting it clamp is the same thing stated once.
    const requested = body.maxConcurrency === null ? Number.MAX_SAFE_INTEGER : body.maxConcurrency
    if (typeof requested !== 'number') return c.json({ error: 'maxConcurrency required' }, 400)
    const res = manager.amendSettings(c.req.param('id'), { maxConcurrency: requested })
    if (!res.ok) return c.json({ error: res.error }, res.error === 'not_found' ? 404 : 409)
    return c.json({ ok: true, maxConcurrency: res.maxConcurrency })
  })

  // ── P4-2: the seven read faces the run pages use ────────────────────────────
  // Each mirrors one vendored query (read-only, stateless, safe to re-send) and each is
  // answered from the journal. The paths are ours; the shapes are the vendored wire
  // shapes, because the renderer validates them.
  //
  // Authorization follows the vendored contract: `sessionId` must be the run's parent
  // session, and anything else gets the same 404 as "no such run" — a query that
  // distinguishes the two would be an existence oracle for other sessions' runs. The
  // caller is already behind the host token; this is the second lock the contract asks
  // for, and it costs one comparison.
  const authorize = (c: { req: { param: (k: string) => string; query: (k: string) => string | undefined } }) => {
    const sessionId = c.req.query('sessionId')
    if (!sessionId) return { error: 'sessionId required' as const, status: 400 as const }
    const snapshot = manager.runSnapshot(c.req.param('id'))
    if (!snapshot) return { error: 'not_found' as const, status: 404 as const }
    if (snapshot.record.parentSessionId !== sessionId) return { error: 'not_found' as const, status: 404 as const }
    return { snapshot }
  }

  /** ① workflowRunEvents — one journal page, cursor = sequence. */
  app.get('/api/workflow/runs/:id/events/v4', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    const id = c.req.param('id')
    const afterRaw = c.req.query('afterSequence')
    const limitRaw = c.req.query('limit')
    const afterSequence = afterRaw !== undefined ? Number(afterRaw) : undefined
    const limit = limitRaw !== undefined ? Math.max(1, Number(limitRaw)) : undefined
    // Ask for one more than the page to answer `hasMore` honestly.
    const page = manager.events(id, {
      ...(afterSequence !== undefined ? { afterSequence } : {}),
      limit: (limit ?? 200) + 1,
    })
    const hasMore = limit !== undefined ? page.length > limit : false
    return c.json({ events: projectRunEvents(limit !== undefined ? page.slice(0, limit) : page), hasMore })
  })

  /** ③ workflowRunArtifacts — every version of every artifact (the durable read). */
  app.get('/api/workflow/runs/:id/artifacts/v4', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    return c.json({ artifacts: projectArtifacts(auth.snapshot.events, auth.snapshot.createdAt) })
  })

  /** ④ workflowRunArtifactData — a preset board's items (tagged `report` rows). */
  app.get('/api/workflow/runs/:id/artifacts/:artifactId/data', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    const snapshot = auth.snapshot
    const afterRaw = c.req.query('afterSequence')
    const limitRaw = c.req.query('limit')
    const page = projectArtifactItems(snapshot.events, c.req.param('artifactId'), {
      ...(afterRaw !== undefined ? { afterSequence: Number(afterRaw) } : {}),
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
    })
    return c.json(page)
  })

  /** ⑤ workflowRunArtifactRead — one block of a content artifact's bytes. */
  app.get('/api/workflow/runs/:id/artifacts/:artifactId/versions/:version/read', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    const runId = c.req.param('id')
    const version = Number(c.req.param('version'))
    const offset = Number(c.req.query('offset') ?? 0)
    const limit = Number(c.req.query('limit') ?? ARTIFACT_CHUNK_MAX_BYTES)
    if (!Number.isInteger(version) || version < 1) return c.json({ error: 'bad version' }, 400)
    if (!Number.isInteger(offset) || offset < 0) return c.json({ error: 'bad offset' }, 400)
    if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_CHUNK_MAX_BYTES) return c.json({ error: `limit must be 1..${ARTIFACT_CHUNK_MAX_BYTES}` }, 400)
    const chunk = readArtifactChunk(artifacts, runId, c.req.param('artifactId'), version, offset, limit)
    if (!chunk) return c.json({ error: 'not_found' }, 404)
    return c.json(chunk)
  })

  /**
   * The CreateWorkflow tool card's static picture (the analyzer's projection).
   *
   * Not one of the seven queries: the panel reads this off the tool ROW's `display`, and
   * the row is ours to fill. It is served here because the analyzer lives in the host.
   */
  app.get('/api/workflow/runs/:id/display', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    const scriptText = auth.snapshot.record.scriptText
    if (!scriptText) return c.json({ error: 'no_script' }, 404)
    return c.json({ display: buildCreateWorkflowDisplay(scriptText) })
  })

  /** ⑥ workflowRunWorkspace — the run's world calls as a transcript (no bodies). */
  app.get('/api/workflow/runs/:id/workspace', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    const { snapshot } = auth
    return c.json(projectWorkspace(snapshot.nodes, snapshot.events, snapshot.createdAt))
  })

  /** ⑦ workflowRunNodeResult — one node's body, bounded shape-preservingly. */
  app.get('/api/workflow/runs/:id/nodes/:siteId/:ordinal/result', (c) => {
    const auth = authorize(c)
    if ('error' in auth) return c.json({ error: auth.error }, auth.status)
    const { snapshot } = auth
    const siteId = c.req.param('siteId')
    const ordinal = Number(c.req.param('ordinal'))
    const node = snapshot.nodes.find((n) => n.siteId === siteId && n.ordinal === ordinal)
    if (!node) return c.json({ error: 'not_found' }, 404)
    const maxRaw = c.req.query('maxBytes')
    const maxBytes = maxRaw !== undefined ? Math.max(1, Math.min(Number(maxRaw), 32 * 1024)) : undefined
    return c.json(projectNodeResult(node, maxBytes))
  })

  /** Artifact bytes. The journal only ever holds `uri` + `bytes`; the bytes are
   *  served from here. */
  app.get('/api/workflow/runs/:id/artifacts/:artifactId/v/:version', (c) => {
    const runId = c.req.param('id')
    const artifactId = c.req.param('artifactId')
    const version = Number(c.req.param('version'))
    if (!Number.isInteger(version) || version < 1) return c.json({ error: 'bad version' }, 400)
    const found = artifacts.readVersion(runId, artifactId, version)
    if (!found) return c.json({ error: 'not_found' }, 404)
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        'Content-Type': found.contentType,
        'Content-Length': String(found.bytes.byteLength),
        // Artifacts are immutable per version — the version is in the path.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  })

  /**
   * Actor-side `submit_result`: the actor's tool call lands here and is routed to
   * the live run's driver, which hands it to the engine for validation. The answer
   * the model sees is the tool result, so a rejection comes back as a repair
   * instruction rather than a silent retry.
   */
  app.post('/api/workflow/submit', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string; payload?: unknown }
    if (typeof body.sessionId !== 'string' || !body.sessionId) return c.json({ error: 'sessionId required' }, 400)
    const delivered = manager.submitFromSession(body.sessionId, body.payload)
    return c.json(
      delivered
        ? { ok: true, note: 'Submitted. If the value does not satisfy the schema you will be told what to fix.' }
        : { ok: false, error: 'this session has no workflow ask in flight' },
      delivered ? 200 : 409,
    )
  })

  /**
   * Actor-side `escalate`: a question the workflow cannot answer itself. It is
   * recorded and surfaced; `ResolveWorkflowQuestion` (the parent-side tool) answers
   * it. Until an answer arrives the actor is told to continue with its best
   * judgment rather than block the run.
   */
  app.post('/api/workflow/escalate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string; question?: string; runId?: string; context?: string }
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question) return c.json({ error: 'question required' }, 400)
    // The actor's own session is the authoritative way back to the run (the actor rows
    // record it); `runId` is a hint the actor's prompt carried and is only a fallback.
    const runId = (body.sessionId ? manager.runForActorSession(body.sessionId) : undefined) ?? body.runId
    if (!runId || !manager.get(runId)) {
      return c.json({
        ok: false,
        error: 'no_run',
        question,
        note: 'This session is not attached to a workflow run, so there is nobody to answer. Continue with your best judgment and say what you assumed.',
      }, 409)
    }
    const rec = registryOf(deps).raise({
      runId,
      question,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(body.context ? { context: body.context } : {}),
    })
    return c.json({
      ok: true,
      qid: rec.qid,
      question,
      answer: rec.answer ?? null,
      note: rec.answer
        ? 'The user answered your question.'
        : 'No answer is available yet — continue with your best judgment and say what you assumed.',
    })
  })

  /** The panel's answer to a `world.run` approval card. */
  app.post('/api/workflow/approval', async (c) => {
    if (!deps.approval) return c.json({ error: 'unsupported' }, 501)
    const body = (await c.req.json().catch(() => ({}))) as { requestId?: string; decision?: string }
    if (typeof body.requestId !== 'string' || !body.requestId) return c.json({ error: 'requestId required' }, 400)
    if (!['once', 'always', 'reject'].includes(body.decision ?? '')) return c.json({ error: 'decision must be once|always|reject' }, 400)
    const ok = deps.approval.resolve(body.requestId, body.decision as 'once' | 'always' | 'reject')
    return c.json({ ok }, ok ? 200 : 404)
  })

  app.get('/api/workflow/approvals', (c) => {
    if (!deps.approval) return c.json({ pending: [] })
    return c.json({ pending: deps.approval.pending() })
  })

  /** `ResolveWorkflowQuestion`: answer an actor's escalation from the parent side. */
  app.post('/api/workflow/escalations/answer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { runId?: string; question?: string; answer?: string }
    if (typeof body.question !== 'string' || typeof body.answer !== 'string' || !body.answer.trim()) {
      return c.json({ error: 'question and answer required' }, 400)
    }
    const ok = answerEscalation(deps, body.runId, body.question, body.answer)
    const pending = body.runId ? registryOf(deps).pending(body.runId).map((e) => e.question) : []
    return c.json({ ok, pending }, ok ? 200 : 404)
  })

  /** Pending escalations of a run (the run view's "waiting on you" section). */
  app.get('/api/workflow/runs/:id/escalations', (c) => {
    const runId = c.req.param('id')
    const all = registryOf(deps).all(runId)
    return c.json({
      pending: all.filter((e) => e.answer === undefined),
      answered: all.filter((e) => e.answer !== undefined),
    })
  })

  /** `EvalWorkflowSnippet`: compile-only, no run. This is the feedback loop the
   *  authoring skill leans on hardest — it must be cheap and must never create a run. */
  app.post('/api/workflow/compile', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scriptText?: string }
    if (typeof body.scriptText !== 'string' || !body.scriptText.trim()) return c.json({ error: 'scriptText required' }, 400)
    const out = compileScript(body.scriptText)
    if (out.ok) {
      return c.json({
        ok: true,
        askSites: out.askSpecs?.size ?? 0,
        scriptHash: out.scriptHash,
        declaredRunCommands: out.declaredRunCommands ?? [],
      })
    }
    return c.json({ ok: false, diagnostics: out.diagnostics })
  })

  /** The authoring skill's text. `CreateWorkflow` refuses until it has been read
   *  (the vendored gate), and this is where it comes from — one copy, vendored. */
  app.get('/api/workflow/skill', (c) => {
    const file = c.req.query('file') ?? 'SKILL.md'
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return c.json({ error: 'bad file' }, 400)
    try {
      const text = readFileSync(join(SKILL_DIR, file), 'utf-8')
      return c.json({ file, text })
    } catch {
      return c.json({ error: 'not_found', files: ['SKILL.md', 'patterns.md', 'examples.md'] }, 404)
    }
  })

  // ── saved workflows ───────────────────────────────────────────────────────
  // P4-3: the panel's saved-workflow hub reads the vendored shape
  // (`{workflows, invalid, dir}`, meta = description + whenToUse + args, scope two-valued).
  // ocrc keeps ONE machine-wide store, so `dir`/`path` report that store's file — the truth
  // about where the record lives — and `invalid` is empty by construction (the store is
  // JSON, not a directory of frontmattered markdown files that can fail to parse).
  const savedEntry = (w: ReturnType<SavedWorkflowsStore['list']>[number]) => ({
    name: w.name,
    description: w.description ?? '',
    ...(w.whenToUse ? { whenToUse: w.whenToUse } : {}),
    ...(w.args?.length
      ? {
          args: Object.fromEntries(
            w.args.map((a) => [a.name, { type: a.type, ...(a.description ? { description: a.description } : {}), ...(a.required ? { required: true } : {}), ...(a.default !== undefined ? { default: a.default } : {}) }]),
          ),
        }
      : {}),
    scope: w.scope ?? 'project',
    path: saved.filePath(),
  })

  app.get('/api/workflow/saved', (c) => {
    const scopeRaw = c.req.query('scope')
    const scope = scopeRaw === 'global' || scopeRaw === 'project' ? scopeRaw : undefined
    return c.json({
      workflows: saved.listScoped(scope).map(savedEntry),
      invalid: [],
      dir: dirname(saved.filePath()),
    })
  })

  /** The raw store list (ids included) — what `ocrc wf saved` and the tools use. */
  app.get('/api/workflow/saved/raw', (c) => c.json({ workflows: saved.list() }))

  // The vendored saved-workflow API is NAME-keyed; these are the routes the panel uses.
  // (The id-keyed ones below stay for the model tool face and `ocrc wf`.)
  const scopeOfQuery = (raw: string | undefined) => (raw === 'global' || raw === 'project' ? raw : undefined)

  app.get('/api/workflow/saved/by-name/:name', (c) => {
    const wf = saved.getByName(c.req.param('name'), scopeOfQuery(c.req.query('scope')))
    if (!wf) return c.json({ ok: false, reason: 'not_found' }, 404)
    return c.json({
      ok: true,
      name: wf.name,
      path: saved.filePath(),
      scope: wf.scope ?? 'project',
      meta: {
        description: wf.description ?? '',
        ...(wf.whenToUse ? { whenToUse: wf.whenToUse } : {}),
        ...(wf.args?.length ? { args: Object.fromEntries(wf.args.map((a) => [a.name, { type: a.type, ...(a.description ? { description: a.description } : {}), ...(a.required ? { required: true } : {}), ...(a.default !== undefined ? { default: a.default } : {}) }])) } : {}),
      },
      script: wf.scriptText,
    })
  })

  /**
   * The list view's history call: the vendored store asks for runs with NO name (it wants
   * every run in the scope, not one workflow's). Answering that with a failure envelope
   * made the panel iterate `undefined` and trip its error boundary ("e is not iterable") —
   * so this route exists, and it always answers `{runs: [...]}`.
   */
  app.get('/api/workflow/saved/runs', (c) => {
    const scope = scopeOfQuery(c.req.query('scope')) ?? 'project'
    const names = new Set(saved.listScoped(scope).map((w) => w.name))
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 50) || 50, 64))
    const runs = manager.list().filter((r) => r.name !== undefined && names.has(r.name))
    const views = runs.slice(0, limit).map((record) => {
      const snapshot = manager.runSnapshot(record.runId)
      return projectSavedWorkflowRun({ record, events: snapshot?.events ?? [], createdAt: snapshot?.createdAt ?? 0 })
    })
    return c.json({ runs: views, ...(runs.length > limit ? { truncated: true } : {}) })
  })

  app.get('/api/workflow/saved/by-name/:name/runs', (c) => {
    const wf = saved.getByName(c.req.param('name'), scopeOfQuery(c.req.query('scope')))
    if (!wf) return c.json({ ok: false, reason: 'not_found' }, 404)
    const limitRaw = c.req.query('limit')
    const limit = Math.max(1, Math.min(Number(limitRaw ?? 20) || 20, 64))
    const runs = manager.list().filter((r) => r.name === wf.name)
    const views = runs.slice(0, limit).map((record) => {
      const snapshot = manager.runSnapshot(record.runId)
      return projectSavedWorkflowRun({ record, events: snapshot?.events ?? [], createdAt: snapshot?.createdAt ?? 0 })
    })
    return c.json({ runs: views, ...(runs.length > limit ? { truncated: true } : {}) })
  })

  app.post('/api/workflow/saved/by-name/:name/meta', async (c) => {
    const wf = saved.getByName(c.req.param('name'), scopeOfQuery(c.req.query('scope')))
    if (!wf) return c.json({ ok: false, reason: 'not_found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { description?: string; whenToUse?: string; args?: unknown }
    if (typeof body.description !== 'string') return c.json({ ok: false, reason: 'invalid_meta' }, 400)
    saved.setMeta(wf.id, {
      description: body.description,
      ...(typeof body.whenToUse === 'string' ? { whenToUse: body.whenToUse } : {}),
      ...(Array.isArray(body.args) ? { args: body.args as never } : {}),
    })
    return c.json({ ok: true, path: saved.filePath() })
  })

  app.post('/api/workflow/saved/by-name/:name/move', (c) =>
    c.json({
      ok: false,
      reason: 'unsupported',
      detail: 'ocrc 的已保存 workflow 存在一个机器级 store 里（不是按项目分目录的文件），没有可搬动的文件。要换作用域请重新保存一次。',
    }, 501))

  app.delete('/api/workflow/saved/by-name/:name', (c) => {
    const wf = saved.getByName(c.req.param('name'), scopeOfQuery(c.req.query('scope')))
    if (!wf) return c.json({ ok: false, reason: 'not_found' }, 404)
    return c.json({ ok: saved.remove(wf.id) })
  })

  /** P4-3: `getSavedWorkflow` — the entry plus its script (the detail page). */
  app.get('/api/workflow/saved/:id', (c) => {
    const scopeRaw = c.req.query('scope')
    const scope = scopeRaw === 'global' || scopeRaw === 'project' ? scopeRaw : undefined
    const byName = c.req.query('name')
    const wf = byName ? saved.getByName(byName, scope) : saved.get(c.req.param('id'))
    if (!wf) return c.json({ ok: false, reason: 'not_found' }, 404)
    return c.json({
      ok: true,
      name: wf.name,
      path: saved.filePath(),
      scope: wf.scope ?? 'project',
      meta: {
        description: wf.description ?? '',
        ...(wf.whenToUse ? { whenToUse: wf.whenToUse } : {}),
        ...(wf.args?.length ? { args: Object.fromEntries(wf.args.map((a) => [a.name, { type: a.type, ...(a.description ? { description: a.description } : {}), ...(a.required ? { required: true } : {}), ...(a.default !== undefined ? { default: a.default } : {}) }])) } : {}),
      },
      script: wf.scriptText,
    })
  })

  /** P4-3: `updateSavedWorkflowMeta`. */
  app.post('/api/workflow/saved/:id/meta', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { description?: string; whenToUse?: string; args?: unknown }
    if (typeof body.description !== 'string') return c.json({ ok: false, reason: 'invalid_meta' }, 400)
    const updated = saved.setMeta(c.req.param('id'), {
      description: body.description,
      ...(typeof body.whenToUse === 'string' ? { whenToUse: body.whenToUse } : {}),
      ...(Array.isArray(body.args) ? { args: body.args as never } : {}),
    })
    if (!updated) return c.json({ ok: false, reason: 'not_found' }, 404)
    return c.json({ ok: true, path: saved.filePath() })
  })

  /** P4-3: `listSavedWorkflowRuns` — the run history, matched by the run's own name. */
  app.get('/api/workflow/saved/:id/runs', (c) => {
    const wf = saved.get(c.req.param('id'))
    if (!wf) return c.json({ ok: false, reason: 'not_found' }, 404)
    const limitRaw = c.req.query('limit')
    const limit = Math.max(1, Math.min(Number(limitRaw ?? 20) || 20, 64))
    const runs = manager.list().filter((r) => r.name === wf.name)
    const views = runs.slice(0, limit).map((record) => {
      const snapshot = manager.runSnapshot(record.runId)
      return projectSavedWorkflowRun({
        record,
        events: snapshot?.events ?? [],
        createdAt: snapshot?.createdAt ?? 0,
      })
    })
    return c.json({ runs: views, ...(runs.length > limit ? { truncated: true } : {}) })
  })

  app.post('/api/workflow/saved', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string; scriptText?: string; description?: string; whenToUse?: string
      args?: unknown; cwd?: string; scope?: 'project' | 'global'
    }
    if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ error: 'name required' }, 400)
    if (typeof body.scriptText !== 'string' || !body.scriptText.trim()) return c.json({ error: 'scriptText required' }, 400)
    const wf = saved.save({
      name: body.name,
      scriptText: body.scriptText,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.whenToUse === 'string' ? { whenToUse: body.whenToUse } : {}),
      ...(Array.isArray(body.args) ? { args: body.args as never } : {}),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
      ...(body.scope === 'global' || body.scope === 'project' ? { scope: body.scope } : {}),
    })
    return c.json({ workflow: wf })
  })

  app.delete('/api/workflow/saved/:id', (c) => {
    const ok = saved.remove(c.req.param('id'))
    return c.json({ ok }, ok ? 200 : 404)
  })

  /**
   * P4-3: `moveSavedWorkflow` (global → project) is honestly refused. Upstream moves a
   * file between two directories; ocrc has one store, so there is nothing to move — and
   * "we did nothing but said yes" is the one answer the panel cannot recover from (it
   * would show the entry as project-scoped while the store still says global).
   */
  app.post('/api/workflow/saved/:id/move', (c) =>
    c.json({
      ok: false,
      reason: 'unsupported',
      detail: 'ocrc 的已保存 workflow 存在一个机器级 store 里（不是按项目分目录的文件），没有可搬动的文件。要换作用域请重新保存一次。',
    }, 501))

  // The panel's launcher is name-keyed; the id-keyed route below stays for the tools.
  app.post('/api/workflow/saved/by-name/:name/run', async (c) => {
    const wf = saved.getByName(c.req.param('name'), scopeOfQuery(c.req.query('scope')))
    if (!wf) return c.json({ error: 'not_found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { args?: Record<string, unknown>; sessionId?: string }
    const resolved = saved.resolveArgs(wf.id, body.args)
    if (!resolved.ok) return c.json({ error: resolved.error }, 400)
    const res = await manager.submit({
      scriptText: wf.scriptText,
      cwd: wf.cwd ?? process.cwd(),
      name: wf.name,
      args: resolved.args,
      ...(body.sessionId ? { parentSessionId: body.sessionId } : {}),
    })
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 400)
    saved.noteRun(wf.id)
    return c.json({ runId: res.runId })
  })

  app.post('/api/workflow/saved/:id/run', async (c) => {
    const id = c.req.param('id')
    const wf = saved.get(id)
    if (!wf) return c.json({ error: 'not_found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { args?: Record<string, unknown>; sessionId?: string }
    const resolved = saved.resolveArgs(id, body.args)
    if (!resolved.ok) return c.json({ error: resolved.error }, 400)
    const res = await manager.submit({
      scriptText: wf.scriptText,
      cwd: wf.cwd ?? process.cwd(),
      name: wf.name,
      args: resolved.args,
      ...(body.sessionId ? { parentSessionId: body.sessionId } : {}),
    })
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 400)
    saved.noteRun(id)
    return c.json({ runId: res.runId })
  })
}
