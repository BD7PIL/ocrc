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
    const backend = reg.forSession(id)
    try {
      // 引擎对不存在的 id 也回成功（实测），于是客户端拿到 {ok:true} 却什么都没删——
      // 这类静默成功会掩盖客户端 bug。先如实判存在性。
      if (!(await backend.hasSession(id))) {
        return c.json({ ok: false, error: 'session not found' }, 404)
      }
      await backend.deleteSession(id)
      return c.json({ ok: true })
    } catch (e) {
      log.warn(`delete session ${id} failed: ${(e as Error).message}`)
      return c.json({ ok: false, error: 'failed to delete session' }, 500)
    }
  })

  /** /z/ sidebar bookmark. Distinct from the relay's routing pin. */
  app.post('/api/sessions/:id/pin', async (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    const body = await c.req.json().catch(() => ({})) as { pinned?: boolean }
    if (typeof body.pinned !== 'boolean') return c.json({ error: 'pinned required' }, 400)
    state.setTaskPinned(id, body.pinned)
    return c.json({ ok: true, pinned: state.isTaskPinned(id), pinnedTaskIds: state.listPinnedTaskIds() })
  })

  /** /z/ sidebar unread dot (backends hardcode unread:false, so this is it). */
  app.post('/api/sessions/:id/unread', async (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    const body = await c.req.json().catch(() => ({})) as { unread?: boolean }
    if (typeof body.unread !== 'boolean') return c.json({ error: 'unread required' }, 400)
    state.setSessionUnread(id, body.unread)
    return c.json({ ok: true, unread: state.isSessionUnread(id) })
  })
}
