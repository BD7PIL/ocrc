// zcode-services/zcodeAgentService.ts — ocrc-backed zcodeAgentService v4 面 (N2).
// hello/握手 + 订阅三件套 + **初始 snapshot 通知**：subscribeConversationV4 ACK
// 后异步取 ocrc 历史（cards → conversation rows），包成 v4 topic frame 经
// onDynamicConversationFrame 的监听器同步下发一次 —— ConversationTimeline 的
// assembler/decoder 由此渲染真实消息。发链（sendPrompt）在 zcodeTaskService。

import { conversationTopicFrameSchema, sessionsIndexTopicFrameSchema } from '@zcode/shared/zcode-protocol-v4/transport'
import { sessionsIndexTopic, PROTOCOL_V4_LIMITS } from '@zcode/shared/zcode-protocol-v4'
import { dropAttachmentBytes, putAttachmentBlob, releaseWebFile, resolveWebFile, takeAttachmentBytes, toBase64 } from './webAttachments.js'
import {
  projectGoal, projectGoalAvailability, type GoalProjection, type OcrcGoalRecord,
} from './goalProjection.js'
import {
  fetchWorkflowDisplay, fetchWorkflowProjection, nextWorkflowRunsState, resolveToolCallIds, runsEqual,
} from './workflowProjection.js'
import { deriveSessionWorkflowActivity } from '@zcode/shared/zcode-protocol-v4/sessions-index-workflow-activity'
import type { WorkflowRunState, WorkflowRunsState } from '@zcode/shared/zcode-protocol-v4/workflow-runs'
import { hostConn, HOST_RECONNECT_MS, type HostPhase } from './hostConnection.js'
import { projectPendingInteractions, decisionFromOptionId, contentToAnswerRows } from './pendingInteractions.js'

const V4_WIRE_PROTOCOL_VERSION = 3 as const

// ── B8 附件上行边界（客户端先判一次；权威清单在 host 侧 src/core/attachments.ts）──
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
const BLOCKED_ATTACHMENT_EXT = new Set([
  'exe', 'msi', 'dll', 'so', 'dylib', 'bin', 'com', 'scr', 'cpl',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh',
  'jar', 'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'hta', 'msc', 'lnk', 'reg',
])

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
interface OcrcCard {
  kind: string; text?: string; ts?: number; blocks?: OcrcBlock[]; meta?: { model?: string; agent?: string }; thinkingText?: string; messageId?: string; origin?: string
  // U1 dock：approval/question 卡的交互字段（structured-card.ts）。
  requestId?: string; title?: string; args?: unknown; resolved?: string
  questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }>
}

const HISTORY_PAGE = 200
/** live 尾部小页：每 tick 只取最新 N 条消息（实测 61KB → ~6KB），全量页由快照/
 *  计划目录/周期性兜底负责。合并锚点靠卡片稳定身份（见 mergeTailPage）。 */
const HISTORY_TAIL_PAGE = 20
/** live 每 N 个 tick 强制一次全量页：兜住「更早卡的状态后到」（工具 running→done
 *  发生在 20 条消息窗口之外时，尾部小页永远看不到）。 */
const HISTORY_FULL_EVERY_TICKS = 10

interface HistoryPage {
  cards: OcrcCard[]
  /** 服务端「更早可能存在」（`cards.length >= limit` 启发，见 core/history.ts）。 */
  hasMore: boolean
}

async function ocrcHistoryPage(taskId: string, offset = 0, limit = HISTORY_PAGE): Promise<HistoryPage> {
  let res: Response
  try {
    const q = offset > 0 ? `?limit=${limit}&offset=${offset}` : `?limit=${limit}`
    res = await fetch(`/api/session/${taskId}${q}`, {
      headers: { Authorization: `Bearer ${token()}` },
    })
  } catch (e) {
    // P5：网络层失败不再吞成空历史（那会以「空会话」假象掩盖掉线）——向调用方
    // 如实抛出（快照构建走重试补投），同时给连接状态机记一次 REST 连击。
    hostConn.restFail()
    throw e
  }
  hostConn.restOk()
  if (!res.ok) return { cards: [], hasMore: false }
  const body = (await res.json()) as { cards?: OcrcCard[]; hasMore?: boolean }
  const cards = body.cards ?? []
  // 服务端未给 hasMore（旧引擎/桩）时退回同源启发，不静默变成「已到底」。
  return { cards, hasMore: typeof body.hasMore === 'boolean' ? body.hasMore : cards.length >= limit }
}

async function ocrcHistory(taskId: string, offset = 0): Promise<OcrcCard[]> {
  return (await ocrcHistoryPage(taskId, offset, HISTORY_PAGE)).cards
}

// ── B7 历史窗口：最新页 + 更早页（offset 翻页）─────────────────────────
// 服务端窗口语义 = `[len-limit-offset, len-offset)`（core/history.ts
// cardsFromMessages）：offset=0 是最新一页，offset 增大向更早翻页。桥接按此维护
// 「已加载窗口」：recent = 最新页（live 刷新只换它）；older = 前插的更早页
// （数组越靠前越老）。exhausted/hasOlderOnLoad 决定 vendor「加载更早」是否还有货。
interface HistoryWindow {
  older: OcrcCard[]
  recent: OcrcCard[]
  /** 下一个更早页的 message offset（200, 400, …）。 */
  nextOlderOffset: number
  /** 引擎侧已确认没有更早消息。 */
  exhausted: boolean
  /** 最近一次**全量**取最新页时服务端是否报还有更早（tail 合并不更新它）。 */
  hasOlderOnLoad: boolean
  /** 距上次全量页的 live tick 数（每 HISTORY_FULL_EVERY_TICKS 强制一次全量）。 */
  ticksSinceFull: number
}
const historyWindows = new Map<string, HistoryWindow>()
const HISTORY_WINDOW_MAX_SESSIONS = 50

/** 卡片的稳定身份（无 id 的遗留卡返回 undefined）。 */
function stableCardKey(c: OcrcCard): string | undefined {
  return c.messageId ?? c.requestId
}

/** live 尾部小页合并：按「尾部页第一张稳定身份卡」在 recent 里定位锚点，锚点之前的
 *  部分（更老）保留，锚点起用尾部页整替——中间被截掉/被回退的卡片不留残影。
 *  返回 null 表示锚点不可定位（会话被重置/身份缺失）→ 调用方回落全量页。 */
