import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'

/**
 * M8: skills / files / worktree sandboxes — thin proxies over the active
 * backend. `directory` defaults to the active workspace when the client
 * doesn't pin one.
 */
export function registerM8(app: Hono, reg: BackendRegistry, state: SessionState) {
  // Hono's Context.query has overloads that fight structural typing — any here.
  const dir = (c: any): string => {
    const q = String(c.query('directory') ?? '')
    if (q) return q
    const active = state.getActiveWorkspace()
    return active ?? ''
  }

  app.get('/api/skills', async (c) => {
    const b = reg.active()
    if (!b.getSkills) return c.json({ skills: [] })
    const d = dir(c)
    return c.json({ skills: await b.getSkills(d || undefined) })
  })

  app.get('/api/browse', async (c) => {
    const b = reg.active()
    if (!b.listFiles) return c.json({ files: [] })
    const d = dir(c)
    return c.json({ files: await b.listFiles(d || undefined, c.req.query('path') ?? '.') })
  })

  app.get('/api/file-content', async (c) => {
    const b = reg.active()
    if (!b.readFile) return c.json({ error: 'unsupported' }, 400)
    try {
      const d = dir(c)
      return c.json(await b.readFile(d || undefined, c.req.query('path') ?? '.'))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  app.get('/api/worktrees', async (c) => {
    const b = reg.active()
    if (!b.listWorktreeSandboxes) return c.json({ worktrees: [] })
    const d = dir(c)
    return c.json({ worktrees: await b.listWorktreeSandboxes(d || undefined) })
  })

  app.post('/api/worktrees', async (c) => {
    const b = reg.active()
    if (!b.createWorktreeSandboxes) return c.json({ error: 'unsupported' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: 'name required' }, 400)
    const d = dir(c)
    const created = await b.createWorktreeSandboxes(d || undefined, name)
    return c.json(created ? { worktree: created } : { error: 'create failed' }, created ? 200 : 500)
  })

  app.delete('/api/worktrees', async (c) => {
    const b = reg.active()
    const name = c.req.query('name') ?? ''
    if (!b.removeWorktreeSandboxes || !name) return c.json({ ok: false }, 400)
    const d = dir(c)
    return c.json({ ok: await b.removeWorktreeSandboxes(d || undefined, name) })
  })
}
