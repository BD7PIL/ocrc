import type { Hono } from 'hono'
import type { PermissionDecision } from '../../../core/agent/backend.js'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

const DECISIONS: PermissionDecision[] = ['once', 'always', 'reject']

export function registerApproval(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.post('/api/approval', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string; requestId?: string; decision?: PermissionDecision }
    if (typeof body.sessionId !== 'string' || !body.sessionId) return c.json({ error: 'sessionId required' }, 400)
    if (typeof body.requestId !== 'string' || !body.requestId) return c.json({ error: 'requestId required' }, 400)
    if (!DECISIONS.includes(body.decision as PermissionDecision)) return c.json({ error: 'decision must be once|always|reject' }, 400)
    const id = state.normalizeSessionId(body.sessionId)
    await reg.forSession(id).resolvePermission(id, body.requestId, body.decision as PermissionDecision)
    return c.json({ ok: true })
  })
}
