// N12 G7 — /z/ goal 面契约测试。
// 桥接要做四件事，各自钉一组断言：
//  ① snapshot.goal：host 的四态记录 → vendor 六态（active|paused|verifying|verified|
//     notSatisfied|failed），并同步 availability.pauseGoal/resumeGoal；
//  ② 续跑轮：origin='goalContinuation' + 气泡只显示短展示行（提示词折进 epilogue）；
//  ③ 每轮验收 → timelineMarker 行，lane 必须是 turnTailBoundary；
//  ④ 命令：sendGoalCommand/pauseGoal/resumeGoal → POST /api/goal（ACK accepted）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'
import { projectGoal, projectGoalStatus, projectGoalAvailability } from '../goalProjection.js'
import type { OcrcGoalRecord } from '../goalProjection.js'

const PREFIX = '[ocrc-goal-continuation]'

function goalRecord(over: Partial<OcrcGoalRecord> = {}): OcrcGoalRecord {
  return {
    targetId: 'goal_1',
    objective: '让测试全绿',
    status: 'active',
    iteration: 1,
    tokensUsed: 100,
    timeUsedSeconds: 5,
    activeRunStartedAtMs: 1000,
    verifications: [],
    iterations: [{ iteration: 1, items: [], updatedAt: 1 }],
    ...over,
  }
}

/** 驱动一次 subscribeConversationV4，返回 snapshot + 记录所有 fetch。 */
async function snapshotFor(cards: unknown[], goal: OcrcGoalRecord | null, verifying = false) {
  const frames: any[] = []
  const calls: Array<{ url: string; body?: any }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body })
    if (String(url).includes('/goal')) return { ok: true, json: async () => ({ goal, verifying }) }
    if (String(url).includes('/api/session/')) return { ok: true, json: async () => ({ cards, lastSeq: cards.length, hasMore: false, busy: false }) }
    if (String(url).includes('/api/models')) return { ok: true, json: async () => [] }
    if (String(url).includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
    if (String(url).includes('/api/sessions')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  }))
  const svc = createOcrcZcodeAgentService()
  svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
  await svc.subscribeConversationV4({ sessionId: 'ses_1', workspacePath: '/w' })
  await new Promise((r) => setTimeout(r, 50))
  const snapshot = frames.map((f) => f?.frame?.payload?.snapshot).find((s) => s && Array.isArray(s.rows?.window))
  return { snapshot, frames, calls, svc }
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

describe('goal 六态投影', () => {
  it('active 无验收结论 → active；有 notSatisfied → notSatisfied', () => {
    const g = goalRecord()
    expect(projectGoalStatus(g, false)).toBe('active')
    expect(projectGoalStatus(g, true)).toBe('verifying')
    expect(projectGoalStatus(goalRecord({
      verifications: [{ iteration: 1, outcome: 'notSatisfied', at: 1, nextAction: 'x' }],
    }), false)).toBe('notSatisfied')
  })

  it('complete → verified；paused/budget_limited → paused（对齐上游 mapGoalStatus）', () => {
    expect(projectGoalStatus(goalRecord({ status: 'complete' }), false)).toBe('verified')
    expect(projectGoalStatus(goalRecord({ status: 'paused' }), false)).toBe('paused')
    // 预算耗尽与被 stop 一样等用户显式 resume
    expect(projectGoalStatus(goalRecord({ status: 'budget_limited' }), false)).toBe('paused')
  })

  it('verifying 压过一切（验收进行中）', () => {
    expect(projectGoalStatus(goalRecord({ status: 'complete' }), true)).toBe('verifying')
  })

  it('availability 门：pause 只在可续时开，resume 只在 paused 时开', () => {
    expect(projectGoalAvailability('active')).toEqual({ pauseGoal: { allowed: true }, resumeGoal: { allowed: false, reasonCode: 'goalNotPaused' } })
    expect(projectGoalAvailability('verifying').pauseGoal).toEqual({ allowed: true })
    expect(projectGoalAvailability('notSatisfied').pauseGoal).toEqual({ allowed: true })
    expect(projectGoalAvailability('paused')).toEqual({ pauseGoal: { allowed: false, reasonCode: 'goalNotActive' }, resumeGoal: { allowed: true } })
    expect(projectGoalAvailability('verified').resumeGoal).toEqual({ allowed: false, reasonCode: 'goalNotPaused' })
    expect(projectGoalAvailability(null)).toEqual({ pauseGoal: { allowed: false, reasonCode: 'noGoalToPause' }, resumeGoal: { allowed: false, reasonCode: 'noGoalToResume' } })
  })

  it('failed 永不投影：fail-closed 停机时记录是 paused，投影成 failed 会把 resume 门关死', () => {
    const g = goalRecord({ status: 'paused', verifications: [{ iteration: 1, outcome: 'failed', at: 1, reason: 'bad json' }] })
    expect(projectGoalStatus(g, false)).toBe('paused')
    expect(projectGoalAvailability(projectGoalStatus(g, false)).resumeGoal).toEqual({ allowed: true })
  })

  it('todo 状态归一到 vendor planItem（cancelled→completed，in_progress→inProgress）', () => {
    const g = projectGoal(goalRecord({
      iterations: [{ iteration: 1, items: [
        { id: 'a', content: 'A', status: 'completed' },
        { id: 'b', content: 'B', status: 'in_progress' },
        { id: 'c', content: 'C', status: 'cancelled' },
        { id: 'd', content: 'D', status: 'pending' },
      ], updatedAt: 1 }],
    }), false)
    expect(g.iterations[0]!.items.map((i) => i.status)).toEqual(['completed', 'inProgress', 'completed', 'pending'])
  })
})

