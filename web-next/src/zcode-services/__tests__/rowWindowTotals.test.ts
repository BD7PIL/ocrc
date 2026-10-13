// D · 1000 行档「1 行差」定位（2026-10-13，缺口收口计划）。
// 实测：1000 行档翻到底，DOM 收敛 899 行 / 桥接窗口 900（500 档精确）。
//
// 根因（已定位到**我方**代码，非 vendor）：更早页前插时 id 由「逆序干跑」发放，
// 只逆到**卡**级——卡内 buildRows 先推 turnHeader 再推 userInput，而向下号段是
// **递减**的，于是同卡内 header 的 id 比 input 大，页内行序不单调。
// vendor `mergeOlderRows`（conversationProjectionStore.ts:258-266）按
// `rowId < window[0].rowId` 过滤；当游标（窗口首行）落在 userInput 行上时，
// 它前面那张 turnHeader 的 id 更大 → 被过滤掉 → **恰好丢 1 行**。
//
// 本用例用「与 vendor 同构的 drain」（带该过滤）复现：行数非 3 的倍数（尾部窗口
// 首行落在 input 行）时丢 1 行；3 的倍数时精确（游标落在 header，无事）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

type Card = Record<string, unknown>

const userCard = (i: number, tag: string): Card => ({
  kind: 'user', text: `${tag}问${i}`, ts: i * 10, messageId: `msg_${tag}_u${i}`,
})

/** assistant 带 1 个 tool 块（真实 1000 档是工具密集会话；partId 走 tool 身份路径）。 */
const toolCard = (i: number, tag: string): Card => ({
  kind: 'assistant',
  ts: i * 10 + 1,
  messageId: `msg_${tag}_a${i}`,
  blocks: [{ type: 'tool', tool: 'bash', args: 'ls', partId: `prt_${tag}_${i}`, messageId: `msg_${tag}_a${i}`, status: 'done' }],
})

/** n 组 user+assistant 对（2n 卡 / 3n 行）。 */
const page = (tag: string, n: number): Card[] =>
  Array.from({ length: n }, (_, i) => [userCard(i, tag), toolCard(i, tag)]).flat()

const HISTORY_URL = /\/api\/session\/[^/?]+(?:\?[^/]*)?$/

/** 服务端窗口语义 `[len-limit-offset, len-offset)`（core/history.ts cardsFromMessages）。 */
function stubPaged(all: Card[]) {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (HISTORY_URL.test(u)) {
      const om = /[?&]offset=(\d+)/.exec(u)
      const lm = /[?&]limit=(\d+)/.exec(u)
      const offset = om ? Number(om[1]) : 0
      const limit = lm ? Number(lm[1]) : 200
      const end = Math.max(0, all.length - offset)
      const start = Math.max(0, all.length - limit - offset)
      const cards = all.slice(start, end)
      return { ok: true, json: async () => ({ cards, lastSeq: 0, hasMore: cards.length >= limit, busy: false }) }
    }
    if (u.includes('/api/models')) return { ok: true, json: async () => [] }
    if (u.includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
    if (u.includes('/api/sessions')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  })
}

async function snapshotOf(sessionId: string): Promise<{ snap: any; svc: any }> {
  const frames: any[] = []
  const svc = createOcrcZcodeAgentService()
  svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
  await svc.subscribeConversationV4({ sessionId, workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 60))
  const snap = frames.map((f) => f?.frame?.payload?.snapshot).find((s) => s && Array.isArray(s.rows?.window))
  return { snap, svc }
}

/**
 * 与 vendor 同构的「加载更早」：以窗口首行为游标取 60 行一页，按
 * `mergeOlderRows` 的 `rowId < window[0].rowId` 过滤后前插——DOM 里的行数就是它。
 */
