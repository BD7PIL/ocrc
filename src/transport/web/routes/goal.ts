import type { Hono } from 'hono'
import type { GoalManager } from '../../../core/goal.js'

/**
 * N12 goal routes. The goal record is authoritative in host state.json, so both
 * surfaces are thin: a read that hands back the stored record (plus the
 * transient verifying flag) and a single command endpoint.
 *
 * The six-state projection the vendor UI expects (active/paused/verifying/
 * verified/notSatisfied/failed) is NOT done here — it is derived in the /z/
 * bridge from the persisted four-state record plus `verifying`, mirroring
 * upstream, where the projection states never touch storage.
 */
export function registerGoal(app: Hono, manager: GoalManager) {
  app.get('/api/session/:id/goal', (c) => {
    const sessionId = c.req.param('id')
    const goal = manager.status(sessionId)
    return c.json({ goal: goal ?? null, verifying: manager.isVerifying(sessionId) })
  })

  app.post('/api/goal', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      action?: string
      sessionId?: string
      objective?: string
      tokenBudget?: unknown
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) return c.json({ error: 'sessionId required' }, 400)

    switch (body.action) {
      case 'set': {
        const objective = typeof body.objective === 'string' ? body.objective : ''
        const tokenBudget = typeof body.tokenBudget === 'number' && Number.isFinite(body.tokenBudget) && body.tokenBudget > 0
          ? Math.floor(body.tokenBudget)
          : undefined
        const res = manager.set(sessionId, objective, tokenBudget != null ? { tokenBudget } : undefined)
        return res.ok ? c.json({ goal: res.goal }) : c.json({ error: res.error }, 400)
      }
      case 'pause': {
        const res = manager.pause(sessionId)
        return res.ok ? c.json({ goal: res.goal }) : c.json({ error: res.error }, 404)
      }
      case 'resume': {
        const res = manager.resume(sessionId)
        return res.ok ? c.json({ goal: res.goal }) : c.json({ error: res.error }, 404)
      }
      case 'clear':
        return c.json({ ok: manager.clear(sessionId) })
      default:
        return c.json({ error: 'action must be set|pause|resume|clear' }, 400)
    }
  })
}
