// zcode-services/zcodeAgentService.ts — ocrc-backed zcodeAgentService v4 面 (N2).
// hello/握手 + 订阅三件套 + **初始 snapshot 通知**：subscribeConversationV4 ACK
// 后异步取 ocrc 历史（cards → conversation rows），包成 v4 topic frame 经
// onDynamicConversationFrame 的监听器同步下发一次 —— ConversationTimeline 的
// assembler/decoder 由此渲染真实消息。发链（sendPrompt）在 zcodeTaskService。

import { conversationTopicFrameSchema, sessionsIndexTopicFrameSchema } from '@zcode/shared/zcode-protocol-v4/transport'
import { sessionsIndexTopic } from '@zcode/shared/zcode-protocol-v4'
import { dropAttachmentBytes, putAttachmentBlob, releaseWebFile, resolveWebFile, takeAttachmentBytes, toBase64 } from './webAttachments.js'
import {
  projectGoal, projectGoalAvailability, type GoalProjection, type OcrcGoalRecord,
} from './goalProjection.js'
import {
  fetchWorkflowDisplay, fetchWorkflowProjection, nextWorkflowRunsState, resolveToolCallIds, runsEqual,
} from './workflowProjection.js'
import { deriveSessionWorkflowActivity } from '@zcode/shared/zcode-protocol-v4/sessions-index-workflow-activity'
import type { WorkflowRunState, WorkflowRunsState } from '@zcode/shared/zcode-protocol-v4/workflow-runs'

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
interface OcrcBlock { type: string; text?: string; tool?: string; args?: string; status?: string; partId?: string; messageId?: string }
interface OcrcCard { kind: string; text?: string; ts?: number; blocks?: OcrcBlock[]; meta?: { model?: string; agent?: string }; thinkingText?: string; messageId?: string; origin?: string }

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

