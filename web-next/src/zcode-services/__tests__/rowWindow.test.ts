// B7 数据面窗口化回归测试（2026-10-12，批次 2b）。
// 契约：
// ① 快照只带尾部窗口（vendor 的 snapshotTailWindowRows=60 行），totalCount=已加载行数；
// ② firstRowId = **分支首行**（更早行未加载时用 0 哨兵）——vendor 的 hasOlderRows
//    判据是 `window[0].rowId > firstRowId`，恒等即「加载更早」永不可达（旧缺陷）；
// ③ 行 id 单调：尾部递增、更早页前插取向下号段（数值上严格小于窗口首行）；
// ④ rows/range 真翻页：窗口内不够一页时按服务端 offset 语义向引擎要更早页；
// ⑤ 更早页前插不改既有行的 turn 号（更早页占更小的号段）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

const card = (kind: 'user' | 'assistant', i: number, tag: string) =>
  kind === 'user'
    ? { kind, text: `${tag}问${i}`, ts: i * 10, messageId: `msg_${tag}_u${i}` }
    : { kind, ts: i * 10 + 1, messageId: `msg_${tag}_a${i}`, blocks: [{ type: 'text', text: `${tag}答${i}` }] }

const page = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [card('user', i, tag), card('assistant', i, tag)]).flat()

function stubFetch(opts: { newest: unknown[]; older?: unknown[]; newestFull?: boolean; olderFull?: boolean }) {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('offset=200')) {
      return { ok: true, json: async () => ({ cards: opts.older ?? [], lastSeq: 0, hasMore: opts.olderFull === true, busy: false }) }
    }
    if (u.includes('/api/session/')) {
      return { ok: true, json: async () => ({ cards: opts.newest, lastSeq: 0, hasMore: opts.newestFull === true, busy: false }) }
    }
    if (u.includes('/api/models')) return { ok: true, json: async () => [] }
    if (u.includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
    if (u.includes('/api/sessions')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  })
}

async function snapshotOf(sessionId: string): Promise<any> {
  const frames: any[] = []
  const svc = createOcrcZcodeAgentService()
  svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
  await svc.subscribeConversationV4({ sessionId, workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 60))
  const snap = frames.map((f) => f?.frame?.payload?.snapshot).find((s) => s && Array.isArray(s.rows?.window))
  return { snap, svc }
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom */ } })
afterEach(() => vi.unstubAllGlobals())

describe('B7 尾部快照与 firstRowId 语义', () => {
  it('① 窗口截尾到 vendor 常量行数，totalCount 报已加载行数', async () => {
    vi.stubGlobal('fetch', stubFetch({ newest: page('n', 40), newestFull: true }))
    const { snap } = await snapshotOf('ses_b7_tail')
    expect(snap.rows.window.length).toBe(60)
    expect(snap.rows.totalCount).toBeGreaterThan(60)
  })

  it('② 还有更早行时 firstRowId=0（哨兵）；到底时 firstRowId=窗口首行', async () => {
    vi.stubGlobal('fetch', stubFetch({ newest: page('n', 40), newestFull: true }))
    const { snap } = await snapshotOf('ses_b7_first_has_older')
    expect(snap.rows.firstRowId).toBe(0)

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', stubFetch({ newest: page('n', 2), newestFull: false }))
    const { snap: snap2 } = await snapshotOf('ses_b7_first_complete')
    expect(snap2.rows.firstRowId).toBe(snap2.rows.window[0].rowId)
  })

  it('③ 窗口内行 id 单调递增（vendor 的数值比较前提）', async () => {
    vi.stubGlobal('fetch', stubFetch({ newest: page('n', 40), newestFull: true }))
    const { snap } = await snapshotOf('ses_b7_monotonic')
    const ids = snap.rows.window.map((r: any) => r.rowId)
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1])
  })
})

describe('B7 rows/range 真翻页（offset 语义）', () => {
  // 满页（≥200 卡）才被判定「更早可能存在」——与真实大会话一致。
  const NEWEST = page('n', 100) // 200 卡 → 300 行
  const OLDER = page('o', 30) // 60 卡 → 90 行

  /** 模拟 vendor 的 loadOlder/loadAllOlder：以窗口首行为游标按 60 行一页向上拉。 */
  async function drain(svc: any, sessionId: string, fromRowId: number, maxPages = 20) {
    const pages: any[][] = []
    let cursor = fromRowId
    let hasMore = true
    for (let i = 0; i < maxPages && hasMore; i++) {
      const out = await svc.conversationRowsRangeV4({ sessionId, beforeRowId: cursor, limit: 60 })
      if (!out.rows.length) break
      pages.push(out.rows)
      cursor = out.rows[0].rowId
      hasMore = out.hasMore === true
    }
    return { pages, hasMore }
  }

  it('④ 按 offset 逐页取回更早历史，直到耗尽（hasMore=false）', async () => {
    vi.stubGlobal('fetch', stubFetch({ newest: NEWEST, newestFull: true, older: OLDER }))
    const { snap, svc } = await snapshotOf('ses_b7_range')
    const cursor = snap.rows.window[0].rowId
    const { pages, hasMore } = await drain(svc, 'ses_b7_range', cursor)
    expect(pages.length).toBeGreaterThan(5)
    const all = pages.flat()
    // 每一页的 id 都严格小于游标（向下号段），且页间单调递减
    expect(all.every((r) => r.rowId < cursor)).toBe(true)
    for (let i = 1; i < pages.length; i++) {
      expect(Math.max(...pages[i].map((r) => r.rowId))).toBeLessThan(Math.min(...pages[i - 1].map((r) => r.rowId)))
    }
    // 拉到了引擎侧更早的消息（内容真的来自 offset 页）
    expect(all.some((r) => (r.text ?? '').includes('o答'))).toBe(true)
    // 更早页取尽 → 不再声称有更多
    expect(hasMore).toBe(false)
  })

  it('⑤ 更早页前插后，既有行的 turn 号不变，且更早页占更小号段', async () => {
    vi.stubGlobal('fetch', stubFetch({ newest: NEWEST, newestFull: true, older: OLDER }))
    const { snap, svc } = await snapshotOf('ses_b7_turns')
    const beforeByRowId = new Map<number, string>(snap.rows.window.map((r: any) => [r.rowId, r.turnId]))
    const cursor = snap.rows.window[0].rowId
    const { pages } = await drain(svc, 'ses_b7_turns', cursor)
    const prepended = pages.flat().filter((r: any) => r.rowId < cursor)
    expect(prepended.length).toBeGreaterThan(0)
    const turnNum = (id: string) => Number(String(id).replace('turn-', ''))
    // 更早页占更小的号段（前插不夺既有轮的号）
    expect(Math.max(...prepended.map((r: any) => turnNum(r.turnId)))).toBeLessThan(Math.min(...snap.rows.window.map((r: any) => turnNum(r.turnId))))

    // 再取一次快照（重建走全窗口）：既有行的 turn 号必须原样
    const { snap: snap2 } = await snapshotOf('ses_b7_turns')
    for (const r of snap2.rows.window) {
      const prev = beforeByRowId.get(r.rowId)
      if (prev !== undefined) expect(r.turnId).toBe(prev)
    }
  })
})
