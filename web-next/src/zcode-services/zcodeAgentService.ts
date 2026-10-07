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
  const base = () => ({
    rowId: rowId,
    turnId: `turn-${turn}`,
    createdAt: Date.now(),
    createdAtSeq: rowId,
  })
  for (const c of cards) {
    if (c.kind === 'user') {
      turn += 1
      const now = c.ts ?? Date.now()
      rows.push({ ...base(), kind: 'turnHeader', origin: 'userInput', state: 'completedSuccess', startedAt: now })
      rowId += 1
      rows.push({ ...base(), kind: 'userInput', origin: 'realUser', text: c.text ?? '' })
      rowId += 1
    } else if (c.kind === 'assistant' && c.blocks) {
      for (const b of c.blocks) {
        if (b.type === 'text') {
          rows.push({ ...base(), kind: 'assistantText', text: b.text ?? '', state: 'complete', model: c.meta?.model })
          rowId += 1
        } else if (b.type === 'reasoning') {
          rows.push({ ...base(), kind: 'reasoning', text: b.text ?? '', state: 'complete' })
          rowId += 1
        } else if (b.type === 'tool') {
          rows.push({
            ...base(),
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

async function emitConversationSnapshot(taskId: string, topic: string, subscriptionId: string, deliveryKind: 'initial' | 'recovery' | 'online', fromSeq = 0): Promise<void> {
  const cards = await ocrcHistory(taskId)
  const rows = buildRows(cards)
  const seq = fromSeq + rows.length
  const frame = {
    topic,
    subscriptionId,
    fromSeq,
    toSeq: seq,
    sentAt: Date.now(),
    payload: {
      kind: 'snapshot' as const,
      snapshot: {
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
        config: { provider: '', model: '', thought: '', thoughtLevels: [], followupMode: 'queue' },
        usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        queue: { items: [], autoDrain: true },
        pendingInteractions: [],
        pendingCommands: [],
        backgroundWorks: [],
        goal: null,
        plan: null,
        rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
      },
    },
  }
  console.info('[ocrc-trace] emitConversationSnapshot rows =', rows.length, 'listeners =', frameListeners.size)
  if (!frameListeners.size) {
    // transport 尚未挂 upstream——延时重试（挂载晚于 ACK 的时序差）
    for (const delay of [300, 900, 2500, 5000]) {
      setTimeout(() => {
        console.info('[ocrc-trace] retry emit listeners =', frameListeners.size)
        for (const l of frameListeners) {
          try { l(frame) } catch { }
        }
      }, delay)
    }
    return
  }
  const check = conversationTopicFrameSchema.safeParse(frame)
  if (!check.success) {
    console.info('[ocrc-trace] frame zod FAIL:', JSON.stringify(check.error.issues.slice(0, 6).map((i) => ({ path: i.path.join('.'), msg: i.message }))))
    return
  }
  // onDynamicConversationFrame 下发的是 wire candidate 信封（deliveryKind 是
  // publisher 权威标记；store 的 awaitingInitial 只被 initial 帧消费）
  const wire = {
    wireVersion: 3,
    kind: 'complete' as const,
    deliveryKind,
    logicalFrameId: uuid(),
    logicalFrameOrdinal: 1,
    topic,
    subscriptionId,
    frame: check.data,
  }
  console.info('[ocrc-trace] wire candidate OK (' + deliveryKind + '), delivering to', frameListeners.size, 'listeners')
  lastSeqBySub.set(subscriptionId, seq)
  for (const l of frameListeners) {
    try { l(wire) } catch (e) { console.info('[ocrc-trace] listener threw', String(e).slice(0, 200)) }
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
        // post-response owned notification：ACK 先回，snapshot 异步补发
        void emitConversationSnapshot(sessionId, topic, ack.subscriptionId, 'initial', 0)
      }
      return { ack }
    },
    // 恢复流程要求回显同一 subscriptionId（世代一致性），并对 forceSnapshot
    // 重发一帧全新 snapshot（订阅登记里存有 sessionId/topic 映射）
    async resyncConversationV4(params: { subscriptionId?: string; forceSnapshot?: boolean }) {
      const subId = params?.subscriptionId
      const sub = subId ? subscriptions.get(subId) : undefined
      console.info('[ocrc-trace] resyncConversationV4 subId =', subId, 'sub =', Boolean(sub))
      // 续接已应用水位：fromSeq 必须等于 store 当前 seq，否则间隙规则整帧丢弃
      if (sub && subId) void emitConversationSnapshot(sub.sessionId, sub.topic, subId, 'recovery', lastSeqBySub.get(subId) ?? 0)
      return { ack: { subscriptionId: subId ?? `ocrc-sub-${uuid()}`, mode: 'snapshot', logEpoch: 'ocrc-1' } }
    },
    async unsubscribeConversationV4() {
      return undefined
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
