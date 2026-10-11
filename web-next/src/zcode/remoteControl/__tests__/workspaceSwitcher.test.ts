// W1 数据面契约：ocrc switcher 把 /api/sessions 映射成 vendor 的
// WebRemoteControlWorkspaceListResult（strict 键集、多余字段不带），四方法的
// 请求/重挂信号断言。fetch-stub 模式，参照 zcode-services/__tests__/taskGroups.test.ts。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcWorkspaceSwitcher } from '../workspaceSwitcher.js'
import type { WorkspaceSwitchRequest } from '../workspaceSwitcher.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

const ROWS = [
  // 同工作区两条：B 活动更新（300）带 error+pinned、无标题；A unread+busy
  { id: 'ses_b', title: '', lastActiveAt: 300, createdAt: 90, unread: false, directory: '/home/x/repo', error: true, pinned: true },
  { id: 'ses_a', title: 'Fix bug', lastActiveAt: 200, createdAt: 100, unread: true, directory: '/home/x/repo', busy: true },
  { id: 'ses_c', title: 'Y', lastActiveAt: 50, createdAt: 40, unread: false, directory: '/home/y/other/', archived: true },
  { id: 'ses_d', title: '无目录', lastActiveAt: 999, unread: false },
]

function stubSessions(rows: unknown[] = ROWS) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url) === '/api/sessions') return { ok: true, json: async () => rows }
    return { ok: true, json: async () => ({}) }
  }))
  return calls
}

describe('listWorkspaces', () => {
  it('按 directory 分组；workspaces/tasks strict 键集，多余字段不带', async () => {
    const calls = stubSessions()
    const sw = createOcrcWorkspaceSwitcher()
    const result = await sw.listWorkspaces()
    // 聚合层输出只含两键（不设 activeWorkspaceKey/activeTaskId——vendor 实时 props 更准）
    expect(Object.keys(result).sort()).toEqual(['tasks', 'workspaces'])
    const tasks = result.tasks ?? []
    expect(result.workspaces).toEqual([
      { workspacePath: '/home/x/repo', label: 'repo', kind: 'local' },
      { workspacePath: '/home/y/other/', label: 'other', kind: 'local' },
    ])
    expect(tasks).toHaveLength(3) // 无目录的 ses_d 被跳过
    expect(tasks.map((t) => t.taskId)).toEqual(['ses_b', 'ses_a', 'ses_c']) // updatedAt desc
    expect(Object.keys(tasks[1]).sort()).toEqual([
      'createdAt', 'displayStatus', 'taskId', 'title', 'updatedAt',
      'unreadAt', 'workspaceKind', 'workspaceLabel', 'workspacePath',
    ].sort())
    const a = tasks[1]
    expect(a).toMatchObject({
      title: 'Fix bug', workspacePath: '/home/x/repo', workspaceLabel: 'repo', workspaceKind: 'local',
      createdAt: 100, updatedAt: 200, unreadAt: 200, displayStatus: 'running',
    })
    expect(tasks[0]).toMatchObject({ title: '(未命名)', displayStatus: 'error', pinned: true })
    expect(tasks[2]).toMatchObject({ workspaceLabel: 'other', displayStatus: 'idle', archived: true })
    expect(calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  it('非 2xx 抛错（TaskHome 自己兜错误态）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const sw = createOcrcWorkspaceSwitcher()
    await expect(sw.listWorkspaces()).rejects.toThrow('任务列表加载失败 (HTTP 503)')
  })
})

describe('switchWorkspace', () => {
  it('跨工作区：先清未读，再发重挂信号（taskId+intent+nonce）', async () => {
    const calls = stubSessions()
    const requests: WorkspaceSwitchRequest[] = []
    const sw = createOcrcWorkspaceSwitcher({ onRequestSwitch: (r) => requests.push(r) })
    await sw.switchWorkspace('/w2', { taskId: 'ses_2', mobileNavigationIntent: 'chat' })
    const unreadCall = calls.find((c) => c.url === '/api/sessions/ses_2/unread')
    expect(unreadCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(unreadCall?.init?.body))).toEqual({ unread: false })
    expect(requests).toEqual([{ workspacePath: '/w2', taskId: 'ses_2', intent: 'chat', nonce: 1 }])
    await sw.switchWorkspace('/w3')
    expect(requests[1]).toEqual({ workspacePath: '/w3', nonce: 2 }) // 无 taskId/intent 时键缺席
  })

  it('同工作区纯切换短路；但带 taskId 时仍重挂（游标偏差安全侧）', async () => {
    const calls = stubSessions()
    const requests: WorkspaceSwitchRequest[] = []
    const sw = createOcrcWorkspaceSwitcher({ initialWorkspacePath: '/w1', onRequestSwitch: (r) => requests.push(r) })
    await sw.switchWorkspace('/w1')
    expect(requests).toEqual([])
    await sw.switchWorkspace('/w1', { taskId: 'ses_1' })
    expect(requests).toEqual([{ workspacePath: '/w1', taskId: 'ses_1', nonce: 1 }])
    expect(calls.some((c) => c.url === '/api/sessions/ses_1/unread')).toBe(true)
  })

  it('getActiveWorkspacePath 返回 undefined = 未知 → 一律重挂', async () => {
    stubSessions()
    const requests: WorkspaceSwitchRequest[] = []
    const sw = createOcrcWorkspaceSwitcher({ getActiveWorkspacePath: () => undefined, onRequestSwitch: (r) => requests.push(r) })
    await sw.switchWorkspace('/w1')
    expect(requests).toHaveLength(1)
  })

  it('未接线（无 onRequestSwitch）→ 报「未就绪」', async () => {
    stubSessions()
    const sw = createOcrcWorkspaceSwitcher()
    await expect(sw.switchWorkspace('/w2')).rejects.toThrow('切换入口未就绪')
  })
})

describe('startDraft', () => {
  it('POST /api/session {directory} → 重挂信号带新会话 id + 默认 intent chat', async () => {
    const calls = stubSessions()
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url) === '/api/session' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ directory: '/w2' })
        return { ok: true, json: async () => ({ id: 'ses_new', backendId: 'opencode' }) }
      }
      return { ok: true, json: async () => ({}) }
    }))
    const requests: WorkspaceSwitchRequest[] = []
    const sw = createOcrcWorkspaceSwitcher({ onRequestSwitch: (r) => requests.push(r) })
    await sw.startDraft('/w2')
    expect(requests).toEqual([{ workspacePath: '/w2', taskId: 'ses_new', intent: 'chat', nonce: 1 }])
  })

  it('创建失败/缺 id → 抛错且不发重挂信号', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const requests: WorkspaceSwitchRequest[] = []
    const sw = createOcrcWorkspaceSwitcher({ onRequestSwitch: (r) => requests.push(r) })
    await expect(sw.startDraft('/w2')).rejects.toThrow('新建对话失败 (HTTP 500)')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    await expect(sw.startDraft('/w2')).rejects.toThrow('缺少 id')
    expect(requests).toEqual([])
  })
})

describe('markTaskRead / updateMobileViewState', () => {
  it('markTaskRead POST unread:false；updateMobileViewState no-op resolve', async () => {
    const calls = stubSessions()
    const sw = createOcrcWorkspaceSwitcher()
    await sw.markTaskRead({ taskId: 'ses_9' } as Parameters<typeof sw.markTaskRead>[0])
    const call = calls.find((c) => c.url === '/api/sessions/ses_9/unread')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ unread: false })
    await expect(sw.updateMobileViewState('/w1', 'ses_1')).resolves.toBeUndefined()
  })
})
