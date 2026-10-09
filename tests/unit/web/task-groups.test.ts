import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createFileBackedState } from '../../../src/core/state'
import { registerTaskGroups } from '../../../src/transport/web/routes/task-groups'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeApp() {
  const state = createFileBackedState(join(mkdtempSync(join(tmpdir(), 'tg-')), 'state.json'))
  const app = new Hono()
  registerTaskGroups(app, state)
  return { app, state }
}

describe('POST /api/task-groups (N10)', () => {
  it('create → rename → color → read back', async () => {
    const { app } = makeApp()
    const created = (await (await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', title: '性能', color: 'blue' }),
    })).json()).group
    expect(created.title).toBe('性能')
    expect(created.color).toBe('blue')
    expect(created.id).toMatch(/^tg_/)

    const renamed = (await (await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', groupId: created.id, title: '性能整改' }),
    })).json()).group
    expect(renamed.title).toBe('性能整改')

    const recolored = (await (await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'color', groupId: created.id, color: 'red' }),
    })).json()).group
    expect(recolored.color).toBe('red')

    const read = (await (await app.request('/api/task-groups')).json())
    expect(read.groups).toHaveLength(1)
    expect(read.groups[0]).toMatchObject({ id: created.id, title: '性能整改', color: 'red' })
  })
  it('order persists membership + topOrders; delete removes group and members', async () => {
    const { app } = makeApp()
    const g1 = (await (await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', title: 'A' }),
    })).json()).group
    const g2 = (await (await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', title: 'B' }),
    })).json()).group
    const orderRes = await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'order',
        members: [
          { groupId: g1.id, workspaceKey: '/w1', taskId: 'ses_1', sortOrder: 0, addedAt: 1 },
          { groupId: g1.id, workspaceKey: '/w1', taskId: 'ses_2', sortOrder: 1, addedAt: 2 },
        ],
        topOrders: [
          { type: 'group', groupId: g1.id, sortOrder: 0 },
          { type: 'task', workspaceKey: '/w1', taskId: 'ses_9', sortOrder: 1 },
          { type: 'group', groupId: g2.id, sortOrder: 2 },
        ],
      }),
    })
    expect(orderRes.status).toBe(200)
    const read = (await (await app.request('/api/task-groups')).json())
    expect(read.members).toHaveLength(2)
    expect(read.members[0]).toMatchObject({ groupId: g1.id, taskId: 'ses_1', sortOrder: 0 })
    expect(read.topLevelOrders).toHaveLength(3)

    expect((await app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', groupId: g1.id }),
    })).status).toBe(200)
    const after = (await (await app.request('/api/task-groups')).json())
    expect(after.groups.map((g: any) => g.id)).toEqual([g2.id])
    expect(after.members).toHaveLength(0) // cascade
    expect(after.topLevelOrders.map((o: any) => o.groupId ?? o.taskId)).not.toContain(g1.id)
  })
  it('fail-fast: bad color 400, bad member shape 400, unknown action 400, missing group 404', async () => {
    const { app } = makeApp()
    const post = (body: unknown) => app.request('/api/task-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await post({ action: 'color', groupId: 'tg_x', color: 'neon' })).status).toBe(400)
    expect((await post({ action: 'order', members: [{ groupId: 1 }], topOrders: [] })).status).toBe(400)
    expect((await post({ action: 'wat' })).status).toBe(400)
    expect((await post({ action: 'rename', groupId: 'tg_missing', title: 'x' })).status).toBe(404)
  })
})
