import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import { createLogger } from '../../../utils/logger.js'

const log = createLogger('create-session')

export function registerCreateSession(app: Hono, reg: BackendRegistry) {
  app.post('/api/session', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { directory?: string; title?: string; backendId?: string }
    const backend = (body.backendId && reg.get(body.backendId)) || reg.active()
    const directory = typeof body.directory === 'string' ? body.directory.trim() : ''
    // Backends that don't enumerate workspaces (e.g. ACP) create in their own
    // default working directory — the directory is optional there.
    if (!directory && backend.capabilities.workspaces) {
      return c.json({ error: 'directory required' }, 400)
    }
    try {
      const { id } = await backend.createSession({ directory, title: body.title })
      reg.tag(id, backend.id)
      return c.json({ id, backendId: backend.id })
    } catch (err) {
      log.error(`create failed on backend ${backend.id}: ${(err as Error).stack ?? (err as Error).message}`)
      return c.json({ error: 'create failed' }, 500)
    }
  })
}
