import type { Hono } from 'hono'
import type { SessionState } from '../../../core/state.js'

export function registerOverrides(app: Hono, state: SessionState) {
  app.get('/api/overrides', (c) =>
    c.json({ agent: state.getNextAgent() ?? null, model: state.getNextModel() ?? null, variant: state.getNextVariant() ?? null }))

  app.post('/api/overrides', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      agent?: string | null
      model?: { providerID: string; modelID: string } | null
      variant?: string | null
    }
    if ('model' in body) {
      // Validate before persisting — a malformed model would be written to disk
      // and silently break the next session's model selection.
      const m = body.model
      if (m != null && (typeof m !== 'object' || typeof m.providerID !== 'string' || typeof m.modelID !== 'string')) {
        return c.json({ error: 'model must be { providerID: string, modelID: string } or null' }, 400)
      }
    }
    if ('agent' in body) state.setNextAgent(body.agent ?? undefined)
    if ('model' in body) state.setNextModel(body.model ?? undefined)
    if ('variant' in body) state.setNextVariant(body.variant ?? undefined)
    return c.json({ ok: true })
  })
}
