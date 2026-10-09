import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { WorkflowManager } from '../../../core/workflow/manager.js'
import type { ArtifactStore } from '../../../core/workflow/artifacts.js'
import type { SavedWorkflowsStore } from '../../../core/workflow/saved.js'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { WorkflowApproval } from '../../../core/workflow/approval.js'
import { compileScript } from '../../../core/workflow/manager.js'

/**
 * P2 workflow surface. Deliberately thin: the manager owns run semantics and the
 * journal is the single source of truth, so these handlers only translate HTTP.
 *
 * The `/z/` projection (workflowRuns, deltas, the seven v4 query methods) is P4 and
 * layers on top of the same manager — nothing here is UI-shaped.
 */
export interface WorkflowRouteDeps {
  manager: WorkflowManager
  artifacts: ArtifactStore
  saved: SavedWorkflowsStore
  registry: BackendRegistry
  /** P3: the world.run approval gate (absent = no run can start a command). */
  approval?: WorkflowApproval
}

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../vendor/zcode-dwf/skills/dynamic-workflows')

/**
 * Escalations raised by actor sessions. Deliberately in-memory: a question lives
 * exactly as long as the run that asked it, and a restarted host has no live run
 * to answer.
 */
const escalations = new Map<string, Array<{ question: string; answer?: string }>>()

function recordEscalation(runId: string | undefined, question: string): void {
  const key = runId ?? '*'
  const list = escalations.get(key) ?? []
  if (!list.some((e) => e.question === question)) list.push({ question })
  escalations.set(key, list)
}

/** `ResolveWorkflowQuestion`: the parent-side answer to an actor's escalation. */
export function answerEscalation(runId: string | undefined, question: string, answer: string): boolean {
  const key = runId ?? '*'
  const list = escalations.get(key) ?? []
  const hit = list.find((e) => e.question === question)
  if (hit) { hit.answer = answer; return true }
  return false
}

/** Pending escalations for a run (surfaced in the run view). */
export function pendingEscalations(runId: string): string[] {
  return (escalations.get(runId) ?? []).filter((e) => !e.answer).map((e) => e.question)
}

export function registerWorkflow(app: Hono, deps: WorkflowRouteDeps) {
  const { manager, artifacts, saved } = deps

  app.get('/api/workflow/runs', (c) => c.json({ runs: manager.list() }))

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
    })
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 400)
    return c.json({ runId: res.runId })
  })

  app.post('/api/workflow/runs/:id/cancel', (c) => {
    const ok = manager.cancel(c.req.param('id'))
    return c.json({ ok }, ok ? 200 : 409)
  })

  app.post('/api/workflow/runs/:id/resume', async (c) => {
    const res = await manager.resume(c.req.param('id'))
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 409)
    return c.json({ ok: true })
  })

  app.post('/api/workflow/runs/:id/amend', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scriptText?: string }
    if (typeof body.scriptText !== 'string' || !body.scriptText.trim()) return c.json({ error: 'scriptText required' }, 400)
    const res = await manager.amend(c.req.param('id'), body.scriptText)
    if (!res.ok) return c.json({ error: res.error, diagnostics: res.diagnostics }, 409)
    return c.json({ runId: res.runId })
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
    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string; question?: string; runId?: string }
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question) return c.json({ error: 'question required' }, 400)
    recordEscalation(body.runId, question)
    const answered = (escalations.get(body.runId ?? '*') ?? []).find((e) => e.question === question)?.answer
    return c.json({
      ok: true,
      question,
      answer: answered ?? null,
      note: answered
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
    const ok = answerEscalation(body.runId, body.question, body.answer)
    return c.json({ ok, pending: body.runId ? pendingEscalations(body.runId) : [] }, ok ? 200 : 404)
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
  app.get('/api/workflow/saved', (c) => c.json({ workflows: saved.list() }))

  app.post('/api/workflow/saved', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string; scriptText?: string; description?: string
      args?: unknown; cwd?: string
    }
    if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ error: 'name required' }, 400)
    if (typeof body.scriptText !== 'string' || !body.scriptText.trim()) return c.json({ error: 'scriptText required' }, 400)
    const wf = saved.save({
      name: body.name,
      scriptText: body.scriptText,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(Array.isArray(body.args) ? { args: body.args as never } : {}),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
    })
    return c.json({ workflow: wf })
  })

  app.delete('/api/workflow/saved/:id', (c) => {
    const ok = saved.remove(c.req.param('id'))
    return c.json({ ok }, ok ? 200 : 404)
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
