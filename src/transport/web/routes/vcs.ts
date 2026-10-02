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
    const file = c.req.query('file')
    if (!file) return c.json({ error: 'file required' }, 400)
    const body = await backend.getVcsDiff(c.req.query('sessionId'), file)
    if (!body) return c.json({ error: 'unavailable' }, 404)
    return c.json(body)
  })
}

/** Session revert / unrevert + state (0.22). Separate file-level routes so the
 *  session id rides the path (auth + normalization parity with other routes). */
export function registerRevert(app: Hono, reg: BackendRegistry) {
  const run = (action: 'revert' | 'unrevert' | 'state') =>
    async (c: any) => {
      const id = c.req.param('id')
      const backend = reg.forSession(id)
      if (action === 'state') {
        if (!backend.getSessionRevert) return c.json({ error: 'unsupported' }, 501)
        const body = await backend.getSessionRevert(id)
        return body ? c.json(body) : c.json({ error: 'unavailable' }, 404)
      }
      const fn = action === 'revert' ? backend.revertSession : backend.unrevertSession
      if (!fn) return c.json({ error: 'unsupported' }, 501)
      const body = await fn.call(backend, id)
      return body ? c.json(body) : c.json({ error: 'unavailable' }, 404)
    }
  app.post('/api/session/:id/revert', run('revert'))
  app.post('/api/session/:id/unrevert', run('unrevert'))
  app.get('/api/session/:id/revert-state', run('state'))
}
