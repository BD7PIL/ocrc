import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

/** Subagent (child) sessions of a turn — feeds the plan-HUD badge/list. */
export function registerSubagents(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.get('/api/session/:id/subagents', async (c) => {
    const b = reg.forSession(c.req.param('id'))
    if (!b.getSubagents) return c.json({ subagents: [] })
    const id = state.normalizeSessionId(c.req.param('id'))
    return c.json({ subagents: await b.getSubagents(id) })
  })
}
