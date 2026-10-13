// B7 live 增量取数回归测试（2026-10-13，缺口收口计划 A）。
// 契约：
// ① live 每 tick 只取**尾部小页**（`?limit=20`）与窗口合并，不再取最新 200 消息页；
// ② 每 HISTORY_FULL_EVERY_TICKS（10）个 tick 兜一次全量页（更早卡状态后到的收敛）；
// ③ 尾部小页合并**不动** hasOlderOnLoad/exhausted（小页满不满与「更早是否存在」无关）
//    ——否则小页恒「满」会把「加载更早」判成永远有货；
// ④ 小页合并后既有行 rowId 逐行不变（内容身份，追加不位移）；
// ⑤ 锚点不可定位（会话被重置/身份缺失）时回落全量页，不静默丢帧。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

type Card = Record<string, unknown>

const userCard = (i: number): Card => ({ kind: 'user', text: `问${i}`, ts: i * 10, messageId: `msg_u${i}` })
const asstCard = (i: number): Card => ({
  kind: 'assistant', ts: i * 10 + 1, messageId: `msg_a${i}`, blocks: [{ type: 'text', text: `答${i}` }],
})
/** n 组 user+assistant 对（2n 卡 / 3n 行）。 */
const history = (n: number, from = 0): Card[] =>
  Array.from({ length: n }, (_, k) => [userCard(from + k), asstCard(from + k)]).flat()

/** 假 WebSocket：只用于把 live 帧喂进 onmessage（不真连）。 */
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  static instances: FakeWS[] = []
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeWS.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3 }
}

/** 服务端历史（可被测试改写）+ 取数记账。窗口语义 `[len-limit-offset, len-offset)`。
 *  只认**历史端点** `/api/session/:id`（后接 `?` 或结束）——`/todo`、`/subagents`、
 *  `/goal` 等子资源不是历史取数，不能计入。 */
const HISTORY_URL = /\/api\/session\/[^/?]+(\?|$)/
function stubHistory(state: { cards: Card[] }) {
  const calls: Array<{ offset: number; limit: number }> = []
  const fetchStub = vi.fn(async (url: string) => {
    const u = String(url)
    if (HISTORY_URL.test(u)) {
      const om = /[?&]offset=(\d+)/.exec(u)
      const lm = /[?&]limit=(\d+)/.exec(u)
      const offset = om ? Number(om[1]) : 0
      const limit = lm ? Number(lm[1]) : 200
      calls.push({ offset, limit })
      const end = Math.max(0, state.cards.length - offset)
      const start = Math.max(0, state.cards.length - limit - offset)
      const cards = state.cards.slice(start, end)
      return { ok: true, json: async () => ({ cards, lastSeq: 0, hasMore: cards.length >= limit, busy: false }) }
    }
    if (u.includes('/api/models')) return { ok: true, json: async () => [] }
    if (u.includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
    if (u.includes('/api/sessions')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  })
  return { fetchStub, calls, fulls: () => calls.filter((c) => c.limit === 200), tails: () => calls.filter((c) => c.limit === 20) }
}

async function subscribe(sessionId: string) {
  const frames: any[] = []
  const svc = createOcrcZcodeAgentService()
  svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
  await svc.subscribeConversationV4({ sessionId, workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 60))
  return { svc, frames }
}

/** 喂一帧 live 消息并等 250ms 去抖 + 取数落定。 */
async function tick(sessionId: string, type = 'card') {
  const ws = FakeWS.instances[FakeWS.instances.length - 1]
  ws?.onmessage?.({ data: JSON.stringify({ type, sessionId }) })
  await new Promise((r) => setTimeout(r, 320))
}

beforeEach(() => {
  try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom */ }
  // liveWs 是模块级单例（跨用例存活）：先把它置为 CLOSED，逼 liveWsEnsure 新建实例，
  // 否则后续用例 tick 时拿到的还是上一个用例的 ws。
  for (const w of FakeWS.instances) w.readyState = FakeWS.CLOSED
  FakeWS.instances = []
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)
})
afterEach(() => vi.unstubAllGlobals())

