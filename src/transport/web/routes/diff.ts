import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

export function registerDiff(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.get('/api/session/:id/diff', async (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    return c.json(await reg.forSession(id).getDiff(id))
  })
}
