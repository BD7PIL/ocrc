// 分享服务契约测试（N7-2）。钉住：发布走 POST /api/share、record 形状符合
// ConversationShareRecord、selection/accessMode 的 ocrc 语义（整份转录/只读链接）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcShareService } from '../shareService.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

const INPUT = {
  workspacePath: '/w', sessionId: 'ses_a', title: '我的分享',
  accessMode: 'private' as const,
  selection: { kind: 'productTurns' as const, productTurnIds: [] },
  clientRequestId: 'req-1', disclosureAcceptedAt: 1,
}

describe('publish', () => {
  it('发布走 POST /api/share，record 是 ZCode 的四元组', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: true, json: async () => ({ code: 'abc123', url: '/share/abc123', count: 7 }) }
    }))
    const record = await createOcrcShareService().publish(INPUT, 'op-1')
    expect(calls[0].url).toContain('/api/share')
    expect(calls[0].body).toEqual({ sessionId: 'ses_a', title: '我的分享' })
    expect(record).toMatchObject({ share_code: 'abc123', share_url: '/share/abc123', access_mode: 'public_readonly' })
    expect(record.expires_at).toBeGreaterThan(4_000_000_000_000) // 远期 = 不自动失效
  })

  it('selection 被 ocrc 语义有意忽略（整份转录）', async () => {
    const calls: Array<{ body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: true, json: async () => ({ code: 'x', url: '/share/x' }) }
    }))
    await createOcrcShareService().publish(INPUT, 'op-2')
    expect(calls[0].body).not.toHaveProperty('selection')
    expect(calls[0].body).not.toHaveProperty('accessMode')
  })

  it('失败如实抛出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: '快照为空' }) })))
    await expect(createOcrcShareService().publish(INPUT, 'op-3')).rejects.toThrow(/快照为空/)
  })
})

describe('capabilities / preflight', () => {
  it('能力发现声明只读链接 + 无结果物，preflight 无阻断', async () => {
    const svc = createOcrcShareService()
    const caps = await svc.getCapabilities()
    expect(caps.access_modes).toEqual(['public_readonly'])
    expect(caps.allowed_artifacts).toEqual([])
    expect(caps.schema_version).toBe(1)
    const pre = await svc.preflight({ sessionId: 'ses_a', selection: INPUT.selection })
    expect(pre.blockingIssues).toEqual([])
  })

  it('preflight 按真实历史产出可选轮次（id 与行映射的 turn-N 对齐）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ cards: [{ kind: 'user' }, { kind: 'assistant' }, { kind: 'user' }, { kind: 'assistant' }, { kind: 'user' }] }),
    })))
    const pre = await createOcrcShareService().preflight({ sessionId: 'ses_a', selection: INPUT.selection })
    expect(pre.turnResults.map((t: any) => t.productTurnId)).toEqual(['turn-1', 'turn-2', 'turn-3'])
  })
})

describe('事件工厂形状（真实缺陷回归）', () => {
  it('onDynamicPublishProgress(operationId) 返回 Event，而不是 disposable', async () => {
    // 隔离栈实测：实现成「直接收 listener」时，UI 侧
    // `svc.onDynamicPublishProgress(op)(cb)` 会抛 `... is not a function`，
    // 发布整条链在此断掉。这里钉住工厂形状。
    const svc = createOcrcShareService()
    const event = svc.onDynamicPublishProgress('op-1')
    expect(typeof event).toBe('function')
    const seen: unknown[] = []
    const dispose = event((p: unknown) => seen.push(p))
    expect(typeof dispose.dispose).toBe('function')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 'c', url: '/share/c' }) })))
    await svc.publish(INPUT, 'op-1')
    expect(seen.length).toBeGreaterThan(0)
    dispose.dispose()
  })
})
