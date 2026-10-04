import type { Hono } from 'hono'
import type { RemoteHost, RemotesStore } from '../../../core/remotes.js'
import { redactRemote } from '../../../core/remotes.js'
import type { RemoteHostManager } from '../../../core/remote-host.js'

/**
 * 0.26.0 remote host management: CRUD + lifecycle actions for SSH remotes.
 * Secrets never round-trip: serverPassword is accepted on write, responses
 * carry only `hasPassword`. Backend registration itself is restart-effective
 * (same semantics as channels) — these routes manage the store and the live
 * tunnel/provision lifecycle.
 */
export function registerRemotes(app: Hono, remotes?: RemotesStore, manager?: RemoteHostManager) {
  if (!remotes || !manager) return

  app.get('/api/remotes', (c) => {
    const list = remotes.list().map((r) => ({
      ...redactRemote(r),
      status: manager.status(r.id) ?? null,
    }))
    return c.json({ remotes: list })
  })

  app.post('/api/remotes', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteHost>
    if (!body.host || typeof body.host !== 'string') return c.json({ error: 'host required' }, 400)
    if (body.port != null && (!Number.isFinite(body.port) || body.port < 1 || body.port > 65535)) {
      return c.json({ error: 'invalid port' }, 400)
    }
    if (body.remotePort != null && (!Number.isFinite(body.remotePort) || body.remotePort < 1 || body.remotePort > 65535)) {
      return c.json({ error: 'invalid remotePort' }, 400)
    }
    const saved = remotes.upsert({ ...body, host: body.host })
    return c.json({ remote: redactRemote(saved) })
  })

  app.patch('/api/remotes/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteHost>
    const updated = remotes.update(c.req.param('id'), body)
    if (!updated) return c.json({ error: 'not found' }, 404)
    // Live-effect the enabled toggle on the tunnel; registration waits for restart.
    if (body.enabled === true) manager.start(updated.id)
    if (body.enabled === false) manager.stop(updated.id)
    return c.json({ remote: redactRemote(updated) })
  })

  app.post('/api/remotes/:id/delete', (c) => {
    const id = c.req.param('id')
    manager.stop(id)
    if (!remotes.remove(id)) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })

  /** ssh-reachability + environment probe (platform/opencode/auth). */
  app.post('/api/remotes/:id/inspect', async (c) => {
    try {
      const inspection = await manager.inspect(c.req.param('id'))
      return c.json({ inspection })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  /** Provision opencode on the remote (official installer, version-pinned).
   *  Long-running: the panel polls GET /api/remotes for state + logTail. */
  app.post('/api/remotes/:id/provision', async (c) => {
    const result = await manager.provision(c.req.param('id'))
    return c.json(result, result.ok ? 200 : 502)
  })

  /** Copy THIS machine's opencode credentials to the remote (explicit action). */
  app.post('/api/remotes/:id/sync-auth', async (c) => {
    const result = await manager.syncAuth(c.req.param('id'))
    return c.json(result, result.ok ? 200 : 502)
  })
}