// 状态面板（PlanHud）的两块数据：ocrc 早就有 REST 面（/todo、/subagents），
// 只是快照里一直写 null——面板因此永远是空的。opencode 的 todo 是 snake_case
// status，ZCode 要 camelCase inProgress。
interface OcrcTodo { id?: string; content?: string; status?: string; priority?: string }
async function conversationPlan(sessionId: string): Promise<{ items: Array<{ id: string; content: string; status: string }>; updatedAt: number } | null> {
  try {
    const res = await fetch(`/api/session/${sessionId}/todo`, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return null
    const todos = (await res.json()) as OcrcTodo[]
    if (!Array.isArray(todos) || !todos.length) return null
    return {
      items: todos.map((t, i) => ({
        id: t.id ?? `todo-${i}`,
        content: t.content ?? '',
        status: t.status === 'in_progress' ? 'inProgress' : t.status === 'completed' ? 'completed' : 'pending',
      })),
      updatedAt: Date.now(),
    }
  } catch { return null }
}

interface OcrcSubagent {
  id: string
  title?: string
  /** Engine agent name — the directory renders it as subagentType. */
  agent?: string
  createdAt?: number
  updatedAt?: number
  /** Engine error latch → the directory's 'failed' ended-status. */
  error?: boolean
  done?: number
  total?: number
  busy?: boolean
}
async function conversationSubagents(sessionId: string): Promise<{ revision: number; childSessionIds: string[]; running: Array<Record<string, unknown>>; endedTotal: number } | undefined> {
  try {
    const res = await fetch(`/api/session/${sessionId}/subagents`, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return undefined
    const body = (await res.json()) as { subagents?: OcrcSubagent[] }
    const subs = body.subagents ?? []
    if (!subs.length) return undefined
    const running = subs.filter((x) => x.busy || (x.total ?? 0) > (x.done ?? 0))
    return {
      revision: 1,
      childSessionIds: subs.map((x) => x.id),
      running: running.map((x) => ({
        childSessionId: x.id,
        subagentType: 'task',
        title: x.title ?? x.id,
        summary: x.total ? `${x.done ?? 0}/${x.total}` : undefined,
        status: x.busy ? 'running' : 'waiting',
      })),
      endedTotal: subs.length - running.length,
    }
  } catch { return undefined }
}

/** 子代理目录页（右侧面板）的数据源。running/ended 的判定与 HUD 一致
 *  （busy 或 todo 未完成 = 运行中），ended 的 status 借引擎 error 闩如实
 *  区分 success/failed，不假装成功。vendor 的 zod schema 是 strict —— 只回
 *  它声明的键，多一个字段整个结果都会被拒。 */
async function listSessionSubagents(params: { sessionId?: string; endedLimit?: number }): Promise<{
  revision: number
  childSessionIds: string[]
  running: Array<Record<string, unknown>>
  ended: { total: number; items: Array<Record<string, unknown>> }
}> {
  const empty = { revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } }
  const sessionId = params?.sessionId
  if (!sessionId) return empty
  const limit = Math.max(1, Math.min(params?.endedLimit ?? 20, 100))
  // 每子会话一次 todo 读取：小页（≤20）带 todo 换 summary，大页跳过避免一串读。
  const withTodos = limit <= 20
  const res = await fetch(
    `/api/session/${encodeURIComponent(sessionId)}/subagents?limit=${limit}&todos=${withTodos ? 1 : 0}`,
    { headers: { Authorization: `Bearer ${token()}` } },
  )
  if (!res.ok) throw new Error(`[ocrc-fork] listSessionSubagents failed: ${res.status}`)
  const body = (await res.json()) as { subagents?: OcrcSubagent[] }
  const subs = body.subagents ?? []
  const isRunning = (x: OcrcSubagent) => Boolean(x.busy) || (x.total ?? 0) > (x.done ?? 0)
  const toItem = (x: OcrcSubagent): Record<string, unknown> => ({
    childSessionId: x.id,
    subagentType: x.agent || 'task',
    title: x.title || x.id,
    ...(x.total ? { summary: `${x.done ?? 0}/${x.total}` } : {}),
    ...(x.createdAt ? { startedAt: x.createdAt } : {}),
    ...(x.updatedAt ? { endedAt: x.updatedAt } : {}),
  })
  const running = subs.filter(isRunning)
  const ended = subs.filter((x) => !isRunning(x))
  return {
    revision: 1,
    childSessionIds: subs.map((x) => x.id),
    running: running.map((x) => ({ ...toItem(x), status: 'running' })),
    ended: {
      total: ended.length,
      items: ended.map((x) => ({ ...toItem(x), status: x.error ? 'failed' : 'success' })),
    },
  }
}

/** 运行中的 bash 工具行 → 后台任务条目（vendor 的 bash-output 面板入口，D2）。
 *  ocrc 没有独立的"后台任务"概念：**运行中的 bash 调用就是它**。只投影 running
 *  （语义与 vendor 的 status 枚举一致；已结束的输出仍走行内富化展示）。
 *  workId 编码 (messageId, partId)，backgroundBashOutputV4 靠它回取该 part 的输出。 */
function collectBackgroundWorks(rows: any[], workflowRuns?: WorkflowRunState[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const r of rows) {
    if (r?.kind !== 'toolCall' || r.status !== 'running') continue
    if (!/^(bash|shell|terminal)$/i.test(String(r.toolName ?? ''))) continue
    const messageId = String(r.__messageId ?? '')
    const partId = String(r.__partId ?? '')
    if (!messageId || !partId) continue
    out.push({
      workId: `ocrc-tool:${messageId}:${partId}`,
      kind: 'bash',
      title: String(r.inputText || r.toolName || 'bash').slice(0, 120) || 'bash',
      status: 'running',
      startedAt: Number(r.createdAtSeq ?? r.createdAt ?? Date.now()),
      cancellable: false,
      anchorRowId: Number(r.rowId) || null,
    })
  }
  // P4-1b: workflow runs are background work too, and the vendored contract fixes the
  // identity equation `workId ≡ runId` (that is what makes cancelBackgroundWork and
  // resumeWorkflowRun addressable from the same card). Only live runs appear: a settled
  // run is not background work any more, its result is in the run pane.
  for (const run of workflowRuns ?? []) {
    if (run.status !== 'running' && run.status !== 'pending') continue
    // The run's own card, when we can find it: it gives the entry its title (the
    // script's first line, as the card shows it) and its timeline anchor.
    const anchor = run.toolCallId ? rows.find((r) => r?.toolCallId === run.toolCallId) : undefined
    const title = String(anchor?.inputText ?? '').slice(0, 120).trim()
    out.push({
      workId: run.runId,
      kind: 'workflow',
      title: title || run.runId,
      status: 'running',
      // No anchor means no known start: the journal's `lastEventSequence` is a sequence
      // number, not a clock, so we state the present rather than invent an elapsed time.
      startedAt: Number(anchor?.createdAtSeq ?? anchor?.createdAt ?? Date.now()),
      cancellable: true,
      anchorRowId: Number(anchor?.rowId) || null,
    })
  }
  return out
}

/** 单条工具输出进浏览器的上限（ZCode schema 上限 150k；行要参与 diff，
 *  太大每次重建都做整串比较）。 */
const MAX_TOOL_OUTPUT_CHARS = 50_000

/** 工具结果的原始载体：/api/session/:id/message/:msgId 的 parts[].state。
 *  事件流不带 state.output（引擎只在 REST 上给），所以工具卡要显示"做了什么"
 *  必须回取一次原始消息。按 messageId 缓存，避免每轮重复拉。 */
interface OcrcToolPart { id?: string; tool?: string; state?: { status?: string; input?: unknown; output?: unknown; metadata?: unknown; title?: string } }
const rawMessageCache = new Map<string, { parts: Map<string, OcrcToolPart>; at: number }>()
/** 长缓存：定稿工具结果不变，只有流式中的还在变。60s + 条目上限（越过即全清——
 *  会话热路径上 Map 只增不减曾是泄漏点）。 */
const RAW_CACHE_TTL_MS = 60_000
const RAW_CACHE_MAX_ENTRIES = 64

async function rawToolParts(sessionId: string, messageId: string): Promise<Map<string, OcrcToolPart>> {
  const key = `${sessionId}:${messageId}`
  const hit = rawMessageCache.get(key)
  if (hit && Date.now() - hit.at < RAW_CACHE_TTL_MS) return hit.parts
  const byId = new Map<string, OcrcToolPart>()
  try {
    const res = await fetch(`/api/session/${sessionId}/message/${messageId}`, {
      headers: { Authorization: `Bearer ${token()}` },
    })
    if (res.ok) {
      const body = (await res.json()) as { parts?: Array<OcrcToolPart & { type?: string }> }
      for (const p of body.parts ?? []) {
        if (p?.type === 'tool' && p.id) byId.set(p.id, p)
      }
    }
  } catch { /* 拿不到就退化成无输出的卡片，不影响行渲染 */ }
  rawMessageCache.set(key, { parts: byId, at: Date.now() })
  if (rawMessageCache.size > RAW_CACHE_MAX_ENTRIES) rawMessageCache.clear()
  return byId
}

/** 引擎的 tool part → ZCode 的 output/display。
 *  - bash 有真 stdout → bash_output（ZCode 的 bash 专用渲染器）
 *  - 其余工具给 output.text（通用渲染器），**不臆造 file_diff**：edit/write 的
 *    patch 不在工具结果里，编一个 structuredPatch 就是假数据。 */
function toolOutputFor(toolName: string, part: OcrcToolPart | undefined): { text: string; display?: Record<string, unknown> } | undefined {
  if (!part?.state) return undefined
  const st = part.state
  const outText = typeof st.output === 'string' ? st.output : ''
  if (!outText && st.status !== 'completed') return undefined
  const meta = (st.metadata ?? {}) as Record<string, unknown>
  const tool = toolName.toLowerCase()
  if (tool === 'bash' || tool === 'bashoutput' || tool.includes('shell')) {
    const command = ((st.input ?? {}) as { command?: string }).command ?? st.title ?? ''
    const full = outText || (typeof meta.output === 'string' ? meta.output : '')
    const capped = full.length > MAX_TOOL_OUTPUT_CHARS
    const output = capped ? full.slice(0, MAX_TOOL_OUTPUT_CHARS) : full
    return {
      text: output,
      display: {
        kind: 'bash_output',
        output,
        truncated: meta.truncated === true || capped,
        ...(command ? { title: command } : {}),
      },
    }
  }
  return { text: outText.length > MAX_TOOL_OUTPUT_CHARS ? outText.slice(0, MAX_TOOL_OUTPUT_CHARS) : outText }
}

/** 把工具块的输出补进行里（就地改 rows）。只对真的带 messageId + 工具块的消息回取。
 *  N9-2：单次 rebuild 的**未命中**回取上限 3 条（命中的缓存行不受限）——流式期工具
 *  一多，每去抖窗都可能对全部工具消息各发一针，这里把每窗新增回取钉住；其余工具
 *  行本窗先渲染成无输出卡片，下一窗轮到它们。 */
const ENRICH_FETCH_BUDGET = 3

async function enrichToolRows(rows: any[], sessionId: string): Promise<void> {
  const byMessage = new Map<string, any[]>()
  for (const row of rows) {
    if (row.kind !== 'toolCall' || !row.__messageId) continue
    const list = byMessage.get(row.__messageId) ?? []
    list.push(row)
    byMessage.set(row.__messageId, list)
  }
  let fetchBudget = ENRICH_FETCH_BUDGET
  for (const [messageId, messageRows] of byMessage) {
    const cached = rawMessageCache.get(`${sessionId}:${messageId}`)
    const fresh = cached && Date.now() - cached.at < RAW_CACHE_TTL_MS
    if (!fresh && fetchBudget <= 0) {
      // 预算耗尽：本窗跳过（行保持 __messageId 不删，下窗重试），只拆内部字段。
      for (const row of messageRows) { delete row.__messageId; delete row.__partId }
      continue
    }
    if (!fresh) fetchBudget -= 1
    const parts = await rawToolParts(sessionId, messageId)
    for (const row of messageRows) {
      const part = row.__partId ? parts.get(row.__partId) : undefined
      const output = toolOutputFor(row.toolName, part)
      row.input = part?.state?.input
      if (output && output.text) row.output = output
      else if (part?.state?.status) {
        // 有终态但没有可显示输出：把状态如实带过去（不再把所有非 error 都当 success）
        row.status = part.state.status === 'completed' ? 'success' : part.state.status === 'error' ? 'error' : 'running'
      }
      delete row.__messageId
      delete row.__partId
    }
  }
}

// ── N9-1 行身份内容寻址 ─────────────────────────────────────────────
// rowId 从前的语义是「扁平列表里的位置序号」：任何中间插入（流式中块增长、
// 工具行后新出文本行）都会让后续所有行 rowId 位移，vendor 按 rowId 键控的
// upsert 把它们当「删+增」，这正是重复渲染的机制。改为**内容寻址**：rowId =
// 稳定身份（卡片 messageId + 块 partId/kind 序）的确定性哈希，新内容才拿新
// rowId，流式增长只 upsert 末行。哈希取 FNV-1a 32 位再乘位宽展开——同会话内
// 碰撞概率可忽略；全序仍由数组顺序承载，rowId 只作身份键。
function stableRowId(identity: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // 32 位无符号 → 正 int31（vendor rowId: z.number()；非负 int 才能进 range API）。
  return h >>> 1
}

/** 内容寻址 rowId 的身份串：卡片 messageId（缺省退 ts+kind——旧引擎消息无 id 时的
 *  兜底，只要同会话内唯一即可）+ 行在卡内的稳定序。 */
function cardIdentity(c: OcrcCard, index: number): string {
  return c.messageId ?? `${c.ts ?? 0}:${c.kind}:${index}`
}

/** N9-4 feedback 回读：localStorage `ocrc.feedback` 按 entityId（卡片 messageId）
 *  记 like/dislike，重建时带进 assistantText 行（vendor 行 schema 有 feedback 键，
 *  悬停按钮的高亮态读它）。存取失败一律静默——不渲染、不谎报。 */
function feedbackFor(entityId?: string): { feedback?: 'like' | 'dislike' } {
  if (!entityId) return {}
  try {
    const all = JSON.parse(localStorage.getItem('ocrc.feedback') ?? '{}') as Record<string, string>
    const v = all[entityId]
    return v === 'like' || v === 'dislike' ? { feedback: v } : {}
  } catch { return {} }
}

// ── P4-1b workflow 面 ────────────────────────────────────────────────
// 权威在 host（GET /api/workflow/projection 从 journal 现算），ws `workflow` 帧只是
// 「这条 run 动了」的提示——面板回读投影并与自己上一份 diff（单一时钟：run 状态只有
// 一个作者，socket 上不搬运第二份）。容器 revision 归消费侧，因为只有消费侧手里有
// 「上一份」；键级增量用 vendor 自己的 diffWorkflowRunsState 算，不自己写补丁。
const workflowRunsBySession = new Map<string, WorkflowRunsState>()

/** 七条只读查询的统一取数：非 2xx 一律抛（vendor 的查询族没有「部分结果」这一档，
 *  静默回空数组会让侧页显示成「这个 run 什么都没有」——那是假话）。 */
/** 同 workflowQuery，但把「失败信封」也当结果回（saved-workflow 族的失败是
 *  `{ok:false, reason}` 而不是异常——vendor 的 schema 就是这么定义的，抛出去反而让面板
 *  显示成「读取失败」而不是那句具体原因）。 */
async function workflowQueryOrFailure(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token()}` },
  })
  const body = await res.json().catch(() => ({ ok: false, reason: 'read_error' }))
  return body
}

async function workflowQuery(path: string): Promise<any> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) throw new Error(`workflow query ${path.split('?')[0]} → ${res.status}`)
  return await res.json()
}

/**
 * P4-2：把 run 的静态图挂到发起行的 `display` 上。面板的 run 侧页画的就是这张图，而它只
 * 从工具行读（`readWorkflowDisplay(raw.display)`）——不挂上去，侧页就写「没有这张工作流程图」。
 * 按 toolCallId 找行：join 已在 workflowRuns 里解析过。
 */
async function attachWorkflowDisplays(rows: any[], runs: WorkflowRunState[], sessionId: string): Promise<void> {
  const byToolCallId = new Map(runs.filter((r) => r.toolCallId).map((r) => [r.toolCallId!, r.runId]))
  for (const row of rows) {
    if (row?.kind !== 'toolCall' || !row.toolCallId) continue
    const runId = byToolCallId.get(String(row.toolCallId))
    if (!runId) continue
    const display = await fetchWorkflowDisplay(runId, sessionId)
    if (display) row.display = display
  }
}

/** 取一次投影并解析卡片 join 键。返回的是**本次读到的** run 列表；缓存里的容器由
 *  `workflowRunsContainer` 维护（它要保证 revision 单调）。
 *
 *  rows 必须显式传入：首次快照时 `lastRowsBySession` 还是空的（它由快照构建之后才写入），
 *  而 join 键只能对着行解析——漏了这一步，run 的 toolCallId 永远解不出来，卡永远不出现
 *  （实测：投影里 toolCallId=None，时间线上一张卡都没有）。 */
async function refreshWorkflowRuns(sessionId: string, rows?: any[]): Promise<WorkflowRunState[]> {
  const { runs, joins } = await fetchWorkflowProjection(sessionId)
  return resolveToolCallIds(runs, joins, rows ?? lastRowsBySession.get(sessionId) ?? [])
}

/** 会话当前的 workflowRuns 容器（缺席时按空容器起步）。 */
function workflowRunsContainer(sessionId: string, runs: WorkflowRunState[]): WorkflowRunsState {
  const cached = workflowRunsBySession.get(sessionId)
  if (cached && runsEqual(cached.runs, runs)) return cached
  const { state } = nextWorkflowRunsState(cached, runs)
  workflowRunsBySession.set(sessionId, state)
  return state
}

/** ws `workflow` 帧 / 快照重建后：重读投影，把**增量**推给订阅者。
 *  与 goal 面同一姿态——先更新缓存，再推 state.updated，最后让 rows 收敛。 */
async function applyWorkflowHint(sessionId: string): Promise<void> {
  const runs = await refreshWorkflowRuns(sessionId)
  const prior = workflowRunsBySession.get(sessionId)
  const { state, deltas } = nextWorkflowRunsState(prior, runs)
  workflowRunsBySession.set(sessionId, state)
  if (prior && deltas.length === 0) return
  const subs = [...subscriptions.entries()].filter(([, s]) => s.sessionId === sessionId)
  if (subs.length === 0) return
  for (const [subId, sub] of subs) {
    const lastSeq = lastSeqBySub.get(subId) ?? 0
    deliverWire(sub.topic, subId, lastSeq, lastSeq + 1, { kind: 'deltas', deltas }, 'online')
    lastSeqBySub.set(subId, lastSeq + 1)
  }
}

// ── N12 goal 面 ─────────────────────────────────────────────────────
// 权威记录在 host（GET /api/session/:id/goal），ws `goal` 帧推变化。这里只做两件
// 事：① 把 host 的四态投影成 vendor 六态（goalProjection.ts）；② 把每轮验收落成
// timelineMarker 行（必须带 lane='turnTailBoundary'，否则会被折进「已工作」折叠组）。
const GOAL_CONTINUATION_PREFIX = '[ocrc-goal-continuation]'

/** 会话 goal 缓存：记录 + verifying + 验收锚点（iteration → 锚定的 rowId）。 */
interface GoalUi { goal: OcrcGoalRecord | null; verifying: boolean; anchors: Map<number, number> }
const goalUiBySession = new Map<string, GoalUi>()

function goalUi(sessionId: string): GoalUi {
  let ui = goalUiBySession.get(sessionId)
  if (!ui) { ui = { goal: null, verifying: false, anchors: new Map() }; goalUiBySession.set(sessionId, ui) }
  return ui
}

async function fetchGoal(sessionId: string): Promise<GoalUi> {
  const ui = goalUi(sessionId)
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/goal`, { headers: { Authorization: `Bearer ${token()}` } })
    if (res.ok) {
      const body = (await res.json()) as { goal?: OcrcGoalRecord | null; verifying?: boolean }
      ui.goal = body.goal ?? null
      ui.verifying = body.verifying === true
    }
  } catch { /* 拉不到沿用缓存——goal 面降级，不阻断会话渲染 */ }
  return ui
}