describe('snapshot.goal + availability', () => {
  it('无 goal 时 snapshot.goal 为 null 且两个 goal 门带 noGoal 原因码', async () => {
    const { snapshot } = await snapshotFor([{ kind: 'user', text: 'hi', ts: 1 }], null)
    expect(snapshot.goal).toBeNull()
    expect(snapshot.availability.pauseGoal).toEqual({ allowed: false, reasonCode: 'noGoalToPause' })
    expect(snapshot.availability.resumeGoal).toEqual({ allowed: false, reasonCode: 'noGoalToResume' })
    expect(snapshot.availability.fork).toEqual({ allowed: true })
  })

  it('有 goal 时 snapshot.goal 是六态投影，pause 门打开', async () => {
    const { snapshot } = await snapshotFor([{ kind: 'user', text: 'hi', ts: 1 }], goalRecord())
    expect(snapshot.goal).toMatchObject({ targetId: 'goal_1', objective: '让测试全绿', status: 'active', iteration: 1 })
    expect(snapshot.availability.pauseGoal).toEqual({ allowed: true })
    expect(snapshot.availability.resumeGoal.allowed).toBe(false)
  })

  it('verifying=true 时 snapshot.goal.status = verifying', async () => {
    const { snapshot } = await snapshotFor([{ kind: 'user', text: 'hi', ts: 1 }], goalRecord(), true)
    expect(snapshot.goal.status).toBe('verifying')
  })
})