describe('B7 live 尾部小页取数', () => {
  it('① 首个快照取全量页；此后每 tick 只取尾部小页（?limit=20）', async () => {
    const state = { cards: history(100) } // 200 卡 / 300 行
    const { fetchStub, fulls, tails } = stubHistory(state)
    vi.stubGlobal('fetch', fetchStub)
    const { svc } = await subscribe('ses_tail_counts')
    expect(fulls().length, '订阅期全量页次数').toBe(1)
    for (let i = 0; i < 3; i++) await tick('ses_tail_counts')
    expect(tails().length, '3 个 tick 的尾部小页次数').toBe(3)
    expect(fulls().length, '3 个 tick 内不该再取全量页').toBe(1)
    // 小页确实只有 20 条消息
    expect(tails().every((c) => c.limit === 20 && c.offset === 0)).toBe(true)
    void svc
  })

  it('② 每 10 个 tick 兜一次全量页（第 10 个 tick 起）', async () => {
    const state = { cards: history(100) }
    const { fetchStub, fulls, tails } = stubHistory(state)
    vi.stubGlobal('fetch', fetchStub)
    await subscribe('ses_tail_periodic')
    for (let i = 0; i < 12; i++) await tick('ses_tail_periodic')
    expect(tails().length, '12 tick 里的尾部小页').toBe(11)
    expect(fulls().length, '订阅 1 次 + 第 10 tick 兜底 1 次').toBe(2)
  })

  it('③ 尾部小页合并后既有行 rowId 逐行不变，新卡追加在后', async () => {
    const state = { cards: history(100) }
    const { fetchStub } = stubHistory(state)
    vi.stubGlobal('fetch', fetchStub)
    const { svc } = await subscribe('ses_tail_stable')
    const before = await svc.conversationRowsRangeV4({ sessionId: 'ses_tail_stable', limit: 60 })
    // 只对有正文的行做内容键（turnHeader 无 text，位置键会互相撞车）。
    const key = (r: any): string | undefined => (r.text ? `${r.kind}|${r.text}` : undefined)
    const idByKey = new Map<string, number>()
    for (const r of before.rows) { const k = key(r); if (k) idByKey.set(k, r.rowId) }
    expect(idByKey.size).toBeGreaterThan(10)

    // 追加一个新回合（user+assistant），再 tick
    state.cards = [...state.cards, userCard(100), asstCard(100)]
    await tick('ses_tail_stable')

    const after = await svc.conversationRowsRangeV4({ sessionId: 'ses_tail_stable', limit: 60 })
    // 旧行 id 全等（窗口合并没有重发号）
    let checked = 0
    for (const r of after.rows) {
      const k = key(r)
      const prev = k ? idByKey.get(k) : undefined
      if (prev !== undefined) { expect(r.rowId, `「${k}」的 rowId`).toBe(prev); checked += 1 }
    }
    expect(checked, '比对上的旧行数').toBeGreaterThan(10)
    // 新卡的行确实进了窗口
    expect(after.rows.some((r: any) => String(r.text ?? '').includes('问100'))).toBe(true)
    expect(after.atSeq).toBe(303) // 300 + 新回合 3 行（turnHeader/userInput/assistantText）
  })

  it('④ 尾部小页不动 hasOlderOnLoad：历史不足一页时不会误判「还有更早」', async () => {
    const state = { cards: history(20) } // 40 卡 < 200 → 全量页 hasMore=false
    const { fetchStub, tails } = stubHistory(state)
    vi.stubGlobal('fetch', fetchStub)
    const { svc } = await subscribe('ses_tail_hasmore')
    for (let i = 0; i < 3; i++) await tick('ses_tail_hasmore')
    expect(tails().length).toBe(3)
    // 小页自身是「满页」（20/20，服务端 hasMore=true）——若被写进窗口，
    // rowsRange 的 hasMore 会恒 true（「加载更早」永远有货）。
    const out = await svc.conversationRowsRangeV4({ sessionId: 'ses_tail_hasmore', limit: 60 })
    expect(out.hasMore).toBe(false)
  })

  it('⑤ 锚点不可定位时回落全量页（不静默丢帧）', async () => {
    const state = { cards: history(100) }
    const { fetchStub, fulls, tails } = stubHistory(state)
    vi.stubGlobal('fetch', fetchStub)
    await subscribe('ses_tail_anchor')
    // 会话被重置：尾部页全是新身份，锚点在 recent 里找不到
    state.cards = history(30, 5000)
    await tick('ses_tail_anchor')
    expect(tails().length, '先试了小页').toBe(1)
    expect(fulls().length, '锚点失败后回落全量').toBe(2)
  })
})