/** 续跑轮的可见文本：首行是短展示行，提示词正文折进 epilogue 披露（vendor 的
 *  splitUserInputEpilogue 语义）。非续跑卡返回 null。 */
function goalContinuationView(raw: string): { text: string; epilogueStart?: number } | null {
  if (!raw.startsWith(GOAL_CONTINUATION_PREFIX)) return null
  const rest = raw.slice(GOAL_CONTINUATION_PREFIX.length).replace(/^\s+/, '').replace(/\s+$/, '')
  const nl = rest.indexOf('\n')
  const display = (nl === -1 ? rest : rest.slice(0, nl)).trim()
  return display ? { text: rest, epilogueStart: display.length } : { text: rest }
}

/** 会话可用性（snapshot 与 state.updated 共用同一份，避免两处漂移）：
 *  非 goal 项恒 true（ocrc 不做这些门），goal 两项按投影态派生。 */
function availabilityState(goalStatus: GoalProjection['status'] | null) {
  return {
    fork: { allowed: true as const },
    compact: { allowed: true as const },
    switchModelConfig: { allowed: true as const },
    setFollowupMode: { allowed: true as const },
    queueEdit: { allowed: true as const },
    sendQueuedNow: { allowed: true as const },
    ...projectGoalAvailability(goalStatus),
  }
}

function isGoalContinuationCard(c: OcrcCard): boolean {
  return c.origin === 'goalContinuation' || (c.text ?? '').startsWith(GOAL_CONTINUATION_PREFIX)
}

/** goalVerify marker 行。rowId 按 (targetId, iteration) 键控：running 与终态同 id，
 *  终态 upsert 覆盖 running —— 与 vendor 的 lifecycleKey upsert 同构。 */
function goalVerifyRows(goal: GoalProjection, verifying: boolean): Array<{ iteration: number; row: any }> {
  const mk = (iteration: number, outcome: string, detail?: string) => ({
    rowId: stableRowId(`goalVerify|${goal.targetId}|${iteration}`),
    entityId: `goalVerify:${goal.targetId}:${iteration}`,
    createdAt: goal.verifications.find((v) => v.iteration === iteration)?.at ?? Date.now(),
    kind: 'timelineMarker',
    lane: 'turnTailBoundary',
    marker: { type: 'goalVerify', iteration, outcome, ...(detail ? { detail } : {}) },
  })
  const out = goal.verifications.map((v) => ({ iteration: v.iteration, row: mk(v.iteration, v.outcome, v.reason) }))
  if (verifying && !goal.verifications.some((v) => v.iteration === goal.iteration)) {
    out.push({ iteration: goal.iteration, row: mk(goal.iteration, 'running') })
  }
  return out
}

function buildRows(cards: OcrcCard[], goalArg?: GoalUi): any[] {
  const rows: any[] = []
  let turn = 0
  // 续跑轮的起始行下标（第 k 个续跑轮 → continuationStarts[k-1]）：冷启动时用它
  // 把第 N 轮的验收 marker 钉在「第 N+1 轮开始之前」，即第 N 轮的轮尾。
  const continuationStarts: number[] = []
  // 时间戳必须取卡片自身的 ts：live 路径按行内容 diff（row.upserted/row.appended），
  // Date.now() 会让每次重建的 rows 全部不同，diff 退化成全量 upsert。
  // rowId 由内容身份派生（见 stableRowId）；turnId 维持 `turn-N` 计数——vendor 用它
  // 作 turn 聚合键，不解析数字。
  const base = (ts: number, identity: string, kindTag: string, entityId?: string) => ({
    rowId: stableRowId(`${identity}|${kindTag}`),
    turnId: `turn-${turn}`,
    ...(turn > 0 ? { productTurnId: `turn-${turn}` } : {}),
    ...(entityId ? { entityId } : {}),
    createdAt: ts,
    // createdAtSeq 曾等于位置 rowId；现在给单调行计数（vendor 只把它当时间戳用）。
    createdAtSeq: rows.length + 1,
  })
  for (let ci = 0; ci < cards.length; ci++) {
    const c = cards[ci]!
    const ts = c.ts ?? 0
    // 块身份按 kind 计数（卡内第 n 个 text/reasoning/tool），不用扁单位序——
    // 否则定稿补插的 thinking 行会把后续 text 块身份挤位，重演 rowId 位移。
    let textI = 0
    let reasoningI = 0
    let toolI = 0
    if (c.kind === 'user') {
      turn += 1
      const identity = cardIdentity(c, ci)
      // 续跑轮：origin='goalContinuation' 让 vendor 把它排除在「真实用户输入」之外
      // （轮次导航/分享/输入投影都只认 realUser），气泡正文只显示短展示行，整段
      // 提示词折进 epilogue 披露。这样既看得到「目标又跑了一轮」，也没有幽灵气泡。
      const cont = isGoalContinuationCard(c) ? goalContinuationView(c.text ?? '') : null
      if (cont) continuationStarts.push(rows.length)
      rows.push({
        ...base(ts, identity, 'header'),
        kind: 'turnHeader',
        origin: cont ? 'goalContinuation' : 'userInput',
        state: 'completedSuccess',
        startedAt: ts,
      })
      rows.push({
        ...base(ts, identity, 'input', c.messageId),
        kind: 'userInput',
        origin: cont ? 'goalContinuation' : 'realUser',
        text: cont ? cont.text : (c.text ?? ''),
        ...(cont?.epilogueStart !== undefined ? { epilogueStart: cont.epilogueStart } : {}),
      })
    } else if (c.kind === 'assistant' && c.blocks) {
      const identity = cardIdentity(c, ci)
      // 定稿卡片的 blocks 是 reasoning-free（TG/纯文本渲染器不该看到思考），思考被收进
      // 卡片的 thinkingText。此前桥接层只映射 blocks → 回合结束、卡片定稿后 /z/ 里的
      // 推理块就消失了（流式期有、定稿后没了）。补一条 reasoning 行。固定 tag
      // `thinking`（每卡至多一条合成行），不占 text/reasoning 计数。
      if (c.thinkingText && !c.blocks.some((b) => b.type === 'reasoning')) {
        rows.push({ ...base(ts, identity, 'thinking', c.messageId), kind: 'reasoning', text: c.thinkingText, state: 'complete' })
      }
      let cardText = ''
      for (const b of c.blocks) {
        if (b.type === 'text') {
          cardText += b.text ?? ''
          rows.push({ ...base(ts, identity, `text-${textI++}`, c.messageId), kind: 'assistantText', text: b.text ?? '', state: 'complete', model: c.meta?.model, ...feedbackFor(c.messageId) })
        } else if (b.type === 'reasoning') {
          rows.push({ ...base(ts, identity, `reasoning-${reasoningI++}`, c.messageId), kind: 'reasoning', text: b.text ?? '', state: 'complete' })
        } else if (b.type === 'tool') {
          // 身份优先块自身 partId；无 partId 的旧引擎块退 kind 内序 `raw-N`
          // （按 tool 块计数，与有无 partId 无关——否则混块序列在两次重建间跳号）。
          rows.push({
            ...base(ts, identity, `tool-${b.partId ?? `raw-${toolI++}`}`),
            kind: 'toolCall',
            toolCallId: b.partId ? `tool-${b.partId}` : `tool-${toolI}`,
            toolName: b.tool ?? 'tool',
            // running 不再塌成 success：否则执行中的工具当场显示"已完成"，没有转圈。
            status: b.status === 'error' ? 'error' : b.status === 'running' ? 'running' : 'success',
            inputText: (b.args ?? '').slice(0, 4000),
            __messageId: b.messageId,
            __partId: b.partId,
          })
        }
      }
      // ── 计划投影（ExitPlanMode 行）─────────────────────────────────
      // 核实：opencode 的 plan agent **没有** ExitPlanMode 工具（实测该 agent 只用
      // bash/glob/grep/question + 正文 Markdown）；而 vendor 的计划面族——时间线计划卡
      // （toolIdentity 归 switch-mode family）、状态面板「计划」目录、计划详情侧页——
      // 全部以 `toolName === 'ExitPlanMode'` 的行作锚点。把 plan 回合的产出正文投影成
      // 该形状，计划才有可审阅的落点（卡片可点开详情侧页）。
      // toolCallId 前缀 `plan-` 标明这是 ocrc 的投影、不是引擎的工具调用；不伪造
      // 工具执行——status 固定 success（回合已定稿），markdown 放在 input.plan
      // （vendor extractPlanToolCallContent 的读取键）。
      if (c.meta?.agent === 'plan' && cardText.trim()) {
        const planText = cardText.trim()
        rows.push({
          ...base(ts, identity, 'exitplan', c.messageId),
          kind: 'toolCall',
          toolCallId: `plan-${c.messageId ?? identity}`,
          toolName: 'ExitPlanMode',
          status: 'success',
          input: { plan: planText },
          inputText: JSON.stringify({ plan: planText }),
        })
      }
    }
  }
  insertGoalVerifyRows(rows, continuationStarts, goalArg)
  return rows
}