function mergeTailPage(recent: OcrcCard[], tail: OcrcCard[]): OcrcCard[] | null {
  if (!tail.length) return recent
  const anchor = tail.find((c) => stableCardKey(c) !== undefined)
  const key = anchor ? stableCardKey(anchor) : undefined
  if (!key) return null
  const i = recent.findIndex((c) => stableCardKey(c) === key)
  if (i === -1) return null
  return [...recent.slice(0, i), ...tail]
}

/** 取/刷新窗口。refresh=false 直接复用；refresh=true 按 mode 刷新：
 *  `full` = 取最新 200 消息页并更新 hasOlderOnLoad/exhausted（快照、计划目录、周期兜底）；
 *  `tail` = 取最新 20 消息小页与 recent 合并（live 每 tick，实测 61KB → ~6KB），
 *  **不动** hasOlderOnLoad/exhausted（小页满不满与「更早是否存在」无关）。
 *  锚点缺失时回落 full。网络失败如实抛（P5）。 */
async function historyWindowFor(sessionId: string, refresh: boolean, mode: 'full' | 'tail' = 'full'): Promise<HistoryWindow> {
  const existing = historyWindows.get(sessionId)
  if (existing && !refresh) return existing
  const w: HistoryWindow = existing ?? { older: [], recent: [], nextOlderOffset: HISTORY_PAGE, exhausted: false, hasOlderOnLoad: false, ticksSinceFull: 0 }
  if (mode === 'tail' && existing) {
    w.ticksSinceFull += 1
    if (w.ticksSinceFull < HISTORY_FULL_EVERY_TICKS) {
      const page = await ocrcHistoryPage(sessionId, 0, HISTORY_TAIL_PAGE)
      const merged = mergeTailPage(w.recent, page.cards)
      if (merged) {
        w.recent = merged
        historyWindows.set(sessionId, w)
        return w
      }
      // 锚点不可定位 → 不能静默丢帧，回落全量页（下面统一走）。
    }
  }
  const page = await ocrcHistoryPage(sessionId, 0, HISTORY_PAGE)
  w.recent = page.cards
  // 满页启发改读服务端 hasMore（与 core/history.ts 同源）：小页化后不能再用
  // `cards.length >= 200` 自判，否则恒 false → 误判 exhausted → 「加载更早」消失。
  w.hasOlderOnLoad = page.hasMore
  if (!w.hasOlderOnLoad && w.older.length === 0) w.exhausted = true
  w.ticksSinceFull = 0
  if (!historyWindows.has(sessionId) && historyWindows.size >= HISTORY_WINDOW_MAX_SESSIONS) historyWindows.clear()
  historyWindows.set(sessionId, w)
  return w
}

/** 还有未加载的更早行吗（快照 firstRowId 与 rowsRange hasMore 共用同一判据）。 */
function windowHasOlder(w: HistoryWindow): boolean {
  if (w.exhausted) return false
  return w.older.length > 0 ? true : w.hasOlderOnLoad
}

function windowCards(w: HistoryWindow): OcrcCard[] {
  return [...w.older, ...w.recent]
}

/** 全窗口建行：更早页在前；turn 号从 `TURN_BASE - 更早页回合数` 起，
 *  更早页的行取向下 id 空间（见 buildRows / rowIdFor 契约）。 */
