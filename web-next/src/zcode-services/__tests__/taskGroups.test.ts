// N10 任务组桥接契约：listGroupedTaskViewStructure 回真结构（strict 键集）；
// applyGroupedTaskViewOrder 把 vendor 的最终排序落成 order 动作。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcTaskService } from '../zcodeTaskService.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

describe('N10 listGroupedTaskViewStructure', () => {
  it('回读 groups/members/topLevelOrders，member 键集 strict（groupId/workspaceKey/workspacePath/taskId/sortOrder/addedAt）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url) === '/api/task-groups') {
        return { ok: true, json: async () => ({
          groups: [{ id: 'tg_1', title: '性能', color: 'blue', createdAt: 1, updatedAt: 2 }],
          members: [{ groupId: 'tg_1', workspaceKey: '/w1', taskId: 'ses_9', sortOrder: 0, addedAt: 5 }],
          topLevelOrders: [{ type: 'group', groupId: 'tg_1', sortOrder: 0 }],
        }) }
      }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcTaskService()
    const structure = await (svc as any).listGroupedTaskViewStructure({ workspaceScopes: [] })
    expect(structure.groups).toEqual([{ id: 'tg_1', title: '性能', color: 'blue', createdAt: 1, updatedAt: 2 }])
    expect(Object.keys(structure.members[0]).sort()).toEqual(['addedAt', 'groupId', 'sortOrder', 'taskId', 'workspaceIdentity', 'workspaceKey', 'workspacePath'].sort())
    expect(structure.members[0].workspacePath).toBe('')
    expect(structure.topLevelOrders).toHaveLength(1)
  })
  it('路由失败退空结构（不炸侧栏）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const svc = createOcrcTaskService()
    const structure = await (svc as any).listGroupedTaskViewStructure({ workspaceScopes: [] })
    expect(structure.groups).toEqual([])
    expect(structure.members).toEqual([])
  })
})

describe('N10 applyGroupedTaskViewOrder', () => {
  it('把 topLevelNodes+groups 落成 order 动作（workspaceKey=identity??path）', async () => {
    const posts: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (String(url) === '/api/task-groups' && init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(init.body) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcTaskService()
    await (svc as any).applyGroupedTaskViewOrder({
      workspaceScopes: [],
      topLevelNodes: [
        { type: 'group', groupId: 'tg_1' },
        { type: 'task', task: { workspacePath: '/w2', workspaceIdentity: 'ident-2', taskId: 'ses_3' } },
      ],
      groups: [
        { groupId: 'tg_1', taskRefs: [{ workspacePath: '/w1', taskId: 'ses_1' }, { workspacePath: '/w1', taskId: 'ses_2' }] },
      ],
    })
    expect(posts).toHaveLength(1)
    expect(posts[0].body.action).toBe('order')
    expect(posts[0].body.topOrders).toEqual([
      { type: 'group', groupId: 'tg_1', sortOrder: 0 },
      { type: 'task', workspaceKey: 'ident-2', taskId: 'ses_3', sortOrder: 1 },
    ])
    expect(posts[0].body.members).toEqual([
      { groupId: 'tg_1', workspaceKey: '/w1', workspacePath: '/w1', workspaceIdentity: undefined, taskId: 'ses_1', sortOrder: 0, addedAt: expect.any(Number) },
      { groupId: 'tg_1', workspaceKey: '/w1', workspacePath: '/w1', workspaceIdentity: undefined, taskId: 'ses_2', sortOrder: 1, addedAt: expect.any(Number) },
    ])
  })
})
