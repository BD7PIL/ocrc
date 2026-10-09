// 后台 bash 输出页契约测试（D2）。ocrc 没有"后台任务"概念——运行中的 bash
// 工具调用就是 vendor 的 backgroundWork；workId 编码 (messageId, partId)，
// backgroundBashOutputV4 靠它回取该 part 的输出（schema: 8KB 上限 + outputPath）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

/** 用一张历史卡片驱动 snapshot（running 的 bash 工具块）。 */
async function snapshotWith(cards: unknown[]): Promise<any> {
  const frames: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/session/') && u.includes('/message/')) return { ok: true, json: async () => ({}) }
    if (u.includes('/api/session/')) return { ok: true, json: async () => ({ cards, lastSeq: 1, hasMore: false, busy: true }) }
    if (u.includes('/api/sessions')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => [] }
  }))
  const svc = createOcrcZcodeAgentService()
  svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
  await svc.subscribeConversationV4({ sessionId: 'ses_a', workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 50))
  return frames.map((f) => f?.frame?.payload?.snapshot).find((s) => s && Array.isArray(s.rows?.window))
}

describe('backgroundWorks 投影（运行中的 bash）', () => {
  it('running 的 bash 工具块 → 一条 bash work，workId 编码 messageId+partId', async () => {
    const snap = await snapshotWith([
      { kind: 'user', text: '跑个长命令', ts: 1 },
      {
        kind: 'assistant', ts: 2, blocks: [
          { type: 'tool', tool: 'bash', args: 'sleep 40 && echo done', status: 'running', partId: 'prt_1', messageId: 'msg_1' },
        ],
      },
    ])
    expect(snap.backgroundWorks).toHaveLength(1)
    expect(snap.backgroundWorks[0]).toMatchObject({
      workId: 'ocrc-tool:msg_1:prt_1',
      kind: 'bash',
      status: 'running',
      cancellable: false,
    })
    expect(typeof snap.backgroundWorks[0].startedAt).toBe('number')
    expect(snap.backgroundWorks[0].title).toContain('sleep 40')
  })

  it('已结束的 bash 不进 backgroundWorks（只有运行中才是后台任务）', async () => {
    const snap = await snapshotWith([
      { kind: 'user', text: 'q', ts: 1 },
      {
        kind: 'assistant', ts: 2, blocks: [
          { type: 'tool', tool: 'bash', args: 'ls', status: 'done', partId: 'prt_2', messageId: 'msg_2' },
          { type: 'tool', tool: 'read', args: 'a.ts', status: 'running', partId: 'prt_3', messageId: 'msg_3' },
        ],
      },
    ])
    expect(snap.backgroundWorks).toEqual([])
  })
})

describe('backgroundBashOutputV4', () => {
  it('按 workId 回取 part 输出，超 8KB 截断并如实标注', async () => {
    const big = 'x'.repeat(9000)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/message/msg_1')) {
        return { ok: true, json: async () => ({ parts: [{ id: 'prt_1', type: 'tool', state: { status: 'running', output: big } }] }) }
      }
      return { ok: true, json: async () => ({}) }
    }))
    const out = await createOcrcZcodeAgentService().backgroundBashOutputV4({ sessionId: 'ses_a', workId: 'ocrc-tool:msg_1:prt_1' })
    expect(out.kind).toBe('output')
    expect(out.status).toBe('running')
    expect(out.output).toHaveLength(8192)
    expect(out.truncated).toBe(true)
    expect(out.outputPath).toContain('prt_1')
  })

  it('未知 workId / 缺 part / 读失败都如实降级，不假装有输出', async () => {
    const svc = createOcrcZcodeAgentService()
    expect((await svc.backgroundBashOutputV4({ sessionId: 'ses_a', workId: 'nonsense' })).kind).toBe('unsupported')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ parts: [] }) })))
    expect((await svc.backgroundBashOutputV4({ sessionId: 'ses_a', workId: 'ocrc-tool:msg_1:gone' })).kind).toBe('unavailable')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    expect((await svc.backgroundBashOutputV4({ sessionId: 'ses_a', workId: 'ocrc-tool:msg_1:prt_1' })).kind).toBe('read_failed')
  })
})
