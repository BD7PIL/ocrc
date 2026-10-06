import type { Hono } from 'hono'
import type { SessionState } from '../../../core/state.js'

export type ApprovalPolicy = 'default' | 'edit' | 'yolo'

/**
 * 0.27 权限四档 (PRODUCT.md): session-level host approval routing.
 *   default → every permission surfaces as an approval card (native behavior)
 *   edit    → edit-class permission requests auto-approve (see host.ts)
 *   yolo    → ALL permission requests auto-approve
 * plan/build remain native engine modes via /controls setMode.
 */
export function registerPolicy(app: Hono, state: SessionState) {
  app.get('/api/session/:id/policy', (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    return c.json({ policy: state.getSessionApprovalPolicy(id) ?? 'default' })
  })

  app.post('/api/session/:id/policy', async (c) => {
    const id = state.normalizeSessionId(c.req.param('id'))
    const body = await c.req.json().catch(() => ({})) as { policy?: string }
    const policy = body.policy
    if (policy !== 'default' && policy !== 'edit' && policy !== 'yolo') {
      return c.json({ error: 'policy must be default|edit|yolo' }, 400)
    }
    state.setSessionApprovalPolicy(id, policy === 'default' ? undefined : policy)
    return c.json({ ok: true, policy: state.getSessionApprovalPolicy(id) ?? 'default' })
  })
}
