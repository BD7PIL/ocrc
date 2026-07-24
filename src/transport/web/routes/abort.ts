import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

export function registerAbort(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.post('/api/abort', async (c) => {
    const body = await c.req.json() as { sessionId: string }
    const id = state.normalizeSessionId(body.sessionId)
    state.getActiveAbort(id)?.abort()
    await reg.forSession(id).abort(id)
    return c.json({ ok: true })
  })
}
