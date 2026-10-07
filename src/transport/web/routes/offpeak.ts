import type { Hono } from 'hono'
import type { OffPeakManager } from '../../../core/offpeak.js'
import { inWindow, type OffPeakWindow } from '../../../core/offpeak.js'

export function registerOffPeak(app: Hono, manager: OffPeakManager, window: OffPeakWindow) {
  app.get('/api/offpeak', (c) =>
    c.json({
      tasks: manager.list(),
      window,
      windowOpen: inWindow(new Date(), window),
    }))

  app.post('/api/offpeak', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      title?: string
      prompt?: string
      permissionMode?: string
      modelSelection?: { providerID?: unknown; modelID?: unknown }
      directory?: string
    }
    const text = typeof body.prompt === 'string' ? body.prompt : ''
    const title = typeof body.title === 'string' ? body.title : ''
    if (!title.trim() || !text.trim()) return c.json({ error: 'title and prompt required' }, 400)
    let modelSelection: { providerID: string; modelID: string } | undefined
    if (body.modelSelection != null) {
      const m = body.modelSelection
      if (typeof m !== 'object' || typeof m.providerID !== 'string' || typeof m.modelID !== 'string') {
        return c.json({ error: 'modelSelection must be { providerID, modelID }' }, 400)
      }
      modelSelection = { providerID: m.providerID, modelID: m.modelID }
    }
    const task = manager.add({
      title,
      prompt: text,
      permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
      modelSelection,
      directory: typeof body.directory === 'string' ? body.directory : undefined,
    })
    return c.json(task ? { task } : { error: 'invalid offpeak task' }, task ? 200 : 400)
  })

  app.patch('/api/offpeak/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { action?: string }
    const id = c.req.param('id')
    const task =
      body.action === 'pause' ? manager.pause(id)
      : body.action === 'continue' ? manager.continueTask(id)
      : body.action === 'cancel' ? manager.cancel(id)
      : undefined
    if (!task) return c.json({ error: 'not found or action invalid for state' }, body.action ? 404 : 400)
    return c.json({ task })
  })

  app.delete('/api/offpeak/:id', (c) => {
    return c.json({ ok: manager.remove(c.req.param('id')) })
  })
}
