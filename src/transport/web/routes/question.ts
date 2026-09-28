import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

function isStringArrayArray(v: unknown): v is string[][] {
  return Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every((x) => typeof x === 'string'))
}

export function registerQuestion(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.post('/api/question/reply', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string; requestId?: string; answers?: unknown }
    if (typeof body.sessionId !== 'string' || !body.sessionId) return c.json({ error: 'sessionId required' }, 400)
    if (typeof body.requestId !== 'string' || !body.requestId) return c.json({ error: 'requestId required' }, 400)
    if (!isStringArrayArray(body.answers)) return c.json({ error: 'answers must be string[][]' }, 400)
    const id = state.normalizeSessionId(body.sessionId)
    const backend = reg.forSession(id)
    if (!backend.answerQuestion) return c.json({ error: 'unsupported' }, 400)
    return c.json(await backend.answerQuestion(id, body.requestId, body.answers))
  })

  app.post('/api/question/reject', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string; requestId?: string }
    if (typeof body.sessionId !== 'string' || !body.sessionId) return c.json({ error: 'sessionId required' }, 400)
    if (typeof body.requestId !== 'string' || !body.requestId) return c.json({ error: 'requestId required' }, 400)
    const id = state.normalizeSessionId(body.sessionId)
    const backend = reg.forSession(id)
    if (!backend.rejectQuestion) return c.json({ error: 'unsupported' }, 400)
    return c.json(await backend.rejectQuestion(id, body.requestId))
  })
}
