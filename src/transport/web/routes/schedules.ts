import type { Hono } from 'hono'
import type { Scheduler, ScheduleInput } from '../../../core/scheduler.js'

/** P2b-M7: cross-channel scheduled tasks — web front-end (CRUD). */
export function registerSchedules(app: Hono, scheduler?: Scheduler) {
  if (!scheduler) return

  app.get('/api/schedules', (c) => c.json({ schedules: scheduler.list() }))

  app.post('/api/schedules', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<ScheduleInput> & { spec?: unknown }
    const s = scheduler.add({
      name: typeof body.name === 'string' ? body.name : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      spec: body.spec as ScheduleInput['spec'],
      enabled: body.enabled ?? true,
    })
    return c.json(s ? { schedule: s } : { error: 'invalid schedule' }, s ? 200 : 400)
  })

  app.patch('/api/schedules/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean }
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled required' }, 400)
    const s = scheduler.setEnabled(id, body.enabled)
    return c.json(s ? { schedule: s } : { error: 'not found' }, s ? 200 : 404)
  })

  app.delete('/api/schedules/:id', (c) => {
    return c.json({ ok: scheduler.remove(c.req.param('id')) })
  })

  /** Fire one schedule immediately (paused schedules refuse). */
  app.post('/api/schedules/:id/run', (c) => {
    const ok = scheduler.runNow(c.req.param('id'))
    return c.json(ok ? { ok: true } : { error: 'not found or paused' }, ok ? 200 : 404)
  })
}
