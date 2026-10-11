import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'

export function registerCatalog(app: Hono, reg: BackendRegistry) {
  app.get('/api/agents', async (c) => {
    const b = reg.get(c.req.query('backend') ?? '') ?? reg.active()
    return c.json(await b.getAgents())
  })
  // U4: full agent-config node for the /z/ subagents panel (unfiltered).
  app.get('/api/agents-full', async (c) => {
    const b = reg.get(c.req.query('backend') ?? '') ?? reg.active()
    if (!b.getAgentsFull) return c.json({ error: 'unsupported' }, 400)
    const dir = c.req.query('dir') || undefined
    return c.json({ agents: await b.getAgentsFull(dir) })
  })
  app.get('/api/models', async (c) => {
    const b = reg.get(c.req.query('backend') ?? '') ?? reg.active()
    return c.json(await b.getModels())
  })
}