/** 把 goalVerify marker 行插到各自轮尾。锚点优先级：① 实时锚（ws goal 帧到达时
 *  记的行尾）；② 冷启动回落（第 N+1 个续跑轮起始行的前一行）；③ 都无 → 落尾。
 *  锚点行的 turnId/createdAtSeq 复制给 marker，让它与所在轮同组、时序单调。 */
function insertGoalVerifyRows(rows: any[], continuationStarts: number[], goalArg?: GoalUi): void {
  if (!goalArg?.goal) return
  const projected = projectGoal(goalArg.goal, goalArg.verifying, goalArg.anchors)
  const markers = goalVerifyRows(projected, goalArg.verifying)
  if (!markers.length) return
  const anchorOf = (iteration: number): number | undefined => {
    const live = goalArg.anchors.get(iteration)
    if (live !== undefined) return live
    const nextStart = continuationStarts[iteration]
    if (nextStart !== undefined && nextStart > 0) return rows[nextStart - 1]!.rowId
    return undefined
  }
  const groups = new Map<number | 'tail', any[]>()
  for (const m of markers) {
    const key = anchorOf(m.iteration) ?? 'tail'
    const list = groups.get(key) ?? []
    list.push(m.row)
    groups.set(key, list)
  }
  // 落尾的 marker 没有锚行可复制身份，就用末行的（rowBaseFields 要求 turnId/
  // createdAtSeq 在场——缺了整帧会被 zod 丢掉，goal 面直接不出现）。
  const last = rows[rows.length - 1]
  let tailSeq = (last?.createdAtSeq ?? 0) + 1
  const stamp = (m: any, r: any) => {
    m.turnId = r?.turnId ?? 'turn-1'
    if (r?.productTurnId) m.productTurnId = r.productTurnId
    m.createdAtSeq = r ? r.createdAtSeq : tailSeq++
  }
  const out: any[] = []
  for (const r of rows) {
    out.push(r)
    const g = groups.get(r.rowId)
    if (!g) continue
    for (const m of g) { stamp(m, r); out.push(m) }
    groups.delete(r.rowId)
  }
  const tail = groups.get('tail')
  if (tail) for (const m of tail) { stamp(m, last); out.push(m) }
  // 锚点已消费但锚行不在（历史被截断）→ 也落尾，宁可位置略偏也不丢 marker。
  for (const [k, g] of groups) if (k !== 'tail') for (const m of g) { stamp(m, last); out.push(m) }
  rows.splice(0, rows.length, ...out)
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
  const [sessionTitle, cards, providers, overrides] = await Promise.all([
    fetch('/api/sessions', { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ id: string; title?: string }>>) : []))
      .then((list) => list.find((x) => x.id === taskId)?.title ?? '')
      .catch(() => ''),
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
  const [plan, subagents, goalUiState] = await Promise.all([
    conversationPlan(taskId),
    conversationSubagents(taskId),
    fetchGoal(taskId),
  ])

  console.info(
    '[ocrc-trace] snapshot subagents =',
    subagents ? `children=${subagents.childSessionIds.length} running=${subagents.running.length} ended=${subagents.endedTotal}` : '(none)',
  )
  const rows = buildRows(cards, goalUiState)
  // P4-1b: this session's workflow runs, resolved against the rows we just built. Both
  // this and the background-work collection must happen BEFORE enrichToolRows — the card
  // join needs the tool rows' `toolCallId` + message id, and enrichment strips those
  // (they are row-internal details).
  const workflowRuns = await refreshWorkflowRuns(taskId, rows)
  const backgroundWorks = collectBackgroundWorks(rows, workflowRuns)
  await attachWorkflowDisplays(rows, workflowRuns, taskId)
  await enrichToolRows(rows, taskId)
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
    // goal 门对齐 vendor projection-state.ts：pause 只在目标可续时开，resume 只在
    // paused 时开；无 goal 时带 noGoalToPause/Resume 原因码（驱动禁用态 tooltip）。
    availability: availabilityState(goalUiState.goal ? projectGoal(goalUiState.goal, goalUiState.verifying, goalUiState.anchors).status : null),
    inputRouting: { mode: 'startNow' },
    config: { provider: curProvider, model: curModel, thought: curThought, thoughtLevels: providers.find((p) => p.id === curProvider)?.models?.find((m) => m.id === curModel)?.variants ?? [], followupMode: 'queue' },
    usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks,
    // P4-1b: the run projection. Absent (not an empty container) when the session has no
    // runs — the vendored reading of a missing key is "nothing to show", and the sidebar
    // derives its rail from the same key.
    ...(workflowRuns.length > 0 ? { workflowRuns: workflowRunsContainer(taskId, workflowRuns) } : {}),
    // meta.title：schema 默认值是空串，而空串不走 `??` 回退 —— 分享标题取
    // snapshot.meta.title，缺它就恒为空 → 「生成分享链接」永久禁用（隔离栈实测根因）。
    meta: { title: sessionTitle || 'ocrc 会话', titleSource: sessionTitle ? 'generated' as const : 'default' as const },
    goal: goalUiState.goal ? projectGoal(goalUiState.goal, goalUiState.verifying, goalUiState.anchors) : null,
    plan,
    ...(subagents ? { subagents } : {}),
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

/** rows diff（N9-1 键控版）：rowId 现在是内容身份——同位置 rowId 不同 =
 *  中间插入/删除（协议无 row.inserted，键控补丁表达不了）→ null 全量收敛。
 *  行内容对比用按键浅比较，不再 JSON.stringify 整行——工具 output 可到 50k，
 *  整行序列化是热路径上第二处 O(N×size) 开销。 */
const ROW_DIFF_KEYS = ['kind', 'text', 'state', 'status', 'toolCallId', 'toolName', 'inputText', 'entityId', 'feedback', 'model', 'turnId'] as const

function rowShallowEqual(p: any, n: any): boolean {
  if (p === n) return true
  if (!p || !n || p.kind !== n.kind) return false
  for (const k of ROW_DIFF_KEYS) {
    if ((p as any)[k] !== (n as any)[k]) return false
  }
  // output 只比 text（display 对象每轮重建引用都不同，比 text 即可）。
  const po = p.output, no = n.output
  if ((po === undefined) !== (no === undefined)) return false
  if (po && no && po.text !== no.text) return false
  return true
}

/** rows 前缀 diff：返回增量 op 列表；前缀失配/截断返回 null（调用方回退全量快照）。 */
function diffRows(prev: any[], next: any[]): Array<Record<string, unknown>> | null {
  if (next.length < prev.length) return null
  const n = Math.min(prev.length, next.length)
  for (let i = 0; i < n; i++) {
    if (prev[i]!.rowId !== next[i]!.rowId) return null
  }
  const upserts: Array<Record<string, unknown>> = []
  const appends: Array<Record<string, unknown>> = []
  for (let i = 0; i < next.length; i++) {
    const p = prev[i]
    const nr = next[i]!
    if (p === undefined) {
      appends.push({ op: 'row.appended', row: nr })
    } else if (!rowShallowEqual(p, nr)) {
      upserts.push({ op: 'row.upserted', row: nr })
    }
  }
  // 施加序：先 upsert（已存在 rowId 原位替换）后 append（落尾）。
  return upserts.length + appends.length > 0 ? [...upserts, ...appends] : []
}

/** goal 帧落缓存：更新记录 + 把每轮验收锚到「帧到达时的行尾」（验收发生在回合末，
 *  此刻的行尾就是那一轮的轮尾），再推 state.updated 并触发一次 rows 收敛。
 *  verifying 的两拍（开始/终态）都会走这里，所以 running marker 能被终态 upsert。 */
function applyGoalFrame(sessionId: string, frame: { goal?: OcrcGoalRecord | null; verifying?: boolean }): void {
  const ui = goalUi(sessionId)
  ui.goal = frame.goal ?? null
  ui.verifying = frame.verifying === true
  if (!ui.goal) ui.anchors.clear()
  const tail = lastRowsBySession.get(sessionId)?.slice(-1)[0]?.rowId
  if (ui.goal && tail !== undefined) {
    for (const v of ui.goal.verifications) if (!ui.anchors.has(v.iteration)) ui.anchors.set(v.iteration, tail)
    if (ui.verifying && !ui.anchors.has(ui.goal.iteration)) ui.anchors.set(ui.goal.iteration, tail)
  }
  goalUiBySession.set(sessionId, ui)
  publishGoalState(sessionId, ui)
  scheduleLive(sessionId)
}

/** state.updated：goal + 完整 availability 一次补丁（delta.ts 的 statePatchSchema；
 *  availability 是整键替换，所以必须带齐八个键）。 */
function publishGoalState(sessionId: string, ui: GoalUi): void {
  const subs = [...subscriptions.entries()].filter(([, s]) => s.sessionId === sessionId)
  if (!subs.length) return
  const goal = ui.goal ? projectGoal(ui.goal, ui.verifying, ui.anchors) : null
  const patch = { goal, availability: availabilityState(goal?.status ?? null) }
  for (const [subId, sub] of subs) {
    const lastSeq = lastSeqBySub.get(subId) ?? 0
    deliverWire(sub.topic, subId, lastSeq, lastSeq + 1, { kind: 'deltas', deltas: [{ op: 'state.updated', patch }] }, 'online')
    lastSeqBySub.set(subId, lastSeq + 1)
  }
}

async function liveUpdate(sessionId: string): Promise<void> {
  const subs = [...subscriptions.entries()].filter(([, s]) => s.sessionId === sessionId)
  const prevRows = lastRowsBySession.get(sessionId)
  if (!subs.length || !prevRows) return
  const cards = await ocrcHistory(sessionId).catch(() => null)
  if (!cards) return
  const nextRows = buildRows(cards, goalUi(sessionId))
  // The display is a pure function of the script, so a row rebuilt live gets it from the
  // cache — but a run started since the last snapshot needs the fetch to happen here too,
  // or its card would only gain its picture on the next full snapshot.
  await attachWorkflowDisplays(nextRows, await refreshWorkflowRuns(sessionId, nextRows), sessionId)
  await enrichToolRows(nextRows, sessionId)
  const deltas = diffRows(prevRows, nextRows)
  // diff 空即不发：此前用整行 stringify 判等守卫，浅比较版直接以 deltas.length 为准。
  if (deltas && deltas.length === 0) return
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
  // N9-2：400→250ms——refetch 本身已由内容寻址 diff + 缓存/预算减负，去抖再收紧
  // 一档换来更跟手的流式呈现（实测基线节律 ~1s/窗，250ms 不增加每窗成本）。
  liveTimers.set(sessionId, setTimeout(() => {
    liveTimers.delete(sessionId)
    void liveUpdate(sessionId)
  }, 250))
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
    if (!sid) return
    // 相位先于订阅范围更新：sessions-index 的订阅者要的是"任一会话的状态"，
    // 不只是当前打开的会话（侧栏状态点）。
    if (msg.type === 'session.status') publishIndexStatus(sid, (msg as { busy?: boolean }).busy === true)
    if (!watchedSessions.has(sid)) return
    // goal 帧：先落缓存（含把每轮验收锚到当前行尾），再推 state.updated 让 goal 面
    // 与 availability 立刻刷新；rows 侧由 scheduleLive 的 diff 补上 marker 行。
    if (msg.type === 'goal') { applyGoalFrame(sid, msg as { goal?: OcrcGoalRecord | null; verifying?: boolean }); return }
    // P4-1b：workflow 帧只是「这条 run 动了」。回读投影算增量（单一时钟），再让 rows
    // 收敛一次——backgroundWorks 里的 run 条目、以及 run 卡的状态点都从 rows/投影来。
    if (msg.type === 'workflow') { void applyWorkflowHint(sid).then(() => scheduleLive(sid)); return }
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

// ── sessions-index 订阅（侧栏任务列表活性：相位点/标题/最后活动）──
// 此前 subscribeSessionsIndexV4 走幽灵 → await 拿到函数再取 .ack 直接 TypeError，
// 侧栏永远只有静态列表、没有运行中转圈/错误点。这里给它真 snapshot + 增量。
// 相位来源：ocrc 的 /api/sessions 不带 busy，但 ws 的 session.status 帧带——
// 本地维护 busyBySession，status 变化即向该 workspace 的订阅推 session.upserted。
interface OcrcIndexSession { id: string; title?: string; lastActiveAt?: number; directory?: string; error?: boolean; unread?: boolean }
const busyBySession = new Map<string, boolean>()
const indexListeners = new Map<string, Set<(frame: any) => void>>()
const indexSubs = new Map<string, { workspaceId: string; topic: string }>()
const indexLastSeq = new Map<string, number>()

function indexListenersFor(workspaceId: string): Set<(frame: any) => void> {
  let set = indexListeners.get(workspaceId)
  if (!set) { set = new Set(); indexListeners.set(workspaceId, set) }
  return set
}

function toIndexSummary(
  s: OcrcIndexSession,
  workspaceId: string,
  workflowRunsBySessionId?: Map<string, WorkflowRunState[]>,
): Record<string, unknown> {
  const busy = busyBySession.get(s.id) === true
  const ts = s.lastActiveAt ?? Date.now()
  // P4-1b 侧栏轨道：vendor 的派生函数要 `workflowRuns` + `backgroundWorks`。索引面没有
  // 其它会话的 rows，所以 backgroundWorks 为空——代价只是 run 行没有名字与开始时刻
  // （schema 两者都可缺席），不是假数据。
  const runs = workflowRunsBySessionId?.get(s.id)
  const activity = runs && runs.length > 0
    ? deriveSessionWorkflowActivity({ workflowRuns: { revision: 0, runs }, backgroundWorks: [] })
    : undefined
  return {
    sessionId: s.id,
    workspaceId,
    title: s.title || '(未命名)',
    phase: busy ? 'running' : s.error ? 'error' : 'completedSuccess',
    sessionEnded: !busy,
    hasBackgroundWork: false,
    lastActivityAt: ts,
    createdAt: ts,
    ...(activity ? { workflowActivity: activity } : {}),
  }
}

async function buildIndexSnapshot(workspaceId: string): Promise<{ sessions: Array<Record<string, unknown>>; logEpoch: string } | null> {
  try {
    const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return null
    const sessions = (await res.json()) as OcrcIndexSession[]
    // One host read for every session's runs (the projection is bounded to the vendored
    // `maxRuns`, which is more than the sidebar can draw anyway).
    const { runs, sessions: owners } = await fetchWorkflowProjection()
    const bySession = new Map<string, WorkflowRunState[]>()
    for (const run of runs) {
      const owner = owners[run.runId]
      if (!owner) continue
      const list = bySession.get(owner) ?? []
      list.push(run)
      bySession.set(owner, list)
    }
    return { sessions: sessions.map((x) => toIndexSummary(x, workspaceId, bySession)), logEpoch: 'ocrc-1' }
  } catch { return null }
}

function indexFrameListenersFor(workspaceId: string): Set<(frame: any) => void> { return indexListenersFor(workspaceId) }

function deliverIndexWire(
  topic: string,
  workspaceId: string,
  subscriptionId: string,
  fromSeq: number,
  toSeq: number,
  payload: { kind: 'snapshot'; snapshot: unknown } | { kind: 'deltas'; deltas: unknown[] },
  deliveryKind: 'initial' | 'recovery' | 'online',
): void {
  const frame = { topic, subscriptionId, fromSeq, toSeq, sentAt: Date.now(), payload }
  const check = sessionsIndexTopicFrameSchema.safeParse(frame)
  if (!check.success) {
    console.info('[ocrc-trace] index frame zod FAIL:', JSON.stringify(check.error.issues.slice(0, 6).map((i) => ({ path: i.path.join('.'), msg: i.message }))))
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
  for (const l of indexFrameListenersFor(workspaceId)) {
    try { l(wire) } catch { /* 单个监听器异常不影响其他订阅 */ }
  }
}

async function emitIndexSnapshot(workspaceId: string, subscriptionId: string, topic: string, deliveryKind: 'initial' | 'recovery' | 'online'): Promise<void> {
  const built = await buildIndexSnapshot(workspaceId)
  if (!built) return
  const seq = built.sessions.length
  indexLastSeq.set(subscriptionId, seq)
  deliverIndexWire(
    topic, workspaceId, subscriptionId, 0, seq,
    { kind: 'snapshot', snapshot: { protocolVersion: 1, workspaceId, logEpoch: built.logEpoch, sessions: built.sessions } },
    deliveryKind,
  )
}

/** session.status 帧 → 相位变化 → 给该 workspace 的订阅推一条 session.upserted。 */
function publishIndexStatus(sessionId: string, busy: boolean): void {
  const changed = busyBySession.get(sessionId) !== busy
  busyBySession.set(sessionId, busy)
  if (!changed) return
  for (const [subId, sub] of indexSubs) {
    void (async () => {
      const built = await buildIndexSnapshot(sub.workspaceId)
      const summary = built?.sessions.find((x: any) => x.sessionId === sessionId)
      if (!summary) return
      const lastSeq = indexLastSeq.get(subId) ?? 0
      deliverIndexWire(sub.topic, sub.workspaceId, subId, lastSeq, lastSeq + 1, { kind: 'deltas', deltas: [{ op: 'session.upserted', session: summary }] }, 'online')
      indexLastSeq.set(subId, lastSeq + 1)
    })()
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
    // 「加载更早」：store 以窗口首行 rowId 作游标向更早分页。行号由 buildRows 从
    // 完整历史顺序生成，只要历史不变就稳定（新消息只往尾部追加）——所以按
    // rowId < beforeRowId 取尾部 limit 行即可，无需服务端游标。
    async conversationRowsRangeV4(params: { sessionId: string; beforeRowId?: number; limit: number }) {
      const cards = await ocrcHistory(params.sessionId)
      const rows = buildRows(cards)
      await enrichToolRows(rows, params.sessionId)
      const before = params.beforeRowId
      const earlier = before === undefined ? rows : rows.filter((r) => r.rowId < before)
      const page = earlier.slice(Math.max(0, earlier.length - Math.max(1, params.limit)))
      return {
        rows: page,
        atSeq: rows.length,
        atRevision: 1,
        atLogEpoch: 'ocrc-1',
        // 还有更早的行 = 本次没取到的部分非空
        hasMore: earlier.length > page.length,
      }
    },
    // 计划目录（状态面板「计划」区 + 计划详情侧页的目录源）。vendor 的
    // v4ConversationPlansResultSchema：plans = 当前分支终态 ExitPlanMode 行、rowId 降序
    // （最新优先），atLogEpoch 必须与快照一致（store 用它对账，不匹配整体丢弃）。
    // 数据与时间线计划卡同源——同一份 buildRows 结果过滤，不另开一条取数路径。
    async conversationPlansV4(params: { sessionId: string }) {
      const cards = await ocrcHistory(params.sessionId)
      const rows = buildRows(cards)
      const plans = rows
        .filter((r) => r.kind === 'toolCall' && r.toolName === 'ExitPlanMode' &&
          (r.status === 'success' || r.status === 'error' || r.status === 'cancelled'))
        .sort((a, b) => b.rowId - a.rowId)
      return { plans, atSeq: rows.length, atLogEpoch: 'ocrc-1' }
    },
    // 子代理目录页（右侧面板）：读 /api/session/:id/subagents 并组装 vendor 的
    // ZCodeSessionSubagentsResult。此前整条方法缺失 → Proxy 兜底 reject →
    // 目录页 ended 段显示「无法加载子智能体目录」。
    async listSessionSubagents(params: { sessionId?: string; endedLimit?: number; endedCursor?: string }) {
      return listSessionSubagents(params)
    },
    // 后台 bash 输出页（D2）：workId 由 snapshot 的 backgroundWorks 编码
    // （ocrc-tool:<messageId>:<partId>），回取该工具 part 的 state.output。
    // vendor 的 schema 要求 outputPath —— ocrc 没有输出文件，这里给 URI 而不是
    // 编造一个盘上路径（面板只把它当标题显示）。
    async backgroundBashOutputV4(params: { sessionId?: string; workId?: string }) {
      const workId = String(params?.workId ?? '')
      const matched = workId.match(/^ocrc-tool:([^:]+):(.+)$/)
      const sessionId = String(params?.sessionId ?? '')
      if (!matched || !sessionId) return { kind: 'unsupported' as const, workId }
      const [, messageId, partId] = matched
      const res = await fetch(
        `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
        { headers: { Authorization: `Bearer ${token()}` } },
      )
      if (!res.ok) return { kind: 'read_failed' as const, workId }
      const raw = (await res.json()) as { parts?: Array<{ id?: string; type?: string; state?: { status?: string; output?: unknown } }> }
      const part = (raw.parts ?? []).find((p) => p.id === partId)
      if (!part) return { kind: 'unavailable' as const, workId }
      const text = typeof part.state?.output === 'string' ? part.state.output : ''
      const max = 8192 // BACKGROUND_BASH_OUTPUT_MAX_BYTES
      const truncated = text.length > max
      const status = part.state?.status === 'error' ? ('failed' as const)
        : part.state?.status === 'completed' ? ('completed' as const)
          : ('running' as const)
      return {
        kind: 'output' as const,
        workId,
        status,
        output: truncated ? text.slice(0, max) : text,
        truncated,
        outputPath: `ocrc://tool-output/${partId}`,
      }
    },
    // ── V4 附件上传家族（N7-1）：内存暂存，commit 后以 ocrc-att:// 引用发给 sendText ──
    // 校验和只用于服务端去重；ocrc 是单进程内存暂存，不做跨上传去重，直接收。
    async attachmentBeginV4(params: { uploadId: string; sessionId: string; fileName: string; mime: string; totalBytes: number; totalChunks: number }) {
      if (!params?.uploadId || !params.sessionId) throw new Error('fault.attachment.invalidParams')
      if ((params.totalBytes ?? 0) > 20 * 1024 * 1024) throw new Error('proto.payloadTooLarge')
      return { uploadId: params.uploadId, state: 'staging' as const, nextChunkIndex: 0 }
    },
    async attachmentChunkV4(params: { uploadId: string; sessionId: string; chunkIndex: number; dataBase64: string }) {
      if (!params?.uploadId) throw new Error('fault.attachment.invalidParams')
      const bin = atob(params.dataBase64 ?? '')
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const prev = takeAttachmentBytes(params.uploadId)
      const merged = new Blob([prev ?? new Blob([]), bytes])
      // 回写同一 id（take 不删除；putAttachmentBlob 会加前缀，这里手动维护裸 id）
      putAttachmentBlob(params.uploadId, merged)
      dropAttachmentBytes(params.uploadId)
      return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 }
    },
    async attachmentCommitV4(params: { uploadId: string; sessionId: string }) {
      const blob = takeAttachmentBytes(params?.uploadId ?? '')
      if (!blob) throw new Error('fault.attachment.unknownUpload')
      const ref = putAttachmentBlob(params.uploadId, blob)
      return { ref }
    },
    async attachmentAbortV4(params: { uploadId: string }) {
      if (params?.uploadId) dropAttachmentBytes(params.uploadId)
      return {}
    },
    /** staged 字节的回读（预览/补传）；ref 必须是本页 commit 出来的。 */
    async attachmentReadV4(params: { ref: string; offset?: number; limit?: number }) {
      const blob = resolveWebFile(params?.ref ?? '')
      if (!blob) throw new Error('fault.attachment.unknownRef')
      const buf = new Uint8Array(await blob.arrayBuffer())
      const start = Math.max(0, Math.min(params?.offset ?? 0, buf.length))
      const end = params?.limit ? Math.min(buf.length, start + params.limit) : buf.length
      let bin = ''
      for (let i = start; i < end; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, Math.min(i + 0x8000, end)))
      const mime = (blob as Blob).type || 'application/octet-stream'
      return { dataBase64: btoa(bin), mediaType: mime, totalBytes: buf.byteLength, offset: start, truncated: false }
    },

    // ── sessions-index 三件套（侧栏活性）──
    async subscribeSessionsIndexV4(params: { workspacePath?: string; workspaceIdentity?: string }) {
      const workspaceId = params?.workspaceIdentity?.trim() || params?.workspacePath || ''
      const ack = { subscriptionId: `ocrc-idx-${uuid()}`, mode: 'snapshot', logEpoch: 'ocrc-1' }
      if (!workspaceId) return { ack }
      const topic = sessionsIndexTopic(workspaceId)
      indexSubs.set(ack.subscriptionId, { workspaceId, topic })
      void emitIndexSnapshot(workspaceId, ack.subscriptionId, topic, 'initial')
      return { ack }
    },
    async resyncSessionsIndexV4(params: { subscriptionId?: string; base?: { logEpoch: string; seq: number } | null; forceSnapshot?: boolean }) {
      const subId = params?.subscriptionId
      const sub = subId ? indexSubs.get(subId) : undefined
      if (!sub || !subId) throw new Error('fault.subscription.notOwned')
      const lastSeq = indexLastSeq.get(subId)
      const baseSeq = params?.base?.seq
      if (!params?.forceSnapshot && typeof baseSeq === 'number' && baseSeq === lastSeq) {
        deliverIndexWire(sub.topic, sub.workspaceId, subId, baseSeq, lastSeq, { kind: 'deltas', deltas: [] }, 'recovery')
        return { ack: { subscriptionId: subId, mode: 'resume', logEpoch: 'ocrc-1' } }
      }
      void emitIndexSnapshot(sub.workspaceId, subId, sub.topic, 'recovery')
      return { ack: { subscriptionId: subId, mode: 'snapshot', logEpoch: 'ocrc-1' } }
    },
    async unsubscribeSessionsIndexV4(params: { subscriptionId?: string }) {
      const subId = params?.subscriptionId
      if (!subId) return undefined
      indexSubs.delete(subId)
      indexLastSeq.delete(subId)
      return undefined
    },
    /** 事件面：onDynamicXxx(workspace) 返回 Event，Event(listener) 返回 disposable
     *  ——两种调用形状见 ghost.ts 的同名注释。 */
    onDynamicSessionsIndexFrame(params: { workspacePath?: string; workspaceIdentity?: string }) {
      const workspaceId = params?.workspaceIdentity?.trim() || params?.workspacePath || ''
      return (listener: (frame: any) => void) => {
        const set = indexListenersFor(workspaceId)
        set.add(listener)
        return { dispose: () => { set.delete(listener) } }
      }
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
          // P4-1b：本 Host 会发 `workflowRun.*` 键级增量（workflow-runs-delta 的两条 op），
          // 所以容器 revision 语义在场。置 true 之前这条一直是 false——不是保守，是当时
          // 根本没有 workflow 面。
          workflowRunDeltas: true,
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
        // 附件：web 端选图/拖图时 platform 把 File 存进寄存表、ref 以
        // ocrc-webfile:// 透传到这里——解析回字节转成 /api/message 的 images[]。
        // 引擎侧只收图片；其余类型在此如实拒绝（不是静默丢弃）。
        const rawAttachments = (envelope.payload as { attachments?: Array<{ ref?: string; fileName?: string }> }).attachments ?? []
        const images: Array<{ data: string; mimeType: string }> = []
        for (const att of rawAttachments) {
          const file = att?.ref ? resolveWebFile(att.ref) : undefined
          if (!file) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_attachment_unsupported', message: `附件 ${att?.fileName ?? att?.ref ?? ''} 不是本页选择的图片（ocrc 发送通道当前仅支持图片）`, revisionAtDecision: 0 }
          }
          if (!/^image\//.test(file.type)) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_attachment_unsupported', message: `附件 ${att?.fileName ?? file.type} 不是图片——ocrc 发送通道当前仅支持图片`, revisionAtDecision: 0 }
          }
          images.push({ data: await toBase64(file), mimeType: file.type })
        }
        // 计划模式（composer 选「计划」时 payload.planEnabled=true，见 vendor
        // execution-state.ts：mode 会被归一成 build，plan 只体现在 planEnabled）。
        // ocrc 的等价物 = 引擎原生 plan agent（只读规划、不落改动），按消息下发
        // ——不动 host 的全局 nextAgent（那是 TG /agent 的一次性槽，会跨会话泄漏）。
        const planEnabled = (envelope.payload as { planEnabled?: boolean }).planEnabled === true
        const res = await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({
            sessionId, text, clientId: envelope.commandId,
            ...(planEnabled ? { agent: 'plan' } : {}),
            ...(images.length ? { images } : {}),
          }),
        })
        if (res.ok) for (const att of rawAttachments) releaseWebFile(String(att?.ref ?? ''))
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
      // ── N12 goal 命令 ──
      // vendor 侧：/goal <目标> → sendGoalCommand{text}；/goal resume → resumeGoal；
      // 横幅按钮 → pauseGoal/resumeGoal。三者都落 host 的 POST /api/goal。
      // ACK 只回 accepted —— goal 面的刷新不靠 ACK，靠 ws `goal` 帧 → state.updated
      // （与上游「投影态由事件驱动」同一路子）。
      if (envelope.type === 'sendGoalCommand') {
        if (!sessionId) throw new Error('[ocrc-fork] sendGoalCommand 缺 sessionId')
        const objective = String((envelope.payload as { text?: string }).text ?? '').trim()
        if (!objective) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'sendGoalCommand 需要非空 text', revisionAtDecision: 0 }
        }
        const res = await fetch('/api/goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ action: 'set', sessionId, objective }),
        })
        if (!res.ok) {
          const detail = await res.json().catch(() => ({})) as { error?: string }
          return {
            commandId: envelope.commandId, status: 'failed',
            reasonCode: detail.error === 'plan_mode' ? 'ocrc_goal_plan_mode' : `ocrc_goal_set_failed`,
            message: `POST /api/goal set ${res.status}${detail.error ? ` (${detail.error})` : ''}`,
            revisionAtDecision: 0,
          }
        }
        return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
      }
      if (envelope.type === 'pauseGoal' || envelope.type === 'resumeGoal') {
        if (!sessionId) throw new Error(`[ocrc-fork] ${envelope.type} 缺 sessionId`)
        const action = envelope.type === 'pauseGoal' ? 'pause' : 'resume'
        const res = await fetch('/api/goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ action, sessionId }),
        })
        if (!res.ok) {
          const detail = await res.json().catch(() => ({})) as { error?: string }
          return {
            commandId: envelope.commandId, status: 'failed', reasonCode: `ocrc_goal_${action}_failed`,
            message: `POST /api/goal ${action} ${res.status}${detail.error ? ` (${detail.error})` : ''}`,
            revisionAtDecision: 0,
          }
        }
        return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
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
      if (envelope.type === 'forkAssistant') {
        // N9-4：引擎 POST /session/:id/fork 直通——新会话承载截断历史，vendor 收
        // forkAssistant ACK 后自动切到新会话。原会话不动。
        if (!sessionId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'forkAssistant 缺 sessionId', revisionAtDecision: 0 }
        }
        const target = (envelope.payload as { target?: { rowId?: number; entityId?: string } }).target
        if (!target?.rowId || !target.entityId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'forkAssistant 需要 rowId+entityId', revisionAtDecision: 0 }
        }
        const res = await fetch(`/api/session/${sessionId}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ messageID: target.entityId }),
        })
        if (!res.ok) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_fork_failed', message: `POST /api/session/:id/fork ${res.status}`, revisionAtDecision: 0 }
        }
        const created = (await res.json()) as { id: string }
        return {
          commandId: envelope.commandId,
          status: 'accepted',
          revisionAtDecision: 0,
          result: { type: 'forkAssistant', sessionId: created.id },
        }
      }
      if (envelope.type === 'editUserQuery') {
        // N9-4：preserve 模式 = revert 到该用户消息（含）+ 原文重发（新 turn）。
        // rewind（文件回退）没有 checkpoint 机制，如实拒绝；fork 分支不做（vendor
        // 新客户端已不生成）。
        if (!sessionId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'editUserQuery 缺 sessionId', revisionAtDecision: 0 }
        }
        const { target, newText, workspaceMode } = envelope.payload as { target?: { rowId?: number; entityId?: string }; newText?: string; workspaceMode?: string }
        if (!target?.entityId || typeof newText !== 'string') {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'editUserQuery 需要 target.entityId + newText', revisionAtDecision: 0 }
        }
        if (workspaceMode === 'rewind') {
          return {
            commandId: envelope.commandId,
            status: 'rejected',
            reasonCode: 'ocrc_rewind_unsupported',
            message: 'ocrc 没有 checkpoint/文件回退——preserve 模式可用（仅改写对话分支）',
            revisionAtDecision: 0,
          }
        }
        const rv = await fetch(`/api/session/${sessionId}/revert?messageID=${encodeURIComponent(target.entityId)}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token()}` },
        })
        if (!rv.ok) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_revert_failed', message: `POST /revert ${rv.status}`, revisionAtDecision: 0 }
        }
        const mres = await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ sessionId, text: newText, clientId: envelope.commandId }),
        })
        if (!mres.ok) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_send_failed', message: `POST /api/message ${mres.status}`, revisionAtDecision: 0 }
        }
        return {
          commandId: envelope.commandId,
          status: 'accepted',
          revisionAtDecision: 0,
          result: { type: 'editUserQuery', disposition: 'rewind', sessionId },
        }
      }
      if (envelope.type === 'setAssistantFeedback') {
        // N9-4：ocrc 引擎没有 feedback 面。按 entityId 本地持久（localStorage
        // `ocrc.feedback`），row.feedback 回读由 buildSnapshot/diffRows 携带。
        // 引擎侧语义（喂 RLHF）不存在——这一点如实写进文案，不假成功。
        const { target, feedback } = envelope.payload as { target?: { entityId?: string }; feedback?: string | null }
        if (!target?.entityId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'setAssistantFeedback 需要 target.entityId', revisionAtDecision: 0 }
        }
        try {
          const key = 'ocrc.feedback'
          const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string | null>
          if (feedback === null) delete all[target.entityId]
          else all[target.entityId] = String(feedback)
          localStorage.setItem(key, JSON.stringify(all))
        } catch { /* 存不了也不谎报成功 */ }
        return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
      }
    // ── P4-1c 四条 workflow 命令 ──
      // 四条都免 baseRevision（vendor：workflowRuns 面免 revision，假 CAS 失败只会误伤），
      // 且都以 workId ≡ runId 定位。拒绝一律回 vendor 自己的 fault 前缀 + 它那套 reason 词，
      // 因为 UI 拿 reasonCode 反查文案——换一个词就等于在面板上显示一句英文键名。
      if (envelope.type === 'cancelBackgroundWork') {
        const workId = String((envelope.payload as { workId?: string }).workId ?? '')
        if (!workId) {
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.backgroundWorkCancelRejected.not_found', message: 'cancelBackgroundWork 缺 workId', revisionAtDecision: 0 }
        }
        // `ocrc-tool:` 前缀是运行中的 bash 工具行——ocrc 没有可取消的后台任务概念
        // （snapshot 里它们的 cancellable 就是 false），如实说不支持而不是假接受。
        if (workId.startsWith('ocrc-tool:')) {
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.backgroundWorkCancelRejected.cancel_not_supported', message: 'ocrc 无法取消一个 bash 工具调用（它随会话轮结束）', revisionAtDecision: 0 }
        }
        const res = await fetch(`/api/workflow/runs/${encodeURIComponent(workId)}/cancel`, {
          method: 'POST', headers: { Authorization: `Bearer ${token()}` },
        })
        if (res.ok) return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
        const reason = res.status === 404 ? 'not_found' : 'not_running'
        return { commandId: envelope.commandId, status: 'rejected', reasonCode: `fault.command.backgroundWorkCancelRejected.${reason}`, message: `cancelBackgroundWork ${workId} → ${res.status}`, revisionAtDecision: 0 }
      }
      if (envelope.type === 'resumeWorkflowRun') {
        const workId = String((envelope.payload as { workId?: string }).workId ?? '')
        if (!workId) {
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.workflowRunResumeRejected.not_found', message: 'resumeWorkflowRun 缺 workId', revisionAtDecision: 0 }
        }
        const res = await fetch(`/api/workflow/runs/${encodeURIComponent(workId)}/resume`, {
          method: 'POST', headers: { Authorization: `Bearer ${token()}` },
        })
        if (res.ok) return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
        const body = (await res.json().catch(() => ({}))) as { error?: string; diagnostics?: unknown[] }
        // host 的 error 词 → vendor 的 reason 词。`not_resumable:<status>` 里的 running
        // 是 vendor 单独一格（already_running），其余落到 not_resumable。
        const raw = String(body.error ?? '')
        const reason = raw === 'not_found' ? 'not_found'
          : raw === 'no_script' ? 'script_missing'
            : raw === 'script_changed' ? 'script_mismatch'
              : raw === 'compile_failed' ? 'compile_failed'
                : raw === 'not_resumable:superseded' ? 'superseded'
                  : raw === 'not_resumable:running' ? 'already_running'
                    : 'not_resumable'
        return {
          commandId: envelope.commandId,
          status: 'rejected',
          reasonCode: `fault.command.workflowRunResumeRejected.${reason}`,
          message: `resumeWorkflowRun ${workId} → ${raw || res.status}`,
          revisionAtDecision: 0,
        }
      }
      if (envelope.type === 'amendWorkflowRunSettings') {
        const payload = envelope.payload as { workId?: string; subagentModel?: string | null; maxConcurrency?: number | null }
        const workId = String(payload.workId ?? '')
        if (!workId) {
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.workflowRunSettingsRejected.not_found', message: 'amendWorkflowRunSettings 缺 workId', revisionAtDecision: 0 }
        }
        if (payload.subagentModel !== undefined && payload.subagentModel !== null) {
          // 活着的 run 换不了子代理模型：它的 actor 已经各自拥有会话。vendor 的
          // model_unavailable 正是「这个模型在这个 run 上不可用」的那一格。
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.workflowRunSettingsRejected.model_unavailable', message: '活的 run 不能换子代理模型（actor 会话已存在）——请改脚本发起一次修订', revisionAtDecision: 0 }
        }
        if (payload.maxConcurrency === undefined) {
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.workflowRunSettingsRejected.unchanged', message: '没有任何设置被改动', revisionAtDecision: 0 }
        }
        const res = await fetch(`/api/workflow/runs/${encodeURIComponent(workId)}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ maxConcurrency: payload.maxConcurrency }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          const reason = body.error === 'not_found' ? 'not_found'
            : body.error === 'not_running' ? 'not_configurable'
              : body.error === 'subagent_model_immutable' ? 'model_unavailable'
                : 'start_failed'
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: `fault.command.workflowRunSettingsRejected.${reason}`, message: `amendWorkflowRunSettings ${workId} → ${body.error ?? res.status}`, revisionAtDecision: 0 }
        }
        // 就地生效：没有后继 run，结果里的 runId 就是这个 tab 自己（vendor 的
        // useWorkflowRunPaneSettings 明确认这一格——「没有可跟随的东西」）。
        return {
          commandId: envelope.commandId,
          status: 'accepted',
          revisionAtDecision: 0,
          result: { type: 'amendWorkflowRunSettings', runId: workId, toolCallId: `settings-${uuid()}` },
        }
      }
      if (envelope.type === 'startSavedWorkflow') {
        const payload = envelope.payload as { name?: string; scope?: string; args?: Record<string, unknown> }
        const name = String(payload.name ?? '').trim()
        if (!name) {
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: 'fault.command.savedWorkflowStartRejected.invalid_name', message: 'startSavedWorkflow 需要 name', revisionAtDecision: 0 }
        }
        // 名字 + 作用域一起解析（vendor 的 saved-workflow 族就是 name-keyed；scope 缺省
        // 是 project，与面板的默认档一致）。
        const scopeQuery = payload.scope ? `?scope=${payload.scope}` : ''
        const getRes = await fetch(`/api/workflow/saved/by-name/${encodeURIComponent(name)}${scopeQuery}`, {
          headers: { Authorization: `Bearer ${token()}` },
        })
        if (!getRes.ok) {
          const reason = getRes.status === 404 ? 'not_found' : 'start_failed'
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: `fault.command.savedWorkflowStartRejected.${reason}`, message: `没有名为 ${name} 的已保存 workflow（scope=${payload.scope ?? 'project'}）`, revisionAtDecision: 0 }
        }
        const runRes = await fetch(`/api/workflow/saved/by-name/${encodeURIComponent(name)}/run${scopeQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ ...(payload.args ? { args: payload.args } : {}), ...(sessionId ? { sessionId } : {}) }),
        })
        if (!runRes.ok) {
          const body = (await runRes.json().catch(() => ({}))) as { error?: string; diagnostics?: unknown[] }
          const raw = String(body.error ?? '')
          const reason = raw.startsWith('missing required argument') || raw.startsWith('unknown argument') || raw.startsWith('invalid')
            ? 'invalid_args'
            : raw === 'compile_failed' ? 'compile_failed'
              : 'start_failed'
          return { commandId: envelope.commandId, status: 'rejected', reasonCode: `fault.command.savedWorkflowStartRejected.${reason}`, message: raw || `POST /api/workflow/saved/:id/run ${runRes.status}`, revisionAtDecision: 0 }
        }
        const started = (await runRes.json()) as { runId: string }
        return {
          commandId: envelope.commandId,
          status: 'accepted',
          revisionAtDecision: 0,
          result: { type: 'startSavedWorkflow', runId: started.runId, toolCallId: `launch-${uuid()}` },
        }
      }
      return {
        commandId: envelope.commandId,
        status: 'rejected',
        reasonCode: `ocrc_unwired_${envelope.type}`,
        revisionAtDecision: 0,
      }
    },
    // ── P4-2 七条只读查询（run 侧页的取数面）──
  // 七条都是 vendor 的「只读、无状态、超时重发安全」族，形状照 wire schema 逐字回。
  // 宿主侧每条都按 vendor 的授权契约校验 `sessionId === run.parentSessionId`（不符与
  // 「无此 run」同一个 404）。
  async conversationWorkflowRunEventsV4(params: { sessionId?: string; runId?: string; afterSequence?: number; limit?: number }) {
    const query = new URLSearchParams({ sessionId: String(params?.sessionId ?? '') })
    if (params?.afterSequence !== undefined) query.set('afterSequence', String(params.afterSequence))
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    return await workflowQuery(`/api/workflow/runs/${encodeURIComponent(String(params?.runId))}/events/v4?${query}`)
  },
  async conversationWorkflowRunsV4(params: { sessionId?: string; limit?: number }) {
    const query = new URLSearchParams({ sessionId: String(params?.sessionId ?? '') })
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    return await workflowQuery(`/api/workflow/runs/summaries?${query}`)
  },
  async conversationWorkflowRunArtifactsV4(params: { sessionId?: string; runId?: string }) {
    const query = new URLSearchParams({ sessionId: String(params?.sessionId ?? '') })
    return await workflowQuery(`/api/workflow/runs/${encodeURIComponent(String(params?.runId))}/artifacts/v4?${query}`)
  },
  async conversationWorkflowRunArtifactDataV4(params: { sessionId?: string; runId?: string; artifactId?: string; afterSequence?: number; limit?: number }) {
    const query = new URLSearchParams({ sessionId: String(params?.sessionId ?? '') })
    if (params?.afterSequence !== undefined) query.set('afterSequence', String(params.afterSequence))
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    return await workflowQuery(`/api/workflow/runs/${encodeURIComponent(String(params?.runId))}/artifacts/${encodeURIComponent(String(params?.artifactId))}/data?${query}`)
  },
  async conversationWorkflowRunArtifactReadV4(params: { sessionId?: string; runId?: string; artifactId?: string; version?: number; offset?: number; limit?: number }) {
    const query = new URLSearchParams({
      sessionId: String(params?.sessionId ?? ''),
      offset: String(params?.offset ?? 0),
      limit: String(params?.limit ?? 512 * 1024),
    })
    return await workflowQuery(`/api/workflow/runs/${encodeURIComponent(String(params?.runId))}/artifacts/${encodeURIComponent(String(params?.artifactId))}/versions/${String(params?.version)}/read?${query}`)
  },
  async conversationWorkflowRunWorkspaceV4(params: { sessionId?: string; runId?: string }) {
    const query = new URLSearchParams({ sessionId: String(params?.sessionId ?? '') })
    return await workflowQuery(`/api/workflow/runs/${encodeURIComponent(String(params?.runId))}/workspace?${query}`)
  },
  async conversationWorkflowRunNodeResultV4(params: { sessionId?: string; runId?: string; siteId?: string; ordinal?: number; maxBytes?: number }) {
    const query = new URLSearchParams({ sessionId: String(params?.sessionId ?? '') })
    if (params?.maxBytes !== undefined) query.set('maxBytes', String(params.maxBytes))
    return await workflowQuery(`/api/workflow/runs/${encodeURIComponent(String(params?.runId))}/nodes/${encodeURIComponent(String(params?.siteId))}/${String(params?.ordinal)}/result?${query}`)
  },
    // ── P4-3 已保存工作流的 GUI 中枢 ──
    // vendor 这一族是 **name-keyed**，形状照 zcode-protocol 的 saved-workflow schema 逐字回。
    // ocrc 的 store 是机器级的一个 JSON（不是按项目分目录的 frontmatter 文件），所以：
    // `dir`/`path` 报的是那个文件（记录确实住在那儿），`invalid` 恒空（JSON 不会解析失败），
    // scope 是记录上的字段而不是目录推得的。这三条都写在路由的注释里，不假装是上游那种布局。
    async listSavedWorkflows(params: { scope?: 'project' | 'global' } = {}) {
      const query = params?.scope ? `?scope=${params.scope}` : ''
      return await workflowQuery(`/api/workflow/saved${query}`)
    },
    async getSavedWorkflow(params: { name?: string; scope?: 'project' | 'global' }) {
      const query = params?.scope ? `?scope=${params.scope}` : ''
      return await workflowQueryOrFailure(`/api/workflow/saved/by-name/${encodeURIComponent(String(params?.name))}${query}`)
    },
    async updateSavedWorkflowMeta(params: { name?: string; scope?: 'project' | 'global'; meta?: Record<string, unknown> }) {
      const query = params?.scope ? `?scope=${params.scope}` : ''
      return await workflowQueryOrFailure(`/api/workflow/saved/by-name/${encodeURIComponent(String(params?.name))}/meta${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params?.meta ?? {}),
      })
    },
    async deleteSavedWorkflow(params: { name?: string; scope?: 'project' | 'global' }) {
      const query = params?.scope ? `?scope=${params.scope}` : ''
      return await workflowQueryOrFailure(`/api/workflow/saved/by-name/${encodeURIComponent(String(params?.name))}${query}`, { method: 'DELETE' })
    },
    async listSavedWorkflowRuns(params: { name?: string; scope?: 'project' | 'global'; limit?: number }) {
      const search = new URLSearchParams()
      if (params?.scope) search.set('scope', params.scope)
      if (params?.limit !== undefined) search.set('limit', String(params.limit))
      const suffix = search.toString() ? `?${search}` : ''
      // 无 name = 列表视图要的是**该作用域的全部** run（vendor 的 store 就是这么调的）。
      // 这一条必须永远回 `{runs: [...]}`：消费侧直接 `result.runs` 并遍历，回一个失败信封
      // 会让面板拿 undefined 去迭代并触发错误边界（实测「e is not iterable」）。
      const path = params?.name
        ? `/api/workflow/saved/by-name/${encodeURIComponent(params.name)}/runs${suffix}`
        : `/api/workflow/saved/runs${suffix}`
      const body = await workflowQueryOrFailure(path)
      return { runs: Array.isArray(body?.runs) ? body.runs : [], ...(body?.truncated ? { truncated: true } : {}) }
    },
    /**
     * `moveSavedWorkflow`（global → project）如实拒绝：上游是「把文件从全局目录搬到项目
     * 目录」，ocrc 只有一个 store，没有可搬的文件。回 501 + reason，面板按 vendor 的失败
     * 形状显示原因——假装成功会让面板显示成项目档而 store 里还是全局。
     */
    async moveSavedWorkflow(params: { name?: string }) {
      return await workflowQueryOrFailure(`/api/workflow/saved/by-name/${encodeURIComponent(String(params?.name))}/move`, { method: 'POST' })
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