describe('续跑轮的行投影', () => {
  const contText = `${PREFIX} 完成 A\n\nContinue working toward the active session goal. 完成 A\n\n<untrusted_objective>\n目标\n</untrusted_objective>`

  it('origin=goalContinuation，气泡正文只显示短展示行，提示词折进 epilogue', async () => {
    const { snapshot } = await snapshotFor([
      { kind: 'user', text: '原始请求', ts: 1, messageId: 'msg_u1' },
      { kind: 'assistant', ts: 2, messageId: 'msg_a1', blocks: [{ type: 'text', text: '开始' }] },
      { kind: 'user', text: contText, ts: 3, messageId: 'msg_u2' },
      { kind: 'assistant', ts: 4, messageId: 'msg_a2', blocks: [{ type: 'text', text: '继续做' }] },
    ], goalRecord())
    const rows = snapshot.rows.window
    const contInput = rows.find((r: any) => r.kind === 'userInput' && r.origin === 'goalContinuation')
    expect(contInput).toBeDefined()
    expect(contInput.text.startsWith('完成 A')).toBe(true) // 前缀已剥掉
    expect(contInput.epilogueStart).toBe('完成 A'.length)
    // 正文（气泡里显示的）不含提示词骨架
    expect(contInput.text.slice(0, contInput.epilogueStart)).toBe('完成 A')
    // turnHeader 也是 goalContinuation（vendor 用它做轮次归组）
    const headers = rows.filter((r: any) => r.kind === 'turnHeader')
    expect(headers.map((h: any) => h.origin)).toEqual(['userInput', 'goalContinuation'])
    // 普通用户轮不受影响
    expect(rows.find((r: any) => r.kind === 'userInput' && r.origin === 'realUser').text).toBe('原始请求')
  })

  it('普通用户消息（无前缀）保持 realUser，无 epilogueStart', async () => {
    const { snapshot } = await snapshotFor([{ kind: 'user', text: '普通消息', ts: 1, messageId: 'm1' }], null)
    const input = snapshot.rows.window.find((r: any) => r.kind === 'userInput')
    expect(input.origin).toBe('realUser')
    expect(input.epilogueStart).toBeUndefined()
  })

  it('origin=goalContinuation 的卡（无前缀）也识别为续跑轮', async () => {
    const { snapshot } = await snapshotFor([
      { kind: 'user', text: `${PREFIX} x`, ts: 1, messageId: 'm1', origin: 'goalContinuation' },
    ], null)
    expect(snapshot.rows.window.find((r: any) => r.kind === 'userInput').origin).toBe('goalContinuation')
  })
})

describe('goalVerify 时间线行', () => {
  const contText = (n: string) => `${PREFIX} ${n}\n\nContinue working toward the active session goal.`

  it('每轮验收出一行 timelineMarker，lane=turnTailBoundary', async () => {
    const { snapshot } = await snapshotFor([
      { kind: 'user', text: contText('第一轮'), ts: 1, messageId: 'u1' },
      { kind: 'assistant', ts: 2, messageId: 'a1', blocks: [{ type: 'text', text: '做了 A' }] },
      { kind: 'user', text: contText('第二轮'), ts: 3, messageId: 'u2' },
      { kind: 'assistant', ts: 4, messageId: 'a2', blocks: [{ type: 'text', text: '做了 B' }] },
    ], goalRecord({
      iteration: 2,
      verifications: [
        { iteration: 1, outcome: 'notSatisfied', at: 10, reason: '还差 A', nextAction: '完成 A' },
        { iteration: 2, outcome: 'pass', at: 20, reason: '全部完成' },
      ],
    }))
    const markers = snapshot.rows.window.filter((r: any) => r.kind === 'timelineMarker')
    expect(markers).toHaveLength(2)
    // lane 必须是 turnTailBoundary——缺了会被折进「已工作」折叠组
    expect(markers.every((m: any) => m.lane === 'turnTailBoundary')).toBe(true)
    expect(markers.map((m: any) => m.marker)).toEqual([
      { type: 'goalVerify', iteration: 1, outcome: 'notSatisfied', detail: '还差 A' },
      { type: 'goalVerify', iteration: 2, outcome: 'pass', detail: '全部完成' },
    ])
    // 第 1 轮的 marker 落在第 2 轮开始之前（冷启动回落锚点）
    const idx = (pred: (r: any) => boolean) => snapshot.rows.window.findIndex(pred)
    expect(idx((r: any) => r.kind === 'timelineMarker' && r.marker.iteration === 1))
      .toBeLessThan(idx((r: any) => r.kind === 'userInput' && r.text.startsWith('第二轮')))
  })

  it('verifying 中的当前轮出 running marker，与终态共用同一 rowId（终态 upsert 覆盖）', async () => {
    const { snapshot } = await snapshotFor([
      { kind: 'user', text: contText('第一轮'), ts: 1, messageId: 'u1' },
      { kind: 'assistant', ts: 2, messageId: 'a1', blocks: [{ type: 'text', text: '做了 A' }] },
    ], goalRecord({ iteration: 1 }), true)
    const markers = snapshot.rows.window.filter((r: any) => r.kind === 'timelineMarker')
    expect(markers).toHaveLength(1)
    expect(markers[0].marker).toEqual({ type: 'goalVerify', iteration: 1, outcome: 'running' })

    const { snapshot: terminal } = await snapshotFor([
      { kind: 'user', text: contText('第一轮'), ts: 1, messageId: 'u1' },
      { kind: 'assistant', ts: 2, messageId: 'a1', blocks: [{ type: 'text', text: '做了 A' }] },
    ], goalRecord({ iteration: 1, verifications: [{ iteration: 1, outcome: 'pass', at: 5 }] }))
    const t = terminal.rows.window.filter((r: any) => r.kind === 'timelineMarker')
    expect(t[0].rowId).toBe(markers[0].rowId)
    expect(t[0].marker.outcome).toBe('pass')
  })

  it('无 goal 时不产生任何 marker 行', async () => {
    const { snapshot } = await snapshotFor([{ kind: 'user', text: 'hi', ts: 1, messageId: 'u1' }], null)
    expect(snapshot.rows.window.filter((r: any) => r.kind === 'timelineMarker')).toHaveLength(0)
  })
})

