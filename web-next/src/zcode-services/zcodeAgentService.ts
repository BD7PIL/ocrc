// zcode-services/zcodeAgentService.ts — ocrc-backed zcodeAgentService v4 面 (N2).
// hello/握手 + 订阅三件套 + **初始 snapshot 通知**：subscribeConversationV4 ACK
// 后异步取 ocrc 历史（cards → conversation rows），包成 v4 topic frame 经
// onDynamicConversationFrame 的监听器同步下发一次 —— ConversationTimeline 的
// assembler/decoder 由此渲染真实消息。发链（sendPrompt）在 zcodeTaskService。

import { conversationTopicFrameSchema } from '@zcode/shared/zcode-protocol-v4/transport'

const V4_WIRE_PROTOCOL_VERSION = 3 as const

function uuid(): string {
  // http 局域网非安全上下文里 crypto.randomUUID 不可用
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

// ── ocrc 历史 → v4 conversation rows ──
interface OcrcBlock { type: string; text?: string; tool?: string; args?: string; status?: string }
interface OcrcCard { kind: string; text?: string; ts?: number; blocks?: OcrcBlock[]; meta?: { model?: string } }

async function ocrcHistory(taskId: string): Promise<OcrcCard[]> {
  try {
    const res = await fetch(`/api/session/${taskId}?limit=200`, {
      headers: { Authorization: `Bearer ${token()}` },
    })
    if (!res.ok) return []
    return ((await res.json()) as { cards: OcrcCard[] }).cards ?? []
  } catch {
    return []
  }
}

function buildRows(cards: OcrcCard[]): any[] {
  const rows: any[] = []
  let rowId = 1
  let turn = 0
  // 时间戳必须取卡片自身的 ts：live 路径按行内容 diff（row.upserted/row.appended），
  // Date.now() 会让每次重建的 rows 全部不同，diff 退化成全量 upsert。
  const base = (ts: number) => ({
    rowId: rowId,
    turnId: `turn-${turn}`,
    createdAt: ts,
    createdAtSeq: rowId,
  })
  for (const c of cards) {
    const ts = c.ts ?? 0
    if (c.kind === 'user') {
      turn += 1
      rows.push({ ...base(ts), kind: 'turnHeader', origin: 'userInput', state: 'completedSuccess', startedAt: ts })
      rowId += 1
      rows.push({ ...base(ts), kind: 'userInput', origin: 'realUser', text: c.text ?? '' })
      rowId += 1
    } else if (c.kind === 'assistant' && c.blocks) {
      for (const b of c.blocks) {
        if (b.type === 'text') {
          rows.push({ ...base(ts), kind: 'assistantText', text: b.text ?? '', state: 'complete', model: c.meta?.model })
          rowId += 1
        } else if (b.type === 'reasoning') {
          rows.push({ ...base(ts), kind: 'reasoning', text: b.text ?? '', state: 'complete' })
          rowId += 1
        } else if (b.type === 'tool') {
          rows.push({
            ...base(ts),
            kind: 'toolCall',
            toolCallId: `tool-${rowId}`,
            toolName: b.tool ?? 'tool',
            status: b.status === 'error' ? 'error' : 'success',
            inputText: (b.args ?? '').slice(0, 2000),
          })
          rowId += 1
        }
      }
    }
  }
  return rows
}

// ── 通知通道：per-frame 监听器注册表 + 订阅登记（resync 回显同一 subscriptionId）──
const frameListeners = new Set<(frame: any) => void>()
const subscriptions = new Map<string, { sessionId: string; topic: string }>()
const lastSeqBySub = new Map<string, number>()
// assembler 每 route 维护单调 ordinal tombstone（不淘汰）：同订阅第 N 个 logical
// frame 的 ordinal 必须严格递增，旧 ordinal + 新 logicalFrameId 会触发
// proto.frameAssemblyOrdinalConflict → recovery 阶梯 fail-closed。这就是此前
// 多轮会话偶发 fault.subscription.recoveryFailed 的根因（recovery 帧固定 ordinal 1
// 撞上已 settle 的 initial 帧）。
const ordinalBySub = new Map<string, number>()

function nextOrdinal(subscriptionId: string): number {
  const next = (ordinalBySub.get(subscriptionId) ?? 0) + 1
  ordinalBySub.set(subscriptionId, next)
  return next
}

/** 包一层 wire candidate 信封并下发给全部监听器（zod 自检不过则丢弃并记日志）。 */
function deliverWire(
  topic: string,
  subscriptionId: string,
  fromSeq: number,
  toSeq: number,
  payload: { kind: 'snapshot'; snapshot: unknown } | { kind: 'deltas'; deltas: unknown[] },
  deliveryKind: 'initial' | 'recovery' | 'online',
): void {
  const frame = { topic, subscriptionId, fromSeq, toSeq, sentAt: Date.now(), payload }
  const check = conversationTopicFrameSchema.safeParse(frame)
  if (!check.success) {
    console.info('[ocrc-trace] frame zod FAIL:', JSON.stringify(check.error.issues.slice(0, 6).map((i) => ({ path: i.path.join('.'), msg: i.message }))))
    return
  }
  const wire = {
    wireVersion: 3,
    kind: 'complete' as const,
    deliveryKind,
    logicalFrameId: uuid(),
    logicalFrameOrdinal: nextOrdinal(subscriptionId),
    topic,
    subscriptionId,
    frame: check.data,
  }
  console.info('[ocrc-trace] wire candidate OK (' + deliveryKind + ') ordinal=' + wire.logicalFrameOrdinal + ', delivering to', frameListeners.size, 'listeners')
  for (const l of frameListeners) {
    try { l(wire) } catch (e) { console.info('[ocrc-trace] listener threw', String(e).slice(0, 200)) }
  }
}

interface SnapshotBuild {
  snapshot: Record<string, unknown>
  seq: number
  rows: any[]
}

async function buildSnapshotPayload(taskId: string): Promise<SnapshotBuild> {
  const [cards, providers, overrides] = await Promise.all([
    ocrcHistory(taskId),
    fetch('/api/models', { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => r.json() as Promise<Array<{ id: string; models: Array<{ id: string; name?: string; variants?: string[] }> }>>)
      .catch(() => [] as Array<{ id: string; models: Array<{ id: string; name?: string; variants?: string[] }> }>),
    fetch('/api/overrides', { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => r.json() as Promise<{ model?: { providerID: string; modelID: string } | null }>)
      .catch(() => ({ model: null as { providerID: string; modelID: string } | null })),
  ])
  const curProvider = overrides.model?.providerID ?? providers.find((p) => (p.models ?? []).length > 0)?.id ?? ''
  const curModel = overrides.model?.modelID ?? providers.find((p) => p.id === curProvider)?.models?.[0]?.id ?? ''
  const curThought = (providers.find((p) => p.id === curProvider)?.models?.find((m) => m.id === curModel)?.variants ?? [])[0] ?? ''
  const rows = buildRows(cards)
  const seq = rows.length
  const snapshot = {
    protocolVersion: 1,
    sessionId: taskId,
    logEpoch: 'ocrc-1',
    seq,
    revision: 1,
    control: {
      phase: 'completedSuccess',
      sessionEnded: true,
      canStop: false,
      stopState: 'idle',
      stopTargetKind: 'unknown',
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: 'startNow' },
    config: { provider: curProvider, model: curModel, thought: curThought, thoughtLevels: providers.find((p) => p.id === curProvider)?.models?.find((m) => m.id === curModel)?.variants ?? [], followupMode: 'queue' },
    usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  }
  return { snapshot, seq, rows }
}

async function emitConversationSnapshot(taskId: string, topic: string, subscriptionId: string, deliveryKind: 'initial' | 'recovery' | 'online'): Promise<void> {
  const { snapshot, seq, rows } = await buildSnapshotPayload(taskId)
  console.info('[ocrc-trace] emitConversationSnapshot rows =', rows.length, 'listeners =', frameListeners.size)
  // 水位/rows 记账先于投递：retry 路径与 live diff 都依赖这份基线。
  lastSeqBySub.set(subscriptionId, seq)
  lastRowsBySession.set(taskId, rows)
  const payload = { kind: 'snapshot' as const, snapshot }
  if (!frameListeners.size) {
    // transport 尚未挂 upstream——延时重试；成功投递一次后取消余下重试
    // （重复投递同序号帧虽会被 assembler 去重，但不该依赖它兜底）。
    let delivered = false
    const attempt = () => {
      if (delivered || !frameListeners.size) return
      delivered = true
      deliverWire(topic, subscriptionId, 0, seq, payload, deliveryKind)
    }
    for (const delay of [300, 900, 2500, 5000]) setTimeout(attempt, delay)
    return
  }
  // 协议约定 snapshot 帧 fromSeq 固定为 0；seq 权威在 payload.snapshot.seq。
  deliverWire(topic, subscriptionId, 0, seq, payload, deliveryKind)
}

// ── N2 live：WS card 事件 → rows diff → online 增量/快照 ───────────────
// ocrc wsHub（/ws?token=）广播 {type:'card'|'sdelta'|'session.status'}。这里按
// 会话去抖后重取历史、重建 rows 并与上次基线 diff：尾部追加/行内容变化 →
// row.appended/row.upserted 增量帧（seq 前进 1）；前缀失配或截断（fork/edit）→
// 全量 online snapshot 收敛。全部走 nextOrdinal（单调契约，见 ordinalBySub 注释）。
const lastRowsBySession = new Map<string, any[]>()
const liveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const watchedSessions = new Set<string>()
let liveWs: WebSocket | null = null
let liveWsRetry: ReturnType<typeof setTimeout> | null = null

/** rows 前缀 diff：返回增量 op 列表；前缀失配/截断返回 null（调用方回退全量快照）。 */
function diffRows(prev: any[], next: any[]): Array<Record<string, unknown>> | null {
  if (next.length < prev.length) return null
  const upserts: Array<Record<string, unknown>> = []
  const appends: Array<Record<string, unknown>> = []
  for (let i = 0; i < next.length; i++) {
    const p = prev[i]
    const n = next[i]
    if (p === undefined) {
      appends.push({ op: 'row.appended', row: n })
    } else if (JSON.stringify(p) !== JSON.stringify(n)) {
      upserts.push({ op: 'row.upserted', row: n })
    }
  }
  // 施加序：先 upsert（已存在 rowId 原位替换）后 append（落尾）。
  return upserts.length + appends.length > 0 ? [...upserts, ...appends] : []
}

async function liveUpdate(sessionId: string): Promise<void> {
  const subs = [...subscriptions.entries()].filter(([, s]) => s.sessionId === sessionId)
  const prevRows = lastRowsBySession.get(sessionId)
  if (!subs.length || !prevRows) return
  const cards = await ocrcHistory(sessionId).catch(() => null)
  if (!cards) return
  const nextRows = buildRows(cards)
  if (JSON.stringify(prevRows) === JSON.stringify(nextRows)) return
  const deltas = diffRows(prevRows, nextRows)
  lastRowsBySession.set(sessionId, nextRows)
  for (const [subId, sub] of subs) {
    const lastSeq = lastSeqBySub.get(subId) ?? 0
    if (deltas) {
      if (deltas.length === 0) continue
      deliverWire(sub.topic, subId, lastSeq, lastSeq + 1, { kind: 'deltas', deltas }, 'online')
      lastSeqBySub.set(subId, lastSeq + 1)
    } else {
      const { snapshot, seq } = await buildSnapshotPayload(sessionId)
      deliverWire(sub.topic, subId, 0, seq, { kind: 'snapshot', snapshot }, 'online')
      lastSeqBySub.set(subId, seq)
    }
  }
}

function scheduleLive(sessionId: string): void {
  const existing = liveTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  liveTimers.set(sessionId, setTimeout(() => {
    liveTimers.delete(sessionId)
    void liveUpdate(sessionId)
  }, 400))
}

function liveWatch(sessionId: string): void {
  watchedSessions.add(sessionId)
  liveWsEnsure()
  if (liveWs?.readyState === WebSocket.OPEN) {
    try { liveWs.send(JSON.stringify({ type: 'subscribe', sessionId, sinceSeq: 0 })) } catch { /* 重连后重订阅 */ }
  }
}

function liveUnwatch(sessionId: string): void {
  watchedSessions.delete(sessionId)
  lastRowsBySession.delete(sessionId)
  if (liveWs?.readyState === WebSocket.OPEN) {
    try { liveWs.send(JSON.stringify({ type: 'unsubscribe', sessionId })) } catch { /* noop */ }
  }
}

function liveWsEnsure(): void {
  if (liveWs && (liveWs.readyState === WebSocket.OPEN || liveWs.readyState === WebSocket.CONNECTING)) return
  if (liveWsRetry) { clearTimeout(liveWsRetry); liveWsRetry = null }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  try {
    liveWs = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`)
  } catch {
    liveWsRetry = setTimeout(liveWsEnsure, 3000)
    return
  }
  liveWs.onopen = () => {
    // attach 时 wsHub 会推 hello；对每个受管会话显式订阅（sinceSeq 0 → 完整 replay，
    // 首帧 replay 经 liveUpdate 的 rows diff 自然去重）。
    for (const sessionId of watchedSessions) {
      try { liveWs?.send(JSON.stringify({ type: 'subscribe', sessionId, sinceSeq: 0 })) } catch { /* noop */ }
    }
  }
  liveWs.onmessage = (ev) => {
    let msg: { type?: string; sessionId?: string; card?: { sessionId?: string } }
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as typeof msg
    } catch {
      return
    }
    const sid = msg.sessionId ?? msg.card?.sessionId
    if (!sid || !watchedSessions.has(sid)) return
    if (msg.type === 'card' || msg.type === 'sdelta' || msg.type === 'session.status') scheduleLive(sid)
  }
  liveWs.onclose = () => {
    liveWs = null
    if (watchedSessions.size > 0) liveWsRetry = setTimeout(liveWsEnsure, 3000)
  }
  liveWs.onerror = () => {
    try { liveWs?.close() } catch { /* onclose 接管重连 */ }
  }
}

export function createOcrcZcodeAgentService(): any {
  const impl: Record<string, unknown> = {
    // ── v4 conversation 订阅三件套 + ACK 后异步下发初始 snapshot 通知 ──
    async subscribeConversationV4(params: { sessionId?: string; workspacePath?: string }) {
      const ack = {
        subscriptionId: `ocrc-sub-${uuid()}`,
        mode: 'snapshot',
        logEpoch: 'ocrc-1',
      }
      // transport 不传 topic——topic 由会话侧构造：conversation/<sessionId>
      const sessionId = params?.sessionId
      const topic = sessionId ? `conversation/${sessionId}` : undefined
      console.info('[ocrc-trace] subscribeConversationV4 sessionId =', sessionId, 'topic =', topic)
      if (topic && sessionId) {
        subscriptions.set(ack.subscriptionId, { sessionId, topic })
        liveWatch(sessionId)
        // post-response owned notification：ACK 先回，snapshot 异步补发
        void emitConversationSnapshot(sessionId, topic, ack.subscriptionId, 'initial')
      }
      return { ack }
    },
    // 恢复阶梯（vendor 04-sync）：resync 带 base/forceSnapshot；ack mode 必须如实——
    // resume = base 仍是当前水位（回一帧空增量收口 flight），snapshot = 全量重发。
    // 升级中的 recovery（upgradePending）只有 ack=resume 才会再 force 一次；
    // 如实回 mode 是阶梯正确运转的前提。
    async resyncConversationV4(params: { subscriptionId?: string; base?: { logEpoch: string; seq: number } | null; forceSnapshot?: boolean }) {
      const subId = params?.subscriptionId
      const sub = subId ? subscriptions.get(subId) : undefined
      const lastSeq = subId ? lastSeqBySub.get(subId) : undefined
      console.info('[ocrc-trace] resyncConversationV4 subId =', subId?.slice(-8), 'sub =', Boolean(sub), 'base =', JSON.stringify(params?.base ?? null), 'force =', Boolean(params?.forceSnapshot), 'lastSeq =', lastSeq)
      if (!sub || !subId) {
        // 未登记的订阅（世代/重启后残留）：notOwned 让 store fresh subscribe 自愈
        throw new Error('fault.subscription.notOwned')
      }
      const baseSeq = params?.base?.seq
      if (!params?.forceSnapshot && typeof baseSeq === 'number' && baseSeq === lastSeq) {
        // base 仍是当前水位：resume 收口。空增量帧 (N,N] 走 store 的重复帧规则
        // ——静默确认 recovery flight，不推进 seq。
        deliverWire(sub.topic, subId, baseSeq, lastSeq, { kind: 'deltas', deltas: [] }, 'recovery')
        return { ack: { subscriptionId: subId, mode: 'resume', logEpoch: 'ocrc-1' } }
      }
      void emitConversationSnapshot(sub.sessionId, sub.topic, subId, 'recovery')
      return { ack: { subscriptionId: subId, mode: 'snapshot', logEpoch: 'ocrc-1' } }
    },
    async unsubscribeConversationV4(params: { subscriptionId?: string }) {
      const subId = params?.subscriptionId
      if (!subId) return undefined
      const sub = subscriptions.get(subId)
      subscriptions.delete(subId)
      lastSeqBySub.delete(subId)
      // 该会话再无活跃订阅 → 停止 live watch 并释放 rows 基线
      if (sub && ![...subscriptions.values()].some((s) => s.sessionId === sub.sessionId)) {
        liveUnwatch(sub.sessionId)
      }
      return undefined
    },
    // 关闭/删除会话。expectedPersistence='deferred' 是预热草稿回收：仅当会话
    // 仍无任何消息（未提升）才删，有内容的真实会话一律保留并返回 false。
    async closeSession(params: { sessionId?: string; expectedPersistence?: 'deferred' | 'immediate' }) {
      const sessionId = params?.sessionId
      if (!sessionId) return false
      if (params?.expectedPersistence === 'deferred') {
        const cardCount = await ocrcHistory(sessionId)
          .then((c) => c.length)
          .catch(() => -1)
        if (cardCount !== 0) return false
      }
      const res = await fetch(`/api/sessions/${sessionId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}` },
      }).catch(() => null)
      return Boolean(res?.ok)
    },
    onDynamicConversationFrame(_workspace: unknown) {
      return (listener: (frame: any) => void) => {
        frameListeners.add(listener)
        return () => frameListeners.delete(listener)
      }
    },
    async helloConversationV4() {
      return {
        kind: 'hello' as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: `host-${uuid()}`,
        clientMode: 'desktop-continuous' as const,
        deliveryProfile: 'continuous' as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: false,
          binaryFrames: false,
          compression: 'none' as const,
          workspaceHookReview: true,
          independentPlanState: true,
          workflowRunDeltas: false,
        },
        auth: {},
      }
    },
    // v4 命令上行：sendText → ocrc /api/message；createSession → /api/create-session。
    // ACK 立即回 accepted（引擎执行异步推进，delta 由流通道下发）。
    async sendConversationCommandV4(params: { envelope: { commandId: string; type: string; sessionId?: string | null; payload: Record<string, unknown> } }) {
      const { envelope } = params
      const sessionId = envelope.sessionId ?? undefined
      if (envelope.type === 'sendText') {
        const text = String((envelope.payload as { text?: string }).text ?? '')
        if (!sessionId) throw new Error('[ocrc-fork] sendText 缺 sessionId')
        const res = await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ sessionId, text, clientId: envelope.commandId }),
        })
        if (!res.ok) {
          return {
            commandId: envelope.commandId,
            status: 'failed',
            reasonCode: 'ocrc_send_failed',
            message: `POST /api/message ${res.status}`,
            revisionAtDecision: 0,
          }
        }
        return {
          commandId: envelope.commandId,
          status: 'accepted',
          revisionAtDecision: 0,
        }
      }
      if (envelope.type === 'createSession') {
        const directory = (params as { workspacePath?: string }).workspacePath ?? '/home/demo/develop/opencode-plugin/ocrc'
        const res = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ directory }),
        })
        if (!res.ok) {
          return {
            commandId: envelope.commandId,
            status: 'failed',
            reasonCode: 'ocrc_create_failed',
            message: `POST /api/session ${res.status}`,
            revisionAtDecision: 0,
          }
        }
        const created = (await res.json()) as { id: string }
        // firstInput.text = 草稿首条消息（createSession 携带 → turnHeader+userInput rows）
        const firstText = String((envelope.payload as { firstInput?: { text?: string } }).firstInput?.text ?? '')
        if (firstText) {
          const mres = await fetch('/api/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ sessionId: created.id, text: firstText, clientId: envelope.commandId }),
          })
          if (!mres.ok) {
            return {
              commandId: envelope.commandId,
              status: 'failed',
              reasonCode: 'ocrc_send_failed',
              message: `POST /api/message ${mres.status}`,
              revisionAtDecision: 0,
            }
          }
        }
        return {
          commandId: envelope.commandId,
          status: 'accepted',
          revisionAtDecision: 0,
          result: { type: 'createSession', sessionId: created.id },
        }
      }
      if (envelope.type === 'switchModelConfig') {
        // opencode 后端没有会话级模型切换（sessionControls=false）；ocrc 的等价
        // 语义是「下一轮覆盖」——旧 rc.2 面板走的就是这条 /api/overrides。
        const { provider, model, thought } = envelope.payload as { provider?: string; model?: string; thought?: string }
        if (!provider || !model) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'switchModelConfig 需要 provider+model', revisionAtDecision: 0 }
        }
        const res = await fetch('/api/overrides', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ model: { providerID: provider, modelID: model }, variant: thought || null }),
        })
        return res.ok
          ? { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
          : { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_switch_model_failed', message: `POST /api/overrides ${res.status}`, revisionAtDecision: 0 }
      }
      if (envelope.type === 'switchCollaborationMode') {
        // ZCode 的 build/edit/plan/yolo ↔ ocrc 的审批策略（plan/build 是引擎原生
        // 模式，落到 ocrc 的 default——策略层叠在 build 上）。
        const mode = String((envelope.payload as { mode?: string }).mode ?? '')
        if (!sessionId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'switchCollaborationMode 缺 sessionId', revisionAtDecision: 0 }
        }
        const policy = mode === 'yolo' ? 'yolo' : mode === 'edit' ? 'edit' : 'default'
        const res = await fetch(`/api/session/${sessionId}/policy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ policy }),
        })
        return res.ok
          ? { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
          : { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_switch_mode_failed', message: `POST /api/session/:id/policy ${res.status}`, revisionAtDecision: 0 }
      }
      if (envelope.type === 'renameSession' || envelope.type === 'deleteSession') {
        if (!sessionId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: `${envelope.type} 缺 sessionId`, revisionAtDecision: 0 }
        }
        if (envelope.type === 'renameSession') {
          const title = String((envelope.payload as { title?: string }).title ?? '')
          const res = await fetch(`/api/sessions/${sessionId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ title }),
          })
          return res.ok
            ? { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
            : { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_rename_failed', message: `POST /api/sessions/:id/rename ${res.status}`, revisionAtDecision: 0 }
        }
        const res = await fetch(`/api/sessions/${sessionId}/delete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token()}` },
        })
        return res.ok
          ? { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
          : { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_delete_failed', message: `POST /api/sessions/:id/delete ${res.status}`, revisionAtDecision: 0 }
      }
      return {
        commandId: envelope.commandId,
        status: 'rejected',
        reasonCode: `ocrc_unwired_${envelope.type}`,
        revisionAtDecision: 0,
      }
    },
    async initializeConversationV4(_rawClientHello: unknown) {
      // ocrc：无独立握手校验面，接受即完成
      return undefined
    },
    async setConnectionFlowStateV4(_params: unknown) {
      return undefined
    },
  }
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const name = String(prop)
      if (/^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/.test(name)) {
        return (_listener?: unknown) => {
          const un: any = () => {}
          un.dispose = () => {}
          return un
        }
      }
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`[ocrc-fork] zcodeAgentService.${name} 尚未接入 ocrc（N2）`))
    },
  })
}
