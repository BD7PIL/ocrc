import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'
import { listFiles } from '../../../core/list-files.js'

/**
 * Files in a session's working directory — backs the composer's @-mention picker.
 * GET /api/session/:id/files?q=<filter> → workspace-relative paths (bounded).
 */
export function registerFiles(app: Hono, reg: BackendRegistry, state: SessionState) {
  app.get('/api/session/:id/files', async (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    const q = c.req.query('q') ?? ''
    let dir: string | undefined
    try { dir = (await reg.forSession(id).getContext(id)).directory } catch { dir = undefined }
    if (!dir) return c.json([])
    return c.json(await listFiles(dir, q))
  })
}