describe('goal 命令路由', () => {
  async function command(type: string, payload: any = {}) {
    const calls: Array<{ url: string; body?: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url: String(url), body: init?.body })
      if (String(url).includes('/api/goal')) return { ok: true, json: async () => ({ goal: goalRecord() }) }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcZcodeAgentService()
    const ack = await svc.sendConversationCommandV4({
      envelope: { commandId: 'cmd-1', type, sessionId: 'ses_1', payload },
    })
    return { ack, calls }
  }

  it('sendGoalCommand → POST /api/goal set（objective = payload.text）', async () => {
    const { ack, calls } = await command('sendGoalCommand', { text: '让测试全绿' })
    expect(ack).toMatchObject({ commandId: 'cmd-1', status: 'accepted' })
    const post = calls.find((c) => c.url === '/api/goal')!
    expect(JSON.parse(post.body)).toEqual({ action: 'set', sessionId: 'ses_1', objective: '让测试全绿' })
  })

  it('pauseGoal → action=pause；resumeGoal → action=resume', async () => {
    expect(JSON.parse((await command('pauseGoal')).calls.find((c) => c.url === '/api/goal')!.body)).toEqual({ action: 'pause', sessionId: 'ses_1' })
    expect(JSON.parse((await command('resumeGoal')).calls.find((c) => c.url === '/api/goal')!.body)).toEqual({ action: 'resume', sessionId: 'ses_1' })
  })

  it('空 objective 直接失败，不打后端', async () => {
    const { ack, calls } = await command('sendGoalCommand', { text: '   ' })
    expect(ack).toMatchObject({ status: 'failed', reasonCode: 'ocrc_bad_payload' })
    expect(calls.find((c) => c.url === '/api/goal')).toBeUndefined()
  })

  it('plan 模式被 host 拒 → 失败 ACK 带可辨认原因码', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/goal')) return { ok: false, status: 400, json: async () => ({ error: 'plan_mode' }) }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcZcodeAgentService()
    const ack = await svc.sendConversationCommandV4({
      envelope: { commandId: 'cmd-2', type: 'sendGoalCommand', sessionId: 'ses_1', payload: { text: 'x' } },
    })
    expect(ack).toMatchObject({ status: 'failed', reasonCode: 'ocrc_goal_plan_mode' })
  })
})

