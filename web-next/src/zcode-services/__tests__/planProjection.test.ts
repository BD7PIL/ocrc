// 计划投影契约测试（计划详情页数据面）。
// 事实基础（隔离栈实测）：opencode 的 plan agent 没有 ExitPlanMode 工具——它只用
// bash/glob/grep/question + 正文 Markdown。而 vendor 的计划面族（时间线计划卡、
// 状态面板「计划」目录、计划详情侧页）全部以 `toolName === 'ExitPlanMode'` 的行做锚点。
// 桥接把 plan 回合（meta.agent === 'plan'）的产出正文投影成该形状；外加：
//  - sendText 的 planEnabled → /api/message 带 agent:'plan'（引擎原生 plan agent）
//  - conversationPlansV4 RPC（目录数据源，rowId 降序）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

async function rowsFrom(cards: unknown[]): Promise<any[]> {
  const frames: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/session/')) return { ok: true, json: async () => ({ cards, lastSeq: cards.length, hasMore: false, busy: false }) }
    if (String(url).includes('/api/models')) return { ok: true, json: async () => [] }
    if (String(url).includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
    if (String(url).includes('/api/sessions')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  }))
  const svc = createOcrcZcodeAgentService()
  svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
  await svc.subscribeConversationV4({ sessionId: 'ses_plan', workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 50))
  const snapshot = frames.map((f) => f?.frame?.payload?.snapshot).find((s) => s && Array.isArray(s.rows?.window))
  return snapshot?.rows?.window ?? []
}

const PLAN_MD = '# 给函数加缓存\n\n1. 定位热点函数\n2. 加 LRU 包装\n3. 补测试'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

describe('计划投影：plan 回合 → ExitPlanMode 行', () => {
  it('plan agent 的 assistant 卡产出 ExitPlanMode 行，markdown 在 input.plan 与 inputText', async () => {
    const rows = await rowsFrom([
      { kind: 'user', text: '规划一下', ts: 1, messageId: 'msg_u1' },
      { kind: 'assistant', ts: 2, messageId: 'msg_a1', meta: { agent: 'plan' }, blocks: [{ type: 'text', text: PLAN_MD }] },
    ])
    const plan = rows.filter((r) => r.kind === 'toolCall' && r.toolName === 'ExitPlanMode')
    expect(plan).toHaveLength(1)
    expect(plan[0].status).toBe('success')
    expect(plan[0].toolCallId).toBe('plan-msg_a1') // 投影来源可辨认
    expect(plan[0].input).toEqual({ plan: PLAN_MD })
    expect(JSON.parse(plan[0].inputText).plan).toBe(PLAN_MD)
    // 行身份内容寻址：重建两次 rowId 不变
    const again = await rowsFrom([
      { kind: 'user', text: '规划一下', ts: 1, messageId: 'msg_u1' },
      { kind: 'assistant', ts: 2, messageId: 'msg_a1', meta: { agent: 'plan' }, blocks: [{ type: 'text', text: PLAN_MD }] },
    ])
    expect(again.find((r) => r.toolName === 'ExitPlanMode').rowId).toBe(plan[0].rowId)
  })

  it('非 plan 回合不出计划行；plan 回合无正文也不出（不伪造空计划）', async () => {
    const rows = await rowsFrom([
      { kind: 'user', text: 'a', ts: 1, messageId: 'msg_u1' },
      { kind: 'assistant', ts: 2, messageId: 'msg_a1', meta: { agent: 'build' }, blocks: [{ type: 'text', text: '普通回答' }] },
      { kind: 'user', text: 'b', ts: 3, messageId: 'msg_u2' },
      { kind: 'assistant', ts: 4, messageId: 'msg_a2', meta: { agent: 'plan' }, blocks: [] },
    ])
    expect(rows.filter((r) => r.toolName === 'ExitPlanMode')).toHaveLength(0)
  })

  it('plan 行在正文行之后（卡片读出顺序 = 先文后卡）', async () => {
    const rows = await rowsFrom([
      { kind: 'user', text: 'x', ts: 1, messageId: 'msg_u1' },
      { kind: 'assistant', ts: 2, messageId: 'msg_a1', meta: { agent: 'plan' }, blocks: [{ type: 'text', text: PLAN_MD }] },
    ])
    const ti = rows.findIndex((r) => r.kind === 'assistantText')
    const pi = rows.findIndex((r) => r.toolName === 'ExitPlanMode')
    expect(pi).toBeGreaterThan(ti)
  })
})

describe('conversationPlansV4（目录 RPC）', () => {
  it('plans = 终态 ExitPlanMode 行、rowId 降序；atLogEpoch 与快照同源', async () => {
    const svc = createOcrcZcodeAgentService()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/session/')) return { ok: true, json: async () => ({ cards: [
        { kind: 'user', text: '一', ts: 1, messageId: 'msg_u1' },
        { kind: 'assistant', ts: 2, messageId: 'msg_a1', meta: { agent: 'plan' }, blocks: [{ type: 'text', text: '# P1' }] },
        { kind: 'user', text: '二', ts: 3, messageId: 'msg_u2' },
        { kind: 'assistant', ts: 4, messageId: 'msg_a2', meta: { agent: 'plan' }, blocks: [{ type: 'text', text: '# P2' }] },
      ], lastSeq: 8, hasMore: false, busy: false }) }
      return { ok: true, json: async () => ({}) }
    }))
    const out = await (svc as any).conversationPlansV4({ sessionId: 'ses_plan' })
    expect(out.atLogEpoch).toBe('ocrc-1')
    expect(out.plans).toHaveLength(2)
    expect(out.plans[0].rowId).toBeGreaterThan(out.plans[1].rowId) // 最新优先
    expect(JSON.parse(out.plans[0].inputText).plan).toBe('# P2')
  })
})

describe('sendText 的计划模式映射', () => {
  it('planEnabled=true → /api/message 带 agent:plan', async () => {
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (String(url).endsWith('/api/message')) { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ messageId: 'm1' }) } }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcZcodeAgentService()
    await svc.sendConversationCommandV4({ envelope: { commandId: 'c1', type: 'sendText', sessionId: 'ses_x', payload: { text: 'hi', planEnabled: true } } } as any)
    expect(bodies[0]).toMatchObject({ sessionId: 'ses_x', text: 'hi', agent: 'plan' })
  })
  it('未开计划模式 → 不带 agent（不劫持 TG 的 nextAgent 槽）', async () => {
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (String(url).endsWith('/api/message')) { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ messageId: 'm1' }) } }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcZcodeAgentService()
    await svc.sendConversationCommandV4({ envelope: { commandId: 'c2', type: 'sendText', sessionId: 'ses_x', payload: { text: 'hi' } } } as any)
    expect('agent' in bodies[0]).toBe(false)
  })
})
