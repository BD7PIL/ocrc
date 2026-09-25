import type { Hono } from 'hono'
import type { SessionState } from '../../../core/state.js'

/** Tier2 suggested follow-ups for a session (generated post-finalize, in-memory). */
export function registerSuggestions(app: Hono, state: SessionState) {
  app.get('/api/session/:id/suggestions', async (c) => {
    return c.json({ suggestions: state.getSessionSuggestions(c.req.param('id')) ?? [] })
  })
}