describe('goal 帧 → state.updated（live 路径）', () => {
  /** 记录实例的 WebSocket 替身；测试手动触发 onopen/onmessage。 */
  class FakeWs {
    static OPEN = 1
    static CONNECTING = 0
    static instances: FakeWs[] = []
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    sent: string[] = []
    constructor(public url: string) { FakeWs.instances.push(this) }
    send(msg: string) { this.sent.push(msg) }
    close() { this.readyState = 3 }
  }

  it('verifying 帧推 goal+availability 的 state.updated，终态帧再推一次', async () => {
    const frames: any[] = []
    vi.stubGlobal('WebSocket', FakeWs as any)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/goal')) return { ok: true, json: async () => ({ goal: null, verifying: false }) }
      if (String(url).includes('/api/session/')) return { ok: true, json: async () => ({ cards: [{ kind: 'user', text: 'hi', ts: 1, messageId: 'u1' }], lastSeq: 1, hasMore: false, busy: false }) }
      if (String(url).includes('/api/models')) return { ok: true, json: async () => [] }
      if (String(url).includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcZcodeAgentService()
    svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
    await svc.subscribeConversationV4({ sessionId: 'ses_live', workspacePath: '/w' })
    await new Promise((r) => setTimeout(r, 20))

    const ws = FakeWs.instances.at(-1)!
    ws.onopen?.() // liveWsEnsure 的 onopen 会给受管会话发 subscribe

    ws.onmessage?.({ data: JSON.stringify({ type: 'goal', sessionId: 'ses_live', goal: goalRecord({ iteration: 1 }), verifying: true }) })
    await new Promise((r) => setTimeout(r, 10))

    const patches = frames
      .map((f) => f?.frame?.payload)
      .filter((p) => p?.kind === 'deltas')
      .flatMap((p: any) => p.deltas)
      // P5 起 ws 重连自愈会先推一条 control 清口 patch（合法流流量）；goal 断言只看 goal patch。
      .filter((d: any) => d.op === 'state.updated' && d.patch.goal)
    expect(patches.length).toBeGreaterThanOrEqual(1)
    expect(patches[0].patch.goal).toMatchObject({ targetId: 'goal_1', status: 'verifying', iteration: 1 })
    // availability 是整键替换 —— 必须带齐八个键，否则 zod 丢帧
    expect(Object.keys(patches[0].patch.availability).sort()).toEqual(
      ['compact', 'fork', 'pauseGoal', 'queueEdit', 'resumeGoal', 'sendQueuedNow', 'setFollowupMode', 'switchModelConfig'],
    )
    expect(patches[0].patch.availability.pauseGoal).toEqual({ allowed: true })

    ws.onmessage?.({ data: JSON.stringify({
      type: 'goal', sessionId: 'ses_live',
      goal: goalRecord({ iteration: 1, status: 'complete', verifications: [{ iteration: 1, outcome: 'pass', at: 9, reason: 'done' }] }),
      verifying: false,
    }) })
    await new Promise((r) => setTimeout(r, 10))
    const all = frames
      .map((f) => f?.frame?.payload)
      .filter((p) => p?.kind === 'deltas')
      .flatMap((p: any) => p.deltas)
      .filter((d: any) => d.op === 'state.updated')
    const lastPatch = all.at(-1)
    expect(lastPatch.patch.goal.status).toBe('verified')
    expect(lastPatch.patch.availability.resumeGoal).toEqual({ allowed: false, reasonCode: 'goalNotPaused' })
  })

  it('clear 帧（goal=null）推 goal:null 且两门回到 noGoal 原因码', async () => {
    const frames: any[] = []
    vi.stubGlobal('WebSocket', FakeWs as any)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/goal')) return { ok: true, json: async () => ({ goal: null, verifying: false }) }
      if (String(url).includes('/api/session/')) return { ok: true, json: async () => ({ cards: [], lastSeq: 0, hasMore: false, busy: false }) }
      if (String(url).includes('/api/models')) return { ok: true, json: async () => [] }
      if (String(url).includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = createOcrcZcodeAgentService()
    svc.onDynamicConversationFrame(() => {})((frame: any) => frames.push(frame))
    await svc.subscribeConversationV4({ sessionId: 'ses_live2', workspacePath: '/w' })
    await new Promise((r) => setTimeout(r, 20))
    const ws = FakeWs.instances.at(-1)!
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: 'goal', sessionId: 'ses_live2', goal: null, verifying: false }) })
    await new Promise((r) => setTimeout(r, 10))
    const patch = frames
      .map((f) => f?.frame?.payload)
      .filter((p) => p?.kind === 'deltas')
      .flatMap((p: any) => p.deltas)
      // P5 的 control patch 不带 goal 键；goal:null 的清场 patch 带。
      .find((d: any) => d.op === 'state.updated' && 'goal' in d.patch)
    expect(patch.patch.goal).toBeNull()
    expect(patch.patch.availability.resumeGoal).toEqual({ allowed: false, reasonCode: 'noGoalToResume' })
  })
})