function buildWindowRows(sessionId: string, w: HistoryWindow, goalArg?: GoalUi): any[] {
  const olderUserCount = w.older.reduce((n, c) => n + (c.kind === 'user' ? 1 : 0), 0)
  return buildRows(sessionId, windowCards(w), goalArg, { turnStart: TURN_BASE - olderUserCount, olderCardCount: w.older.length })
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
const rawMessageCache = new Map<string, { parts: Map<string, OcrcToolPart>; at: number; terminal: boolean }>()
/** 长缓存：定稿工具结果不变，只有流式中的还在变。60s + 条目上限（越过即全清——
 *  会话热路径上 Map 只增不减曾是泄漏点）。 */
const RAW_CACHE_TTL_MS = 60_000
const RAW_CACHE_MAX_ENTRIES = 64

async function rawToolParts(sessionId: string, messageId: string): Promise<Map<string, OcrcToolPart>> {
  const key = `${sessionId}:${messageId}`
  const hit = rawMessageCache.get(key)
  if (hit && (hit.terminal || Date.now() - hit.at < RAW_CACHE_TTL_MS)) return hit.parts
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
  // E4/B7：终态缓存——消息里所有工具 part 都到终态（completed/error）后，内容不会再变，
  // 该条缓存永不失效（TTL 只用来兜住 running 中的工具输出）。此前 60s TTL 让流式期
  // 每个去抖窗都可能对已完成的工具消息重新回查（E4 的 5s/60s 重查风暴）。
  const terminal = byId.size > 0 && [...byId.values()].every((p) => {
    const s = p.state?.status
    return s === 'completed' || s === 'error' || s === 'done'
  })
  rawMessageCache.set(key, { parts: byId, at: Date.now(), terminal })
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
    const fresh = cached && (cached.terminal || Date.now() - cached.at < RAW_CACHE_TTL_MS)
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

// ── 行身份：内容寻址（N9-1）+ 单调 id 空间（B7）──────────────────────
// N9-1：rowId 曾是「扁平列表里的位置序号」，中间插入一行会让后续 rowId 位移，
// vendor 按 rowId 键控 upsert → 同一内容被当「删+增」重复渲染。改为**内容寻址**：
// 身份 = 卡片 messageId + 块 partId/kind 序，同内容恒得同一身份。
// B7：但 vendor 的 range/merge 语义按**数值**比较 rowId（hasOlderRows:
// window[0].rowId > firstRowId；mergeOlderRows / loadAllOlder / apply 的
// row.removed 都是 filter rowId < 游标），它要求 rowId 随行序单调。纯哈希满足
// 身份稳定却破坏了单调——实测后果：桥接的 firstRowId 恒等于窗口首行 →
// hasOlderRows 恒假 → 「加载更早」按钮永不出现、更早历史不可达。
// 现在两者兼得：内容身份 → **单调 id**（每会话一个 id 空间）：
//   · 尾部新行从 BASE 递增（追加/流式增长不位移旧行 → N9-1 修复保持）；
//   · 更早页（loadOlder 前插）从 BASE 递减 → 数值上严格小于窗口首行。
// 身份 → id 记忆化：同会话重建幂等；vendor 的数值比较与去重键同时成立。
const ROW_ID_BASE = 0x10000000
/** turn 号基准：更早页前插要占更小的 turn 号（vendor 只把 turnId 当聚合键，
 *  不解析数字——已核实无 parseInt/match(/turn/)）。取 100 万留足前插空间。 */
const TURN_BASE = 1_000_000
interface RowIdSpace { byKey: Map<string, number>; nextTail: number; nextHead: number }
const rowIdSpaces = new Map<string, RowIdSpace>()
const ROW_ID_SPACE_MAX_SESSIONS = 50

function rowIdSpace(sessionId: string): RowIdSpace {
  let space = rowIdSpaces.get(sessionId)
  if (!space) {
    space = { byKey: new Map(), nextTail: ROW_ID_BASE, nextHead: ROW_ID_BASE - 1 }
    if (rowIdSpaces.size >= ROW_ID_SPACE_MAX_SESSIONS) rowIdSpaces.clear()
    rowIdSpaces.set(sessionId, space)
  }
  return space
}

function rowIdFor(sessionId: string, identity: string, older: boolean): number {
  const space = rowIdSpace(sessionId)
  const hit = space.byKey.get(identity)
  if (hit !== undefined) return hit
  const id = older ? space.nextHead-- : space.nextTail++
  space.byKey.set(identity, id)
  return id
}

/** 更早页发号：按**行序**整块发放单调递增的向下 id。
 *  逐行 rowIdFor 会在卡内倒序（buildRows 先推 turnHeader 再推 userInput，而向下号段
 *  是递减的），于是前插页在行序上 id 非单调。vendor `mergeOlderRows`
 *  （conversationProjectionStore.ts:258-266）按 `rowId < window[0].rowId` 过滤，
 *  游标落在 userInput 行时会把游标前那张 id 更大的 turnHeader 丢掉——实测 1000 行档
 *  因此少 1 行（非对齐档每页边界丢 1）。干跑（只枚举身份、不发号）先拿到该页按行序的
 *  身份键，再整块分配，保证页内 id 随行序递增。 */
function assignOlderPageIds(sessionId: string, page: OcrcCard[]): void {
  const rows = buildRows(sessionId, page, undefined, {
    olderCardCount: page.length, turnStart: TURN_BASE - 1, dryIdKeys: true,
  })
  const space = rowIdSpace(sessionId)
  const keys: string[] = []
  for (const r of rows) {
    const k = r.__idKey as string | undefined
    if (k && !space.byKey.has(k) && !keys.includes(k)) keys.push(k)
  }
  if (!keys.length) return
  const base = space.nextHead - keys.length + 1
  space.nextHead -= keys.length
  for (let i = 0; i < keys.length; i++) space.byKey.set(keys[i]!, base + i)
}

/** 内容寻址 rowId 的身份串：卡片 messageId（缺省退 ts+kind——旧引擎消息无 id 时的
 *  兜底，只要同会话内唯一即可）+ 行在卡内的稳定序。
 *  requestId 优先级是**防御性**的：交互卡（approval/question）当前不产行
 *  （buildRows 只处理 user/assistant；dock 投影直接用 requestId 作 interactionId），
 *  但「只有 requestId 的卡」若哪天进入行投影，位置兜底会随窗口位移漂 id——按
 *  messageId → requestId → 位置 排序，任何稳定 id 都优先于位置。 */
function cardIdentity(c: OcrcCard, index: number): string {
  return c.messageId ?? c.requestId ?? `${c.ts ?? 0}:${c.kind}:${index}`
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
function goalVerifyRows(sessionId: string, goal: GoalProjection, verifying: boolean): Array<{ iteration: number; row: any }> {
  const mk = (iteration: number, outcome: string, detail?: string) => ({
    rowId: rowIdFor(sessionId, `goalVerify|${goal.targetId}|${iteration}`, false),
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

function buildRows(sessionId: string, cards: OcrcCard[], goalArg?: GoalUi, opts?: { turnStart?: number; olderCardCount?: number; dryIdKeys?: boolean }): any[] {
  const rows: any[] = []
  const olderCardCount = opts?.olderCardCount ?? 0
  let turn = (opts?.turnStart ?? TURN_BASE) - 1
  // 更早页前插：该卡区间内的行取「向下」的 id（数值上小于窗口首行），
  // 现有行身份/id 全部不变（见 rowIdFor 的契约）。
  let cardOlder = false
  // 续跑轮的起始行下标（第 k 个续跑轮 → continuationStarts[k-1]）：冷启动时用它
  // 把第 N 轮的验收 marker 钉在「第 N+1 轮开始之前」，即第 N 轮的轮尾。
  const continuationStarts: number[] = []
  // 时间戳必须取卡片自身的 ts：live 路径按行内容 diff（row.upserted/row.appended），
  // Date.now() 会让每次重建的 rows 全部不同，diff 退化成全量 upsert。
  // rowId 由内容身份派生（见 stableRowId）；turnId 维持 `turn-N` 计数——vendor 用它
  // 作 turn 聚合键，不解析数字。
  const base = (ts: number, identity: string, kindTag: string, entityId?: string) => {
    const idKey = `${identity}|${kindTag}`
    return {
      // dryIdKeys：干跑只枚举身份（见 assignOlderPageIds），不发号，把身份键带回调用方。
      ...(opts?.dryIdKeys ? { __idKey: idKey } : { rowId: rowIdFor(sessionId, idKey, cardOlder) }),
      turnId: `turn-${turn}`,
      ...(turn > 0 ? { productTurnId: `turn-${turn}` } : {}),
      ...(entityId ? { entityId } : {}),
      createdAt: ts,
      // createdAtSeq 曾等于位置 rowId；现在给单调行计数（vendor 只把它当时间戳用）。
      createdAtSeq: rows.length + 1,
    }
  }
  for (let ci = 0; ci < cards.length; ci++) {
    const c = cards[ci]!
    const ts = c.ts ?? 0
    cardOlder = ci < olderCardCount
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
  insertGoalVerifyRows(sessionId, rows, continuationStarts, goalArg)
  return rows
}

/** 把 goalVerify marker 行插到各自轮尾。锚点优先级：① 实时锚（ws goal 帧到达时
 *  记的行尾）；② 冷启动回落（第 N+1 个续跑轮起始行的前一行）；③ 都无 → 落尾。
 *  锚点行的 turnId/createdAtSeq 复制给 marker，让它与所在轮同组、时序单调。 */
function insertGoalVerifyRows(sessionId: string, rows: any[], continuationStarts: number[], goalArg?: GoalUi): void {
  if (!goalArg?.goal) return
  const projected = projectGoal(goalArg.goal, goalArg.verifying, goalArg.anchors)
  const markers = goalVerifyRows(sessionId, projected, goalArg.verifying)
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
const subscriptions = new Map<string, { sessionId: string; topic: string; workspaceKey?: string }>()
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
    console.warn('frame zod FAIL:', JSON.stringify(check.error.issues.slice(0, 6).map((i) => ({ path: i.path.join('.'), msg: i.message }))))
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
  for (const l of frameListeners) {
    try { l(wire) } catch (e) { console.warn('frame listener threw', String(e).slice(0, 200)) }
  }
}

interface SnapshotBuild {
  snapshot: Record<string, unknown>
  seq: number
  rows: any[]
}

/** composer 策略下拉的回显源（批次 3）：ocrc 审批策略 → ZCode 协作模式。
 *  写路径是 switchCollaborationMode → POST /policy；这里只读，失败按 build 兜底。 */
async function sessionMode(sessionId: string): Promise<string> {
  try {
    const res = await fetch(`/api/session/${sessionId}/policy`, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return 'build'
    const body = (await res.json()) as { policy?: string }
    return body.policy === 'yolo' ? 'yolo' : body.policy === 'edit' ? 'edit' : 'build'
  } catch {
    return 'build'
  }
}

/** context usage pill（批次 3）：引擎 token 统计（opencode getContext 的 used/max 估算，
 *  含「引擎忙窗口归零」的 lastKnown 兜底）。used/max 任一未知 → null（vendor 语义的「未知」）。 */
async function contextWindowOf(sessionId: string): Promise<{ usedTokens: number; maxTokens: number; autoCompactThresholdTokens: null } | null> {
  try {
    const res = await fetch(`/api/session/${sessionId}/context`, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return null
    const body = (await res.json()) as { tokens?: { used?: number; max?: number } }
    const used = body.tokens?.used
    const max = body.tokens?.max
    if (typeof used !== 'number' || typeof max !== 'number' || max <= 0 || used < 0) return null
    return { usedTokens: used, maxTokens: max, autoCompactThresholdTokens: null }
  } catch {
    return null
  }
}

async function buildSnapshotPayload(taskId: string): Promise<SnapshotBuild> {
  // B7：历史取数走窗口（最新页 + 已加载的更早页），live 只刷新最新页。
  const window_ = await historyWindowFor(taskId, true)
  const cards = windowCards(window_)
  const [sessionTitle, providers, overrides] = await Promise.all([
    fetch('/api/sessions', { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ id: string; title?: string }>>) : []))
      .then((list) => list.find((x) => x.id === taskId)?.title ?? '')
      .catch(() => ''),
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
  const [plan, subagents, goalUiState, mode, contextWindow] = await Promise.all([
    conversationPlan(taskId),
    conversationSubagents(taskId),
    fetchGoal(taskId),
    sessionMode(taskId),
    contextWindowOf(taskId),
  ])

  const rows = buildWindowRows(taskId, window_, goalUiState)
  // P4-1b: this session's workflow runs, resolved against the rows we just built. Both
  // this and the background-work collection must happen BEFORE enrichToolRows — the card
  // join needs the tool rows' `toolCallId` + message id, and enrichment strips those
  // (they are row-internal details).
  const workflowRuns = await refreshWorkflowRuns(taskId, rows)
  const backgroundWorks = collectBackgroundWorks(rows, workflowRuns)
  await attachWorkflowDisplays(rows, workflowRuns, taskId)
  await enrichToolRows(rows, taskId)
  const seq = rows.length
  // 快照只带尾部窗口（vendor 常量 60 行，上游同款语义）；更早的行由 loadOlder
  // → rows/range 按 offset 翻页取回。是否还有更早行 = 窗口未耗尽 或 已加载行数
  // 超过尾窗（后者必然意味着窗口首行不是分支首行）。
  const tailRows = rows.slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
  const hasOlderRowsInSession = windowHasOlder(window_) || rows.length > tailRows.length
  const snapshot = {
    protocolVersion: 1,
    sessionId: taskId,
    logEpoch: 'ocrc-1',
    seq,
    revision: 1,
    // P5/批次 3：control 是 busy 感知的（引擎存续期 = running + canStop 三连），
    // lastError/apiRetry 的动态面由 hostConn 的连接状态机增量下发。
    control: controlFor(taskId),
    // goal 门对齐 vendor projection-state.ts：pause 只在目标可续时开，resume 只在
    // paused 时开；无 goal 时带 noGoalToPause/Resume 原因码（驱动禁用态 tooltip）。
    availability: availabilityState(goalUiState.goal ? projectGoal(goalUiState.goal, goalUiState.verifying, goalUiState.anchors).status : null),
    inputRouting: { mode: 'startNow' },
    // 批次 3：mode 回显——写路径 switchCollaborationMode → POST /policy，读路径在 sessionMode。
    config: { provider: curProvider, model: curModel, thought: curThought, thoughtLevels: providers.find((p) => p.id === curProvider)?.models?.find((m) => m.id === curModel)?.variants ?? [], followupMode: 'queue', mode },
    // 批次 3：context usage pill——引擎 token 统计（used/max 同缺则整键 null = vendor 语义的「未知」）。
    usage: { contextWindow, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: true },
    // U1 权限/提问 dock：cardBus 的 approval/question 卡投影成 vendor
    // PendingInteraction（dock 渲染 + resolveInteraction 回程，见下）。
    pendingInteractions: projectPendingInteractions(cards),
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
    rows: {
      window: tailRows,
      // totalCount = 已加载行数（更早消息尚未加载，如实只报已知量）。
      totalCount: rows.length,
      // firstRowId = **分支首行**（不是窗口首行）：vendor 的 hasOlderRows 判据是
      // `window[0].rowId > firstRowId`。更早行的真值在未加载时不可知，用 0 作下界
      // 哨兵（id 空间自 0x10000000 起，0 严格小于任何真实行 id）。
      firstRowId: hasOlderRowsInSession ? 0 : (tailRows[0]?.rowId ?? null),
    },
  }
  return { snapshot, seq, rows }
}

/** 快照构建失败（host 不可达等）后的有界补投：host 恢复后自动收敛，5 次后放弃
 *  （store 侧的恢复阶梯 / available 事件是并行的兜底，不依赖这条链活着）。 */
const SNAPSHOT_RETRY_DELAYS_MS = [1500, 4000, 8000, 15000, 30000] as const

async function emitConversationSnapshot(taskId: string, topic: string, subscriptionId: string, deliveryKind: 'initial' | 'recovery' | 'online', retryIndex = 0): Promise<void> {
  let built: SnapshotBuild
  try {
    built = await buildSnapshotPayload(taskId)
  } catch (e) {
    // P5：历史取不到（典型 = host 不可达）时拒绝投「空会话」假快照——那会把掉线
    // 伪装成空对话。改为有界重试补投。
    console.warn(`[ocrc-agent] snapshot build failed (${taskId}):`, String(e).slice(0, 200))
    const delay = SNAPSHOT_RETRY_DELAYS_MS[retryIndex]
    if (delay !== undefined) {
      setTimeout(() => {
        if (!frameListeners.size) return
        void emitConversationSnapshot(taskId, topic, subscriptionId, deliveryKind, retryIndex + 1)
      }, delay)
    }
    return
  }
  const { snapshot, seq, rows } = built
  // 水位/rows 记账先于投递：retry 路径与 live diff 都依赖这份基线。
  lastSeqBySub.set(subscriptionId, seq)
  lastRowsBySession.set(taskId, rows)
  lastInteractionsBySession.set(taskId, JSON.stringify(snapshot.pendingInteractions))
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
// U1 dock 的 live 基线：与 rows 分开记——resolved 重发布不改 rows（buildRows 不投影
// 交互卡），只有这份签名能驱动 dock 清除的 state.updated 补丁。
const lastInteractionsBySession = new Map<string, string>()
const liveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const watchedSessions = new Set<string>()
let liveWs: WebSocket | null = null
let liveWsRetry: ReturnType<typeof setTimeout> | null = null

// ── P5: host 掉线可见化 ──────────────────────────────────────────────────
// 检测：liveWs 是唯一事实源（client.ts 的 REST 佐证只强制重验，不改相位）。
// 展示：相位变化 → control patch（composer 横幅 + 「重新连接中 N/M」条）；
// 确认死亡（重连封顶）→ runtime lifecycle unavailable → vendor 恢复阶梯
// （subscribe/resync 探测裁决 → 有界退避 → SessionSubscriptionErrorPanel 整页）。
// 自愈：ws 回来 → 清口 patch + available（store 按水位 resync / 重订阅全量收敛）。
const CONTROL_BASE = {
  phase: 'completedSuccess',
  sessionEnded: true,
  canStop: false,
  stopState: 'idle',
  stopTargetKind: 'unknown',
  activeWorks: [],
} as const

function hostNetworkError(): Record<string, unknown> {
  return {
    code: 'fault.host.unreachable',
    message: '无法连接 ocrc 主机——数据通道已断开，正在尝试恢复（host unreachable）',
    recoverable: true,
    at: Date.now(),
    source: 'network',
  }
}

// 批次 3：引擎存续期（ws session.status 的 busy 帧）→ running control——canStop 一发亮三
// （停止按钮 / 运行中排队 placeholder / Esc 停止）。busy 态与 P5 掉线态可以同时成立：
// extra 把 lastError/apiRetry 叠进当前基线，谁都不清掉谁。
const busyConversations = new Map<string, boolean>()

function controlFor(sessionId: string, extra: { lastError?: Record<string, unknown> | null; apiRetry?: Record<string, unknown> | null } = {}) {
  if (busyConversations.get(sessionId) === true) {
    return {
      phase: 'running',
      sessionEnded: false,
      canStop: true,
      stopState: 'stoppable',
      stopTargetKind: 'assistant',
      activeWorks: [{ kind: 'primaryTurn', startedAt: Date.now() }],
      lastError: extra.lastError ?? null,
      apiRetry: extra.apiRetry ?? null,
    }
  }
  return { ...CONTROL_BASE, lastError: extra.lastError ?? null, apiRetry: extra.apiRetry ?? null }
}

/** ws session.status（引擎忙/闲翻转）→ conversation control patch（仅 subscribed 会话有帧）。 */
function setConversationBusy(sessionId: string, busy: boolean): void {
  if (busyConversations.get(sessionId) === busy) return
  busyConversations.set(sessionId, busy)
  deliverControlPatch(sessionId, controlFor(sessionId))
}

/** control-only 增量帧：seq 是快照对齐水位，control 帧同样推进 1（store 的重复帧/断档规则都按 toSeq/fromSeq 判定）。 */
function deliverControlPatch(sessionId: string, control: Record<string, unknown>): void {
  for (const [subId, sub] of subscriptions) {
    if (sub.sessionId !== sessionId) continue
    const seq = lastSeqBySub.get(subId) ?? 0
    deliverWire(sub.topic, subId, seq, seq + 1, { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { control } }] }, 'online')
    lastSeqBySub.set(subId, seq + 1)
  }
}

const lifecycleListeners = new Set<(event: { workspaceKey: string; state: 'available' | 'unavailable' }) => void>()

/** transport 按 workspaceKey（= workspaceIdentity || workspacePath，subscribe 时登记）过滤事件。 */
function emitLifecycle(state: 'available' | 'unavailable'): void {
  const keys = new Set<string>()
  for (const sub of subscriptions.values()) {
    if (sub.workspaceKey) keys.add(sub.workspaceKey)
  }
  for (const key of keys) {
    for (const l of [...lifecycleListeners]) {
      try { l({ workspaceKey: key, state }) } catch { /* 监听器自负 */ }
    }
  }
}

let prevPhase: HostPhase = 'up'
let episodeError: Record<string, unknown> | null = null
hostConn.subscribe((s) => {
  if (s.phase === 'up') {
    episodeError = null
    if (prevPhase !== 'up') {
      for (const sessionId of watchedSessions) {
        deliverControlPatch(sessionId, controlFor(sessionId))
        // ws 期间落下的引擎事件由 refetch+diff 收敛（available 的 forceSnapshot 是 store 侧兜底）。
        scheduleLive(sessionId)
      }
      emitLifecycle('available')
    }
  } else if (s.phase === 'degraded') {
    // episode 内 lastError 对象复用（at 稳定 → 横幅错误指纹不变，不反复重闪）。
    if (prevPhase === 'up') episodeError = hostNetworkError()
    for (const sessionId of watchedSessions) {
      deliverControlPatch(
        sessionId,
        controlFor(sessionId, {
          lastError: episodeError,
          apiRetry: { attempt: s.attempt, maxAttempts: s.maxAttempts, nextRetryAt: Date.now() + HOST_RECONNECT_MS, reasonCode: 'host_unreachable' },
        }),
      )
    }
  } else if (prevPhase !== 'down') {
    // down（确认死亡）只在转入时发一次；此后 attempt 继续涨但界面不再刷。
    for (const sessionId of watchedSessions) deliverControlPatch(sessionId, controlFor(sessionId, { lastError: episodeError ?? hostNetworkError() }))
    emitLifecycle('unavailable')
  }
  prevPhase = s.phase
})
// REST 佐证连击达到阈值（疑似半开连接）→ 强制 ws 重验：close 后由 onclose 重连梯子接管。
hostConn.setForceRecheck(() => {
  try { liveWs?.close() } catch { /* onclose 接管 */ }
})

const HEARTBEAT_INTERVAL_MS = 15_000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let pingInFlight = false

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  pingInFlight = false
}

function startHeartbeat(): void {
  stopHeartbeat()
  // 半开探测：app 级 ping/pong（ws-hub 原生支持）。上一拍 ping 未获任何回声
  // （pong 或任意业务帧都算活性）→ REST 探测裁决——后台节流页可能只是定时器饿着，
  // 误杀会闪断，所以由 HTTP 层裁决是否真的断网，再决定要不要撕掉这条 ws。
  heartbeatTimer = setInterval(() => {
    if (pingInFlight) {
      pingInFlight = false
      void probeHost().then((ok) => {
        if (ok) return
        try { liveWs?.close() } catch { /* onclose 接管 */ }
      })
      return
    }
    try {
      liveWs?.send(JSON.stringify({ type: 'ping' }))
      pingInFlight = true
    } catch { /* onclose 接管 */ }
  }, HEARTBEAT_INTERVAL_MS)
}

async function probeHost(): Promise<boolean> {
  try {
    // 任何 HTTP 响应（含 401/5xx）都证明 host 进程可达；只有网络层失败才算不可达。
    await fetch('/api/version', { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(4000) })
    return true
  } catch {
    return false
  }
}

/** subscribe/resync 的探测闸门：常态（up 且 ws 已开）零开销放行；否则 REST 探测裁决。
 *  探测失败按 vendor「runtime 回收」语义 reject——store 有界退避重试（fresh subscribe
 *  和 unavailable 阶梯都吃这套），额度耗尽落整页错误面板。消息尾串是对 store 的
 *  isRuntimeRecycleError 的显式命中（auto-retry 与自愈路径靠它分诊）。 */
async function ensureHostReachable(): Promise<void> {
  if (hostConn.phase() === 'up' && liveWs?.readyState === WebSocket.OPEN) return
  if (await probeHost()) {
    hostConn.restOk()
    return
  }
  throw new Error('与 ocrc 主机的连接已断开（host unreachable）— ZCode Agent runtime is not running')
}

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
  // B7：live 只刷新**尾部小页**（20 消息）并与窗口合并——每 tick 取最新 200 消息页
  // 实测 61KB，小页化后 ~6KB；每 HISTORY_FULL_EVERY_TICKS 个 tick 兜一次全量。
  let window_: HistoryWindow
  try {
    window_ = await historyWindowFor(sessionId, true, 'tail')
  } catch {
    return
  }
  const cards = windowCards(window_)
  const nextRows = buildWindowRows(sessionId, window_, goalUi(sessionId))
  // The display is a pure function of the script, so a row rebuilt live gets it from the
  // cache — but a run started since the last snapshot needs the fetch to happen here too,
  // or its card would only gain its picture on the next full snapshot.
  await attachWorkflowDisplays(nextRows, await refreshWorkflowRuns(sessionId, nextRows), sessionId)
  await enrichToolRows(nextRows, sessionId)
  const deltas = diffRows(prevRows, nextRows)
  // U1：dock 投影独立于 rows diff——approval/question 卡的发布与 resolved 重发布
  // 都不改 rows，签名变了也要补一帧 state.updated（键级整替，见 delta.ts）。
  const nextInteractions = projectPendingInteractions(cards)
  const interactionsSig = JSON.stringify(nextInteractions)
  const interactionsChanged = lastInteractionsBySession.get(sessionId) !== interactionsSig
  // diff 空且投影未变即不发：此前用整行 stringify 判等守卫，浅比较版直接以 deltas.length 为准。
  if ((!deltas || deltas.length === 0) && !interactionsChanged) return
  lastRowsBySession.set(sessionId, nextRows)
  lastInteractionsBySession.set(sessionId, interactionsSig)
  for (const [subId, sub] of subs) {
    const lastSeq = lastSeqBySub.get(subId) ?? 0
    if (deltas) {
      const batch = interactionsChanged
        ? [...deltas, { op: 'state.updated', patch: { pendingInteractions: nextInteractions } }]
        : deltas
      if (batch.length === 0) continue
      deliverWire(sub.topic, subId, lastSeq, lastSeq + 1, { kind: 'deltas', deltas: batch }, 'online')
      lastSeqBySub.set(subId, lastSeq + 1)
    } else {
      const { snapshot, seq } = await buildSnapshotPayload(sessionId)
      deliverWire(sub.topic, subId, 0, seq, { kind: 'snapshot', snapshot }, 'online')
      lastSeqBySub.set(subId, seq)
      // 快照自带最新投影——基线以它为准（否则下个 tick 会误判「又变了」多发一帧）。
      lastInteractionsBySession.set(sessionId, JSON.stringify(snapshot.pendingInteractions))
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
  lastInteractionsBySession.delete(sessionId)
  // 窗口（含已加载的更早页）随退订丢弃；id 空间保留，重进同一会话时行身份不变。
  historyWindows.delete(sessionId)
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
    liveWsRetry = setTimeout(liveWsEnsure, HOST_RECONNECT_MS)
    return
  }
  liveWs.onopen = () => {
    hostConn.wsUp()
    startHeartbeat()
    // attach 时 wsHub 会推 hello；对每个受管会话显式订阅（sinceSeq 0 → 完整 replay，
    // 首帧 replay 经 liveUpdate 的 rows diff 自然去重）。
    for (const sessionId of watchedSessions) {
      try { liveWs?.send(JSON.stringify({ type: 'subscribe', sessionId, sinceSeq: 0 })) } catch { /* noop */ }
    }
  }
  liveWs.onmessage = (ev) => {
    // 任何服务端帧（pong/卡片/状态）都是活性证据：重置心跳与 REST 佐证连击。
    hostConn.restOk()
    pingInFlight = false
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
    // 批次 3：busy 帧同时驱动 conversation control（running 基线 + canStop 三连）。
    if (msg.type === 'session.status') setConversationBusy(sid, (msg as { busy?: boolean }).busy === true)
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
    stopHeartbeat()
    liveWs = null
    if (watchedSessions.size > 0) {
      // P5：掉线进入可见状态机（degraded → 封顶 down）；重连仍由本模块 3s 梯子驱动。
      hostConn.wsDown()
      liveWsRetry = setTimeout(liveWsEnsure, HOST_RECONNECT_MS)
    }
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
    console.warn('index frame zod FAIL:', JSON.stringify(check.error.issues.slice(0, 6).map((i) => ({ path: i.path.join('.'), msg: i.message }))))
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
    async subscribeConversationV4(params: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string }) {
      // P5 探测闸门：host 不可达时如实 reject（vendor 恢复阶梯接管），不回 ACK 后让
      // 快照静默失败——那会让 store 永远停在 connecting 转圈。
      await ensureHostReachable()
      const ack = {
        subscriptionId: `ocrc-sub-${uuid()}`,
        mode: 'snapshot',
        logEpoch: 'ocrc-1',
      }
      // transport 不传 topic——topic 由会话侧构造：conversation/<sessionId>
      const sessionId = params?.sessionId
      const topic = sessionId ? `conversation/${sessionId}` : undefined
      if (topic && sessionId) {
        subscriptions.set(ack.subscriptionId, {
          sessionId,
          topic,
          // lifecycle 事件按此 key 过滤（transport 侧 = workspaceIdentity || workspacePath）。
          workspaceKey: String(params?.workspaceIdentity ?? '').trim() || String(params?.workspacePath ?? ''),
        })
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
      if (!sub || !subId) {
        // 未登记的订阅（世代/重启后残留）：notOwned 让 store fresh subscribe 自愈
        throw new Error('fault.subscription.notOwned')
      }
      // P5 探测闸门（与 subscribe 同语义）：host 不可达 → 如实 reject，走恢复阶梯。
      await ensureHostReachable()
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
    // 「加载更早」：store 以窗口首行 rowId 作游标向更早分页。B7 起按服务端
    // offset 语义真翻页（[len-limit-offset, len-offset)）：已加载窗口里够不够
    // 一页就先切；不够则向引擎再要一页更早消息前插，直到凑够或确认耗尽。
    // 行 id 单调（见 rowIdFor），所以游标用位置查（findIndex）而不是数值过滤——
    // 数值过滤在内容寻址空间下会错切。
    async conversationRowsRangeV4(params: { sessionId: string; beforeRowId?: number; limit: number }) {
      const sessionId = params.sessionId
      const limit = Math.max(1, Math.min(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit, params.limit || PROTOCOL_V4_LIMITS.snapshotTailWindowRows))
      const w = await historyWindowFor(sessionId, false)
      let rows = buildWindowRows(sessionId, w)
      await enrichToolRows(rows, sessionId)
      const cursorAt = (): number => {
        const before = params.beforeRowId
        if (before === undefined) return rows.length
        const exact = rows.findIndex((r) => r.rowId === before)
        // 单调 id：游标行不在（被逐出）时取第一个 ≥ 游标的行作位置边界。
        return exact !== -1 ? exact : rows.findIndex((r) => r.rowId >= before)
      }
      let idx = cursorAt()
      if (idx === -1) idx = 0
      // 更早页按需前插：最多 5 页（1000 条消息）防单次调用失控。
      for (let round = 0; round < 5 && idx < limit && !w.exhausted; round++) {
        const page = await ocrcHistory(sessionId, w.nextOlderOffset).catch(() => null)
        if (!page || page.length === 0) {
          w.exhausted = true
          break
        }
        w.nextOlderOffset += HISTORY_PAGE
        if (page.length < HISTORY_PAGE) w.exhausted = true
        // 发号：更早页在数组序上 id 必须递增——vendor 的 mergeOlderRows/裁剪按
        // `rowId < 窗口首行` 做数值过滤，页内乱序会丢行。整块按行序分配（见
        // assignOlderPageIds）：只逆到卡级不够——卡内 header/input 仍会倒序。
        assignOlderPageIds(sessionId, page)
        w.older = [...page, ...w.older]
        rows = buildWindowRows(sessionId, w)
        await enrichToolRows(rows, sessionId)
        idx = cursorAt()
        if (idx === -1) idx = 0
      }
      const start = Math.max(0, idx - limit)
      const page = rows.slice(start, idx)
      // 前插改变了桥接侧的行基线：同步给 live diff 的基线，否则下一 tick 的
      // 前缀失配会退化成全量快照（把刚加载的更早行从 vendor 窗口里冲掉）。
      lastRowsBySession.set(sessionId, rows)
      return {
        rows: page,
        atSeq: rows.length,
        atRevision: 1,
        atLogEpoch: 'ocrc-1',
        // 还有更早的行 = 本次窗口内没切到的部分非空 或 引擎侧还没翻到尽头
        hasMore: start > 0 || windowHasOlder(w),
      }
    },
    // 计划目录（状态面板「计划」区 + 计划详情侧页的目录源）。vendor 的
    // v4ConversationPlansResultSchema：plans = 当前分支终态 ExitPlanMode 行、rowId 降序
    // （最新优先），atLogEpoch 必须与快照一致（store 用它对账，不匹配整体丢弃）。
    // 数据与时间线计划卡同源——同一份 buildRows 结果过滤，不另开一条取数路径。
    async conversationPlansV4(params: { sessionId: string }) {
      // refresh：计划目录要读当前历史（旧实现每次现取），不能吃已加载窗口的旧快照。
      const window_ = await historyWindowFor(params.sessionId, true)
      const rows = buildWindowRows(params.sessionId, window_)
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
        // vendor 的 Event<T> 契约（rpc/foundation.ts:71）：Event(listener) 返回
        // IDisposable —— agentConversationTransport 退订时调 upstream?.dispose()。
        // 此前返回裸函数，移动壳「聊天页 → 返回首页」卸载 chat 触发退订即抛
        // TypeError（g?.dispose is not a function），错误边界把整个内容区换掉。
        // 同时保持可调用（ghost.ts 的双形状约定）。
        const unsubscribe: any = () => { frameListeners.delete(listener) }
        unsubscribe.dispose = () => { frameListeners.delete(listener) }
        return unsubscribe
      }
    },
    // P5：host 连接生命周期事件（transport 过滤 workspaceKey 后交给 store 的恢复阶梯：
    // unavailable → 有界退避探测重连 → 额度耗尽整页面板；available → 按水位 resync 自愈）。
    onAgentRuntimeLifecycle(listener: (event: { workspaceKey: string; state: 'available' | 'unavailable' }) => void) {
      lifecycleListeners.add(listener)
      return { dispose: () => { lifecycleListeners.delete(listener) } }
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
        // 附件：web 端选文件时 platform 把 File 存进寄存表、ref 以 ocrc-webfile://
        // 透传到这里——解析回字节。图片走 /api/message 的 images[]（引擎原生图片
        // 输入）；其余类型走 B8 的 attachments[]（host 落盘 + 路径注入，TG 同款）。
        // 边界在客户端先判一次（UX：不用等一个来回），host 侧还会再验一遍。
        const rawAttachments = (envelope.payload as { attachments?: Array<{ ref?: string; fileName?: string }> }).attachments ?? []
        const images: Array<{ data: string; mimeType: string }> = []
        const files: Array<{ name: string; mimeType: string; data: string }> = []
        for (const att of rawAttachments) {
          const file = att?.ref ? resolveWebFile(att.ref) : undefined
          if (!file) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_attachment_unsupported', message: `附件 ${att?.fileName ?? att?.ref ?? ''} 不是本页选择的文件`, revisionAtDecision: 0 }
          }
          const name = att?.fileName ?? (file as File).name ?? 'attachment'
          if (/^image\//.test(file.type)) {
            images.push({ data: await toBase64(file), mimeType: file.type })
            continue
          }
          // 白名单：可执行/脚本类拒收（权威清单在 host 侧 src/core/attachments.ts）。
          const ext = (name.split('.').pop() ?? '').toLowerCase()
          if (BLOCKED_ATTACHMENT_EXT.has(ext)) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_attachment_blocked', message: `附件 ${name} 是可执行/脚本类，已拒绝（上行白名单）`, revisionAtDecision: 0 }
          }
          if (file.size > ATTACHMENT_MAX_BYTES) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_attachment_too_large', message: `附件 ${name} 超过 20MB 上限`, revisionAtDecision: 0 }
          }
          files.push({ name, mimeType: file.type || 'application/octet-stream', data: await toBase64(file) })
        }
        // ── U5：斜杠命令执行链 ──
        // vendor composer 的 `/` 面板选中命令 = 插入 markdown `/<name>` 的 mention，
        // 发送即 "/name args" 文本。引擎不认识斜杠（那是 CLI 语义）——这里拦下首个
        // token 命中 ocrc 命令目录的文本，转 POST /api/command（引擎原生
        // session.command）；未命中照常走 /api/message（引擎收到字面 "/foo" 无害）。
        const slashMatch = /^(\/)([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
        if (slashMatch) {
          try {
            const cat = await fetch('/api/commands', { headers: { Authorization: `Bearer ${token()}` } })
            const commands = cat.ok ? ((await cat.json()) as Array<{ name?: string }>) : []
            const name = commands.find((c) => c.name === slashMatch[2])?.name
            if (name) {
              const res = await fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ sessionId, command: name, arguments: slashMatch[3] ?? '' }),
              })
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string }
                return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_command_failed', message: body.error ?? `POST /api/command ${res.status}`, revisionAtDecision: 0 }
              }
              return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
            }
          } catch { /* 目录不可达 → 按普通消息发送 */ }
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
            ...(files.length ? { attachments: files } : {}),
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
      if (envelope.type === 'stop') {
        // 批次 3 canStop 三连的执行端：停止按钮 / Esc / 运行中排队 placeholder 都汇聚到
        // 这条命令 → 引擎 /api/abort；busy=false 的 session.status 帧随后把 control 拉回 idle。
        if (!sessionId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'stop 缺 sessionId', revisionAtDecision: 0 }
        }
        const res = await fetch('/api/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ sessionId }),
        })
        return res.ok
          ? { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
          : { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_stop_failed', message: `POST /api/abort ${res.status}`, revisionAtDecision: 0 }
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
      // ── U1 交互回程：权限 → /api/approval；提问 → /api/question/reply|reject ──
      // vendor 侧：PermissionDialog onRespond({optionId}) / ElicitationDialog
      // onRespond({action, content})。optionId 与 host decision 同词（投影时约定）。
      if (envelope.type === 'resolveInteraction') {
        if (!sessionId) throw new Error('[ocrc-fork] resolveInteraction 缺 sessionId')
        const interactionId = String((envelope.payload as { interactionId?: string }).interactionId ?? '')
        const answer = (envelope.payload as { answer?: { optionId?: string; freeText?: string; action?: string; content?: Record<string, unknown> } }).answer ?? {}
        if (!interactionId) {
          return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'resolveInteraction 缺 interactionId', revisionAtDecision: 0 }
        }
        const post = async (path: string, body: Record<string, unknown>) =>
          fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify(body) })
        // 权限：optionId→decision（once/always/reject）。freeText 反馈 host 无承接
        // 字段（TG 同样只传 decision）——如实忽略，不伪造。
        if (answer.optionId !== undefined) {
          const decision = decisionFromOptionId(answer.optionId)
          if (!decision) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_unknown_option', message: `未知权限选项 ${answer.optionId}`, revisionAtDecision: 0 }
          }
          const res = await post('/api/approval', { sessionId, requestId: interactionId, decision })
          if (!res.ok) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_approval_failed', message: `POST /api/approval ${res.status}`, revisionAtDecision: 0 }
          }
          return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
        }
        // 提问：accept → 组 answers 矩阵回复；decline/cancel → 拒答（TG 同款）。
        if (answer.action !== undefined) {
          if (answer.action === 'accept') {
            const cards = await ocrcHistory(sessionId).catch(() => null)
            const card = cards?.find((c) => c.kind === 'question' && c.requestId === interactionId)
            const answers = contentToAnswerRows(card?.questions, answer.content)
            const res = await post('/api/question/reply', { sessionId, requestId: interactionId, answers })
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string }
              return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_question_failed', message: body.error ?? `POST /api/question/reply ${res.status}`, revisionAtDecision: 0 }
            }
            return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
          }
          const res = await post('/api/question/reject', { sessionId, requestId: interactionId })
          if (!res.ok) {
            return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_question_failed', message: `POST /api/question/reject ${res.status}`, revisionAtDecision: 0 }
          }
          return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0 }
        }
        return { commandId: envelope.commandId, status: 'failed', reasonCode: 'ocrc_bad_payload', message: 'resolveInteraction.answer 缺 optionId/action', revisionAtDecision: 0 }
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
