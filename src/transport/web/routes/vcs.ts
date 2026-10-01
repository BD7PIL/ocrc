import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'

/** 0.18 git pane data: branch + per-file working-tree status, and per-file
 *  patches. Proxied from the opencode server's /vcs endpoints (ocFetch).
 *  /vcs is project-global on the server, so this routes to the active backend. */
export function registerVcs(app: Hono, reg: BackendRegistry) {
  app.get('/api/vcs', async (c) => {
    const backend = reg.forSession(c.req.query('sessionId') ?? '')
    if (!backend.getVcs) return c.json({ error: 'unsupported' }, 501)
    const body = await backend.getVcs(c.req.query('sessionId'))
    if (!body) return c.json({ error: 'unavailable' }, 404)
    return c.json(body)
  })

  app.get('/api/vcs/diff', async (c) => {
    const backend = reg.forSession(c.req.query('sessionId') ?? '')
    if (!backend.getVcsDiff) return c.json({ error: 'unsupported' }, 501)
    const body = await backend.getVcsDiff(c.req.query('sessionId'))
    if (!body) return c.json({ error: 'unavailable' }, 404)
    return c.json({ files: body })
  })
}
