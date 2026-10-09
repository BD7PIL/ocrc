import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

/** Subagent (child) sessions of a turn — feeds the plan-HUD badge/list. */
export function registerSubagents(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.get('/api/session/:id/subagents', async (c) => {
    const b = reg.forSession(c.req.param('id'))
    if (!b.getSubagents) return c.json({ subagents: [] })
    const id = state.normalizeSessionId(c.req.param('id'))
    // The subagent-directory page lists finished children (limit up to 100) and
    // skips todo progress; the plan HUD keeps the default small page with todos.
    const rawLimit = Number(c.req.query('limit'))
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : undefined
    const withTodos = c.req.query('todos') === '0' ? false : true
    const rows = await b.getSubagents(id, { limit, withTodos })
    // Annotate with the live busy flag (session.status/idle events → state):
    // the plan-HUD rows distinguish 运行中 from 已结束 instead of listing
    // every subagent forever.
    return c.json({ subagents: rows.map((r) => ({ ...r, busy: state.isSessionBusy(r.id) })) })
  })
}
