import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

export function registerCommands(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.get('/api/commands', async (c) => {
    const b = reg.get(c.req.query('backend') ?? '') ?? reg.active()
    return c.json(await b.listCommands())
  })
  app.post('/api/command', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string; command?: string; arguments?: string }
    if (!body.sessionId || !body.command) return c.json({ error: 'sessionId and command required' }, 400)
    const id = state.normalizeSessionId(body.sessionId)
    await reg.forSession(id).runCommand(id, body.command, body.arguments)
    return c.json({ ok: true })
  })
}
