import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'
import { fetchSessionSummaries, cleanupSubagentSessions } from '../session-summary.js'
import { createLogger } from '../../../utils/logger.js'

const log = createLogger('web')

export function registerSessions(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.get('/api/sessions', async (c) => {
    const summaries = await fetchSessionSummaries(reg, state)
    return c.json(summaries)
  })

  app.post('/api/sessions/cleanup-subagents', async (c) => {
    const deleted = await cleanupSubagentSessions(reg)
    return c.json({ deleted })
  })

  app.post('/api/sessions/:id/delete', async (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    try {
      await reg.forSession(id).deleteSession(id)
      return c.json({ ok: true })
    } catch (e) {
      log.warn(`delete session ${id} failed: ${(e as Error).message}`)
      return c.json({ ok: false, error: 'failed to delete session' }, 500)
    }
  })
}
