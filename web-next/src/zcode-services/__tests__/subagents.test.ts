// 子代理目录契约测试（N8-2）。此前 listSessionSubagents 整体缺失 → Proxy 兜底
// reject → 目录页 ended 段显示「无法加载子智能体目录」。钉住：请求参数、vendor
// strict schema 的键集合（多一个键 zod 就会整份拒绝）、running/ended 判定与
// success/failed 的如实映射。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

function stubSubs(subs: unknown[]): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ subagents: subs }) }
  }))
  return calls
}

const ALLOWED_KEYS = new Set([
  'childSessionId', 'agentId', 'toolCallId', 'subagentType', 'title',
  'summary', 'startedAt', 'endedAt', 'status',
])

describe('listSessionSubagents', () => {
  it('running/ended 分栏 + status 如实映射 + 只回 schema 声明的键', async () => {
    const calls = stubSubs([
      { id: 'ses_run', title: '跑着', busy: true, agent: 'build', done: 1, total: 3, createdAt: 100, updatedAt: 200 },
      { id: 'ses_ok', title: '完成', agent: 'build', done: 2, total: 2, createdAt: 10, updatedAt: 20 },
      { id: 'ses_bad', title: '失败', error: true, createdAt: 5, updatedAt: 6 },
    ])
    const out = await createOcrcZcodeAgentService().listSessionSubagents({ sessionId: 'ses_p', endedLimit: 20 })
    expect(calls[0]).toContain('/api/session/ses_p/subagents')
    expect(out.childSessionIds).toEqual(['ses_run', 'ses_ok', 'ses_bad'])
    expect(out.running.map((r: any) => r.childSessionId)).toEqual(['ses_run'])
    expect(out.running[0].status).toBe('running')
    expect(out.running[0].subagentType).toBe('build')
    expect(out.running[0].summary).toBe('1/3')
    expect(out.ended.total).toBe(2)
    expect(out.ended.items.map((i: any) => [i.childSessionId, i.status])).toEqual([['ses_ok', 'success'], ['ses_bad', 'failed']])
    // 无 agent 的子会话回退 'task'，且不发明 success 之外的字段
    expect(out.ended.items[1].subagentType).toBe('task')
    expect(out.ended.items[1].startedAt).toBe(5)
    expect(out.ended.items[1].endedAt).toBe(6)
    for (const item of [...out.running, ...out.ended.items]) {
      for (const key of Object.keys(item)) expect(ALLOWED_KEYS.has(key)).toBe(true)
    }
    // 单页语义：total 是真实总数，不发明游标
    expect(out.ended.nextCursor).toBeUndefined()
  })

  it('小页带 todo 换 summary，大页跳过（todos=0）避免一串引擎读', async () => {
    const calls = stubSubs([])
    const svc = createOcrcZcodeAgentService()
    await svc.listSessionSubagents({ sessionId: 'ses_p', endedLimit: 20 })
    await svc.listSessionSubagents({ sessionId: 'ses_p', endedLimit: 50 })
    expect(calls[0]).toContain('todos=1')
    expect(calls[1]).toContain('todos=0')
    expect(calls[1]).toContain('limit=50')
  })

  it('缺 sessionId → 空结果；HTTP 失败如实抛出', async () => {
    const svc = createOcrcZcodeAgentService()
    const empty = await svc.listSessionSubagents({})
    expect(empty.ended).toEqual({ total: 0, items: [] })
    expect(empty.running).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })))
    await expect(svc.listSessionSubagents({ sessionId: 'ses_p' })).rejects.toThrow(/502/)
  })
})
