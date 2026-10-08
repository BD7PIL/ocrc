// 推理行映射契约测试（N7-6）。
// 数据面：opencode 的 reasoning part → 流式卡片 blocks（live thinking）+ 定稿卡片的
// thinkingText（blocks 是 reasoning-free，TG/纯文本渲染器不该看到思考）。
// 桥接层此前只映射 blocks → 回合定稿后 /z/ 的推理块消失。这里钉住两条路径都出行。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

/** 用一个最小 session 历史驱动 buildRows（经 subscribeConversationV4 的初始快照帧）。 */
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
  await svc.subscribeConversationV4({ sessionId: 'ses_a', workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 50))
  const snapshot = frames
    .map((f) => f?.frame?.payload?.snapshot)
    .find((s) => s && Array.isArray(s.rows?.window))
  return snapshot?.rows?.window ?? []
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

describe('reasoning 行映射', () => {
  it('定稿卡片的 thinkingText → reasoning 行（此前会丢）', async () => {
    const rows = await rowsFrom([
      { kind: 'user', text: '问题', ts: 1 },
      { kind: 'assistant', ts: 2, thinkingText: '先看 A，再看 B', blocks: [{ type: 'text', text: '答案' }] },
    ])
    const reasoning = rows.filter((r) => r.kind === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0].text).toBe('先看 A，再看 B')
    expect(reasoning[0].state).toBe('complete')
    // 顺序：推理在正文之前（与流式期一致）
    const kinds = rows.map((r) => r.kind)
    expect(kinds.indexOf('reasoning')).toBeLessThan(kinds.indexOf('assistantText'))
  })

  it('流式卡片自带的 reasoning 块仍然出行，且不与 thinkingText 重复', async () => {
    const rows = await rowsFrom([
      { kind: 'user', text: '问题', ts: 1 },
      { kind: 'assistant', ts: 2, thinkingText: '同样的思考', blocks: [{ type: 'reasoning', text: '同样的思考' }, { type: 'text', text: '答案' }] },
    ])
    expect(rows.filter((r) => r.kind === 'reasoning')).toHaveLength(1)
  })

  it('没有思考的回合不产生空 reasoning 行', async () => {
    const rows = await rowsFrom([
      { kind: 'user', text: '问题', ts: 1 },
      { kind: 'assistant', ts: 2, blocks: [{ type: 'text', text: '答案' }] },
    ])
    expect(rows.filter((r) => r.kind === 'reasoning')).toHaveLength(0)
  })
})
