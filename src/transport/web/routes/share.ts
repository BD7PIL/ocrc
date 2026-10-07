import type { Hono } from 'hono'
import type { SharesStore } from '../../../core/shares.js'
import type { BackendRegistry } from '../../../core/agent/registry.js'

/**
 * 0.27 M6 分享 — public read-only transcript pages.
 *  - registerSharePublic: BEFORE the auth guard (GET /api/share/:code is
 *    unauthenticated by design — the code IS the capability).
 *  - registerShareAuthed: POST /api/share (authed) snapshots the session's
 *    full history into the store.
 */
export function registerSharePublic(app: Hono, shares: SharesStore) {
  app.get('/api/share/:code', (c) => {
    const code = c.req.param('code')
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(code)) return c.json({ error: 'invalid code' }, 400)
    const entry = shares.get(code)
    if (!entry) return c.json({ error: 'not found' }, 404)
    return c.json({
      title: entry.title,
      createdAt: entry.createdAt,
      cards: entry.cards,
    })
  })
}

export function registerShareAuthed(app: Hono, shares: SharesStore, reg: import('../../../core/agent/registry.js').BackendRegistry) {
  app.post('/api/share', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string; title?: string }
    if (!body.sessionId) return c.json({ error: 'sessionId required' }, 400)
    const backend = reg.forSession(body.sessionId)
    const cards = await backend.getHistory(body.sessionId).catch(() => [] as import('../../../core/structured-card.js').StructuredCard[])
    if (!cards.length) return c.json({ error: '会话没有可分享的转写' }, 400)
    const entry = shares.create(body.sessionId, body.title ?? '', cards)
    return c.json({ code: entry.code, url: `/share/${entry.code}`, count: entry.cards.length })
  })

  app.delete('/api/share/:code', (c) => {
    return c.json({ ok: shares.remove(c.req.param('code')) })
  })
}
