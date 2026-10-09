import type { Hono } from 'hono'
import type { WorkflowManager } from '../../../core/workflow/manager.js'
import type { ArtifactStore } from '../../../core/workflow/artifacts.js'
import type { SavedWorkflowsStore } from '../../../core/workflow/saved.js'
import type { BackendRegistry } from '../../../core/agent/registry.js'

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
