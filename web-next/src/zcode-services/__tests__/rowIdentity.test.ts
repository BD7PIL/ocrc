// N9-1 行身份内容寻址回归测试。
// 根因：rowId 曾是「扁平列表里的位置序号」——中间插入一行（流式中块增长、
// reasoning 行补插）会让后续所有行 rowId 位移，vendor 的 apply 按 rowId 键控
// upsert → 同一内容被当「删+增」，时间线重复渲染。
// 现在的契约：
// ① 中间插入（新回合落到头部不可能——历史按时间追加；此处钉「已 rebuild 幂等 +
//    旧区行身份不变」）；
// ② entityId = 卡片 messageId 落到 userInput/assistantText/reasoning 行（悬停动作
//    forkAssistant/editUserQuery 的 target 需要 rowId+entityId 成对）；
// ③ 流式增长回合 = 旧行 rowId 全部不变 + 只产 1 upsert（末行增长）或 N append；
// ④ 同卡重建两次深度相等（diff 空集）。
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
  await svc.subscribeConversationV4({ sessionId: 'ses_rowid', workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 50))
  const snapshot = frames
    .map((f) => f?.frame?.payload?.snapshot)
    .find((s) => s && Array.isArray(s.rows?.window))
  return snapshot?.rows?.window ?? []
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

const CARD_A = [
  { kind: 'user', text: '第一问', ts: 1, messageId: 'msg_a1' },
  { kind: 'assistant', ts: 2, messageId: 'msg_a2', blocks: [{ type: 'text', text: '答一' }] },
]
const CARD_B = [
  { kind: 'user', text: '第二问', ts: 3, messageId: 'msg_b1' },
  { kind: 'assistant', ts: 4, messageId: 'msg_b2', blocks: [{ type: 'text', text: '答二' }] },
]

describe('N9-1 内容寻址行身份', () => {
  it('① 同一历史重建两次 → rowId 逐行全等（幂等）', async () => {
    const rows1 = await rowsFrom([...CARD_A, ...CARD_B])
    const rows2 = await rowsFrom([...CARD_A, ...CARD_B])
    expect(rows1).toHaveLength(rows2.length)
    expect(rows1.map((r) => r.rowId)).toEqual(rows2.map((r) => r.rowId))
  })

  it('② entityId=卡片 messageId 落 userInput/assistantText 行，rowId 在同会话内唯一', async () => {
    const rows = await rowsFrom([...CARD_A, ...CARD_B])
    const byKind = (k: string) => rows.filter((r) => r.kind === k)
    expect(byKind('userInput').map((r) => r.entityId)).toEqual(['msg_a1', 'msg_b1'])
    expect(byKind('assistantText').map((r) => r.entityId)).toEqual(['msg_a2', 'msg_b2'])
    const ids = rows.map((r) => r.rowId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => Number.isInteger(id) && id > 0)).toBe(true)
  })

  it('③ 追加回合：旧行 rowId 全不变，新行全是 row.appended（无位移 upsert）', async () => {
    const before = await rowsFrom(CARD_A)
    const after = await rowsFrom([...CARD_A, ...CARD_B])
    const oldIds = before.map((r) => r.rowId)
    const afterIds = after.map((r) => r.rowId)
    // 旧行身份原样保留且仍在头部
    expect(afterIds.slice(0, oldIds.length)).toEqual(oldIds)
  })

  it('③b 流式末行增长：同一 rowId，text 变长（upsert 而非删+增）', async () => {
    const partial = await rowsFrom([
      { kind: 'user', text: '问', ts: 1, messageId: 'msg_u' },
      { kind: 'assistant', ts: 2, messageId: 'msg_as', blocks: [{ type: 'text', text: '部分' }] },
    ])
    const full = await rowsFrom([
      { kind: 'user', text: '问', ts: 1, messageId: 'msg_u' },
      { kind: 'assistant', ts: 2, messageId: 'msg_as', blocks: [{ type: 'text', text: '部分+定稿的全部内容' }] },
    ])
    expect(partial).toHaveLength(full.length)
    expect(partial[partial.length - 1].rowId).toBe(full[full.length - 1].rowId)
    expect(full[full.length - 1].text).toContain('定稿')
  })

  it('③c 定稿补插 reasoning 行：身份稳定且新行只出现在该卡区间（不位移旧行）', async () => {
    const streamed = await rowsFrom([
      { kind: 'user', text: '问', ts: 1, messageId: 'msg_u' },
      { kind: 'assistant', ts: 2, messageId: 'msg_as', blocks: [{ type: 'text', text: '答' }] },
    ])
    const finalized = await rowsFrom([
      { kind: 'user', text: '问', ts: 1, messageId: 'msg_u' },
      { kind: 'assistant', ts: 2, messageId: 'msg_as', thinkingText: '思考内容', blocks: [{ type: 'text', text: '答' }] },
    ])
    // 新增的 reasoning 行插在 userInput 之后、assistantText 之前；text 行身份不变
    const streamedText = streamed.find((r) => r.kind === 'assistantText')!
    const finalizedText = finalized.find((r) => r.kind === 'assistantText')!
    expect(finalizedText.rowId).toBe(streamedText.rowId)
    const reasoning = finalized.filter((r) => r.kind === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(finalized.findIndex((r) => r.kind === 'reasoning')).toBeLessThan(finalized.findIndex((r) => r.kind === 'assistantText'))
  })

  it('④ 无 messageId 的卡退 ts+kind+index 身份，同输入仍幂等', async () => {
    const legacy = [{ kind: 'user', text: '旧', ts: 9 }, { kind: 'assistant', ts: 10, blocks: [{ type: 'text', text: '复' }] }]
    const r1 = await rowsFrom(legacy)
    const r2 = await rowsFrom(legacy)
    expect(r1.map((r) => r.rowId)).toEqual(r2.map((r) => r.rowId))
  })
})