async function drainLikeVendor(svc: any, sessionId: string, seed: any[], maxPages = 40) {
  let window_ = [...seed]
  let dropped = 0
  for (let i = 0; i < maxPages; i++) {
    const out = await svc.conversationRowsRangeV4({ sessionId, beforeRowId: window_[0].rowId, limit: 60 })
    const firstRowId = window_[0]?.rowId ?? Number.POSITIVE_INFINITY
    const older = out.rows.filter((r: any) => r.rowId < firstRowId)
    dropped += out.rows.length - older.length
    if (older.length === 0) break
    window_ = [...older, ...window_]
    if (out.hasMore !== true) break
  }
  return { window: window_, dropped }
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom */ } })
afterEach(() => vi.unstubAllGlobals())

describe('D · 更早页 id 单调性（1 行差根因）', () => {
  const ALIGNED = [...page('p', 100), ...page('o', 100), ...page('n', 100)] // 600 卡 / 900 行

  it('① 对齐档（行数 3 的倍数）：翻到底行数精确 900，无丢行', async () => {
    vi.stubGlobal('fetch', stubPaged(ALIGNED))
    const { snap, svc } = await snapshotOf('ses_d_aligned')
    expect(snap.rows.totalCount).toBe(300)
    const { window: w, dropped } = await drainLikeVendor(svc, 'ses_d_aligned', snap.rows.window)
    expect(dropped, 'vendor 过滤丢弃的行数').toBe(0)
    expect(w.length, '翻到底的窗口行数').toBe(900)
  })

  it('② 更早页在行序上 id 单调递增（vendor 数值过滤的前提）', async () => {
    vi.stubGlobal('fetch', stubPaged(ALIGNED))
    const { snap, svc } = await snapshotOf('ses_d_monotonic')
    const { window: w } = await drainLikeVendor(svc, 'ses_d_monotonic', snap.rows.window)
    const bad: string[] = []
    for (let i = 1; i < w.length; i++) {
      if (!(w[i].rowId > w[i - 1].rowId)) bad.push(`#${i} ${w[i - 1].kind}(${w[i - 1].rowId}) → ${w[i].kind}(${w[i].rowId})`)
    }
    expect(bad.slice(0, 8), `行序上 id 非单调的相邻对（共 ${bad.length} 处）`).toEqual([])
  })

  it('③ 非对齐档（尾部窗口首行落在 input 行）：复现 1 行差', async () => {
    // 缺陷触发条件 = 游标（尾部窗口首行）落在 userInput 行上。修前该条件下 vendor
    // mergeOlderRows 按 `rowId < window[0].rowId` 的数值过滤会把游标前那张 id 更大的
    // turnHeader 丢掉：实测修前 891/901（每页边界丢 1、共丢 10 行）；本用例断言修后
    // 901/901、dropped=0 —— 即该用例是这条缺陷的回归门（修前它会失败）。
    // 末卡改成 2 个 tool 块 → 该页 301 行（非 3 的倍数）→ 尾部 60 行窗口的首行落在
    // userInput 行上，其前一张 turnHeader 的 id 更大 → 被 vendor 过滤掉。
    const nPage = [...page('n', 100)]
    nPage[nPage.length - 1] = {
      kind: 'assistant', ts: 9999, messageId: 'msg_n_x',
      blocks: [
        { type: 'tool', tool: 'bash', args: 'ls', partId: 'prt_n_x1', messageId: 'msg_n_x', status: 'done' },
        { type: 'tool', tool: 'bash', args: 'ls', partId: 'prt_n_x2', messageId: 'msg_n_x', status: 'done' },
      ],
    }
    const all = [...page('p', 100), ...page('o', 100), ...nPage] // 600 卡 / 901 行
    vi.stubGlobal('fetch', stubPaged(all))
    const { snap, svc } = await snapshotOf('ses_d_misaligned')
    expect(snap.rows.window.length).toBe(60)
    // 尾部窗口首行必须是 userInput（否则本用例没有落在缺陷触发条件上）
    expect(snap.rows.window[0].kind).toBe('userInput')
    const { window: w, dropped } = await drainLikeVendor(svc, 'ses_d_misaligned', snap.rows.window)
    expect(w.length, `翻到底行数（丢 ${dropped} 行）`).toBe(901)
    expect(dropped).toBe(0)
  })
})
