import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { CardBus } from '../../../core/card-bus.js'
import type { SessionState } from '../../../core/state.js'

export function registerSession(app: Hono, reg: BackendRegistry, cardBus: CardBus, state: SessionState) {
  app.get('/api/session/:id', async (c) => {
    const rawId = c.req.param('id')
    const id = state.normalizeSessionId(rawId)
    const raw = c.req.query('limit')
    const limit = raw ? Math.max(0, Math.min(500, parseInt(raw, 10) || 0)) : undefined
    const cards = await reg.forSession(id).getHistory(id, limit)
    return c.json({ cards, lastSeq: cardBus.currentSeq(id) })
  })
}
