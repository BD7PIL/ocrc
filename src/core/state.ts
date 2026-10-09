import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('state')

/** Minimum length for a short display suffix to be resolved via endsWith. */
const MIN_SUFFIX_LEN = 6

/** Goal 的持久状态（对齐上游运行时四态；verifying/verified/notSatisfied/failed
 *  是投影态，从不落库，由桥接层从 status + verifierRunning 派生）。 */
export type GoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete'

/** 一次验收结论。outcome 是投影三态在「已结束」侧的取值：
 *  pass=验收通过（goal 完成）、notSatisfied=未达成（可续跑）、failed=验收器自身
 *  失败/解析失败（fail-closed 停机）。 */
export interface GoalVerification {
  iteration: number
  outcome: 'pass' | 'notSatisfied' | 'failed'
  at: number
  reason?: string
  nextAction?: string
}

/** 一轮迭代的待办快照。items 用 vendor 的 planItem 形状（`{id, content, status}`）
 *  —— goal 摘要面板按它算每轮完成度，字符串数组对不上投影。 */
export interface GoalIteration {
  iteration: number
  items: Array<{ id: string; content: string; status: 'pending' | 'inProgress' | 'completed' }>
  updatedAt: number
}

/** 一个会话的 goal（host state.json 槽位，按 sessionId 存）。
 *  注意：`verifierRunning` 是瞬时状态，不入此记录——由 goalManager 在内存里持有，
 *  桥接层派生态时再合入。 */
export interface GoalRecord {
  targetId: string
  objective: string
  summaryTitle?: string
  status: GoalStatus
  iteration: number
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  activeRunStartedAtMs?: number
  verifications: GoalVerification[]
  iterations: GoalIteration[]
}

interface PersistedState {
  lastSessionId?: string
  pinnedSessionId?: string
  nextAgent?: string
  nextModel?: { providerID: string; modelID: string }
  nextVariant?: string
  tuiSelectedSession?: string
  currentAgent?: string
  activeWorkspace?: string
  /** Multi-backend: which backend owns each session (sid → backendId). */
  sessionBackends?: Record<string, string>
  /** Multi-backend: the backend new sessions are created on (UI selection). */
  activeBackend?: string
  /** 0.27: per-session host approval policy — 'edit' auto-approves edit-class
   *  permission requests, 'yolo' auto-approves ALL of them (plan/build remain
   *  native engine modes; the policy layers on top of 'build'). */
  sessionApprovalPolicy?: Record<string, 'edit' | 'yolo'>
  /** UI bookmarks (/z/ sidebar pinned section). NOT the same thing as
   *  `pinnedSessionId`, which is the relay's routing target. */
  pinnedTaskIds?: string[]
  /** /z/ sidebar unread dots — sessions the user has not looked at yet. The
   *  backends hardcode `unread:false`, so this is the only source of truth. */
  unreadSessionIds?: string[]
  /** /z/ archived tasks (ZCode 语义：归档 = 从默认列表隐藏，可恢复/可删）。 */
  archivedSessionIds?: string[]
  /** N10 /z/ sidebar task groups (global organizational dimension — the sidebar
   *  already filters by workspace for display; groups are the user's own
   *  cross-workspace organization). Shape mirrors vendor ZCodeTaskGroup +
   *  membership + view order, minus anything the client derives. */
  taskGroups?: Array<{ id: string; title: string; color: string; createdAt: number; updatedAt: number }>
  taskGroupMembers?: Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number | null; addedAt: number }>
  taskGroupTopOrders?: Array<{ type: 'group'; groupId: string; sortOrder: number } | { type: 'task'; workspaceKey: string; taskId: string; sortOrder: number }>
  /** N12: per-session goals (sid → GoalRecord). Authoritative copy lives here —
   *  the /z/ UI and TG both read this through the host, never their own store. */
  goals?: Record<string, GoalRecord>
}

export interface SessionState {
  getLastSessionId(): string | undefined
  setLastSessionId(id: string | undefined): void
  getPinnedSessionId(): string | undefined
  setPinnedSessionId(id: string | undefined): void
  getNextAgent(): string | undefined
  setNextAgent(name: string | undefined): void
  getNextVariant(): string | undefined
  setNextVariant(v: string | undefined): void
  getNextModel(): { providerID: string; modelID: string } | undefined
  setNextModel(m: { providerID: string; modelID: string } | undefined): void
  getTuiSelectedSession(): string | undefined
  setTuiSelectedSession(id: string | undefined): void
  getCurrentAgent(): string | undefined
  setCurrentAgent(name: string | undefined): void
  getActiveWorkspace(): string | undefined
  setActiveWorkspace(dir: string | undefined): void
  getActiveAbort(sessionId: string): AbortController | undefined
  setActiveAbort(sessionId: string, ac: AbortController | undefined): void
  /**
   * True while a generation is in flight (abort registered). With a sessionId,
   * checks only that session (short suffixes are normalized first, and both the
   * raw and normalized forms are matched); without one, keeps the global
   * any-session semantics.
   */
  hasActiveGeneration(sessionId?: string): boolean
  /** Record that the relay just delivered an assistant card for this session. */
  markAssistantDelivered(sessionId: string): void
  /** Epoch ms of the last relay-delivered assistant card for this session. */
  getAssistantDeliveredAt(sessionId: string): number | undefined
  /** Free all in-memory per-session bookkeeping for a deleted session. */
  dropSession(sessionId: string): void
  /** Live busy/idle flag per session (from session.status/idle events) — feeds
   * the plan-HUD subagent rows (running vs done). In-memory only. */
  setSessionBusy(sessionId: string, busy: boolean): void
  isSessionBusy(sessionId: string): boolean
  /** M9: last-turn-failed latch — error card sets it, next user card clears. */
  setSessionError(sessionId: string, hasError: boolean): void
  isSessionError(sessionId: string): boolean
  /** /z/ sidebar bookmarks (order preserved; most recently pinned first). */
  listPinnedTaskIds(): string[]
  isTaskPinned(sessionId: string): boolean
  setTaskPinned(sessionId: string, pinned: boolean): void
  /** /z/ sidebar unread dots. */
  isSessionUnread(sessionId: string): boolean
  setSessionUnread(sessionId: string, unread: boolean): void
  /** /z/ archived tasks. */
  listArchivedSessionIds(): string[]
  isSessionArchived(sessionId: string): boolean
  setSessionArchived(sessionId: string, archived: boolean): void
  /** N10: /z/ sidebar task groups (structure + membership + view order). */
  listTaskGroups(): Array<{ id: string; title: string; color: string; createdAt: number; updatedAt: number }>
  createTaskGroup(title: string, color: string): { id: string; title: string; color: string; createdAt: number; updatedAt: number }
  renameTaskGroup(groupId: string, title: string): { id: string; title: string; color: string; createdAt: number; updatedAt: number } | undefined
  updateTaskGroupColor(groupId: string, color: string): { id: string; title: string; color: string; createdAt: number; updatedAt: number } | undefined
  deleteTaskGroup(groupId: string): boolean
  listTaskGroupMembers(): Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number | null; addedAt: number }>
  listTaskGroupTopOrders(): Array<{ type: 'group'; groupId: string; sortOrder: number } | { type: 'task'; workspaceKey: string; taskId: string; sortOrder: number }>
  applyGroupedTaskView(members: Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number | null; addedAt: number }>, topOrders: Array<{ type: 'group'; groupId: string; sortOrder: number } | { type: 'task'; workspaceKey: string; taskId: string; sortOrder: number }>): void
  getSessionCost(sessionId: string): number | undefined
  setSessionCost(sessionId: string, cost: number | undefined): void
  /** N12: per-session goal record (deep clone — callers may mutate freely). */
  getGoal(sessionId: string): GoalRecord | undefined
  /** Replace a session's goal record wholesale. */
  setGoal(sessionId: string, goal: GoalRecord): void
  /** Shallow-merge a patch into a session's goal; undefined if none exists. */
  updateGoal(sessionId: string, patch: Partial<GoalRecord>): GoalRecord | undefined
  /** Remove a session's goal; true if one was present. */
  clearGoal(sessionId: string): boolean
  /** All goals, keyed by sessionId (deep clone). */
  listGoals(): Record<string, GoalRecord>
  /** Multi-backend: the backend that owns a session (undefined → default). */
  getSessionBackend(sessionId: string): string | undefined
  setSessionBackend(sessionId: string, backendId: string | undefined): void
  /** Multi-backend: the backend new sessions are created on. */
  getActiveBackend(): string | undefined
  setActiveBackend(backendId: string | undefined): void
  /** 0.27: host-side approval routing (PRODUCT.md 权限四档). */
  getSessionApprovalPolicy(sessionId: string): 'edit' | 'yolo' | undefined
  setSessionApprovalPolicy(sessionId: string, policy: 'edit' | 'yolo' | undefined): void
  /**
   * Normalize a short display ID (suffix) to the full session ID used as the
   * cardBus / pluginSessions key.  Full IDs ("ses_*", "session_*", UUIDs) pass
   * through unchanged.  Short suffixes are matched against sessionBackends keys.
   */
  normalizeSessionId(sessionId: string): string
  /** Per-session suggested follow-ups (Tier2, in-memory, 10-min TTL). */
  getSessionSuggestions(sessionId: string): string[] | undefined
  setSessionSuggestions(sessionId: string, items: string[]): void
  flush(): Promise<void>
}

export function createFileBackedState(path: string): SessionState {
  let cache: PersistedState = load(path)
  let writeQueued: NodeJS.Timeout | undefined
  let pending: Promise<void> | undefined
  let resolvePending: (() => void) | undefined
  const aborts = new Map<string, AbortController>()
  // In-memory only — suggestions are ephemeral UI sugar, never state of record.
  const sessionSuggestions = new Map<string, { items: string[]; at: number }>()
  const sessionCosts = new Map<string, number>()
  const sessionBusy = new Map<string, boolean>()
  // M9: last-turn-failed latch (set by an 'error' card, cleared by the next
  // user card) — surfaces as the task-row red dot. In-memory like busy.
  const sessionError = new Map<string, boolean>()
  const assistantDeliveredAt = new Map<string, number>()

  const normalizeSessionId = (sessionId: string): string => {
    // Guard: undefined throws on startsWith, and '' matches EVERY key via
    // endsWith('') — pass both through untouched.
    if (!sessionId) return sessionId
    // Full IDs (opencode ses_*, ACP session_*, raw UUIDs) pass through.
    if (sessionId.startsWith('ses_') || sessionId.startsWith('session_') || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return sessionId
    }
    // Short display suffix — too short to disambiguate reliably.
    if (sessionId.length < MIN_SUFFIX_LEN) return sessionId
    // Scan sessionBackends for full keys ending in the suffix.
    const backs = cache.sessionBackends ?? {}
    const matches = Object.keys(backs).filter((key) => key.endsWith(sessionId))
    if (matches.length === 1) return matches[0]
    // Ambiguous — fail loud instead of silently picking an arbitrary session.
    if (matches.length > 1) {
      log.warn(`normalizeSessionId: suffix "${sessionId}" matches ${matches.length} sessions; leaving unresolved`)
    }
    // No match found; return input as-is (graceful fallback).
    return sessionId
  }

  // Debounced atomic write. All set() calls within the debounce window share a
  // single pending promise that resolves once the write lands — earlier code
  // created a fresh promise per call and cleared the prior timer, so every
  // promise but the last never resolved (flush()'s await could hang).
  function persist(): Promise<void> {
    if (!pending) {
      pending = new Promise<void>((res) => { resolvePending = res })
    }
    if (writeQueued) clearTimeout(writeQueued)
    writeQueued = setTimeout(() => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp`
        writeFileSync(tmp, JSON.stringify(cache, null, 2))
        renameSync(tmp, path)
      } catch (err) {
        log.warn('failed to persist state', (err as Error).message)
      }
      writeQueued = undefined
      const res = resolvePending
      pending = undefined
      resolvePending = undefined
      res?.()
    }, 100)
    return pending
  }

  return {
    getLastSessionId: () => cache.lastSessionId,
    setLastSessionId: (id) => {
      if (id === undefined) delete cache.lastSessionId
      else cache.lastSessionId = id
      void persist()
    },
    getPinnedSessionId: () => cache.pinnedSessionId,
    setPinnedSessionId: (id) => {
      if (id === undefined) delete cache.pinnedSessionId
      else cache.pinnedSessionId = id
      void persist()
    },
    getNextAgent: () => cache.nextAgent,
    setNextAgent: (name) => {
      if (name === undefined) delete cache.nextAgent
      else cache.nextAgent = name
      void persist()
    },
    getNextVariant: () => cache.nextVariant,
    setNextVariant: (v) => {
      if (v === undefined) delete cache.nextVariant
      else cache.nextVariant = v
      void persist()
    },
    getNextModel: () => cache.nextModel,
    setNextModel: (m) => {
      if (m === undefined) delete cache.nextModel
      else cache.nextModel = m
      void persist()
    },
    getTuiSelectedSession: () => cache.tuiSelectedSession,
    setTuiSelectedSession: (id) => {
      if (id === undefined) delete cache.tuiSelectedSession
      else cache.tuiSelectedSession = id
      void persist()
    },
    getCurrentAgent: () => cache.currentAgent,
    setCurrentAgent: (name) => {
      if (name === undefined) delete cache.currentAgent
      else cache.currentAgent = name
      void persist()
    },
    getActiveWorkspace: () => cache.activeWorkspace,
    setActiveWorkspace: (dir) => {
      if (dir === undefined) delete cache.activeWorkspace
      else cache.activeWorkspace = dir
      void persist()
    },
    getActiveAbort: (sid) => aborts.get(sid),
    setActiveAbort: (sid, ac) => {
      if (ac === undefined) aborts.delete(sid)
      else aborts.set(sid, ac)
    },
    hasActiveGeneration: (sessionId?: string) => {
      if (sessionId === undefined) return aborts.size > 0
      const normalized = normalizeSessionId(sessionId)
      return aborts.has(normalized) || (normalized !== sessionId && aborts.has(sessionId))
    },
    markAssistantDelivered: (sid) => { assistantDeliveredAt.set(sid, Date.now()) },
    getAssistantDeliveredAt: (sid) => assistantDeliveredAt.get(sid),
    dropSession: (sid) => {
      sessionBusy.delete(sid)
      aborts.get(sid)?.abort()
      aborts.delete(sid)
      sessionCosts.delete(sid)
      assistantDeliveredAt.delete(sid)
      let dirty = false
      if (cache.lastSessionId === sid) { delete cache.lastSessionId; dirty = true }
      if (cache.pinnedSessionId === sid) { delete cache.pinnedSessionId; dirty = true }
      if (cache.tuiSelectedSession === sid) { delete cache.tuiSelectedSession; dirty = true }
      if (cache.sessionBackends?.[sid]) { delete cache.sessionBackends[sid]; dirty = true }
      if (cache.sessionApprovalPolicy?.[sid]) { delete cache.sessionApprovalPolicy[sid]; dirty = true }
      if (cache.pinnedTaskIds?.includes(sid)) {
        cache.pinnedTaskIds = cache.pinnedTaskIds.filter((id) => id !== sid)
        if (!cache.pinnedTaskIds.length) delete cache.pinnedTaskIds
        dirty = true
      }
      if (cache.unreadSessionIds?.includes(sid)) {
        cache.unreadSessionIds = cache.unreadSessionIds.filter((id) => id !== sid)
        if (!cache.unreadSessionIds.length) delete cache.unreadSessionIds
        dirty = true
      }
      if (cache.archivedSessionIds?.includes(sid)) {
        cache.archivedSessionIds = cache.archivedSessionIds.filter((id) => id !== sid)
        if (!cache.archivedSessionIds.length) delete cache.archivedSessionIds
        dirty = true
      }
      if (cache.goals?.[sid]) {
        delete cache.goals[sid]
        if (!Object.keys(cache.goals).length) delete cache.goals
        dirty = true
      }
      if (dirty) void persist()
      sessionError.delete(sid)
    },
    setSessionBusy: (sid, busy) => { if (busy) sessionBusy.set(sid, true); else sessionBusy.delete(sid) },
    isSessionBusy: (sid) => sessionBusy.get(sid) === true,
    setSessionError: (sid, hasError) => { if (hasError) sessionError.set(sid, true); else sessionError.delete(sid) },
    isSessionError: (sid) => sessionError.get(sid) === true,
    listPinnedTaskIds: () => [...(cache.pinnedTaskIds ?? [])],
    isTaskPinned: (sid) => (cache.pinnedTaskIds ?? []).includes(sid),
    setTaskPinned: (sid, pinned) => {
      const current = cache.pinnedTaskIds ?? []
      const next = pinned
        ? [sid, ...current.filter((id) => id !== sid)]
        : current.filter((id) => id !== sid)
      if (next.length) cache.pinnedTaskIds = next
      else delete cache.pinnedTaskIds
      void persist()
    },
    isSessionUnread: (sid) => (cache.unreadSessionIds ?? []).includes(sid),
    setSessionUnread: (sid, unread) => {
      const current = cache.unreadSessionIds ?? []
      const next = unread
        ? (current.includes(sid) ? current : [...current, sid])
        : current.filter((id) => id !== sid)
      if (next.length) cache.unreadSessionIds = next
      else delete cache.unreadSessionIds
      void persist()
    },
    listArchivedSessionIds: () => [...(cache.archivedSessionIds ?? [])],
    isSessionArchived: (sid) => (cache.archivedSessionIds ?? []).includes(sid),
    setSessionArchived: (sid, archived) => {
      const current = cache.archivedSessionIds ?? []
      const next = archived
        ? (current.includes(sid) ? current : [...current, sid])
        : current.filter((id) => id !== sid)
      if (next.length) cache.archivedSessionIds = next
      else delete cache.archivedSessionIds
      void persist()
    },
    listTaskGroups: () => JSON.parse(JSON.stringify(cache.taskGroups ?? [])),
    createTaskGroup: (title, color) => {
      const now = Date.now()
      const group = { id: `tg_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, title, color, createdAt: now, updatedAt: now }
      ;(cache.taskGroups ??= []).push(group)
      void persist()
      return group
    },
    renameTaskGroup: (groupId, title) => {
      const g = (cache.taskGroups ?? []).find((x) => x.id === groupId)
      if (!g) return undefined
      g.title = title
      g.updatedAt = Date.now()
      void persist()
      return { ...g }
    },
    updateTaskGroupColor: (groupId, color) => {
      const g = (cache.taskGroups ?? []).find((x) => x.id === groupId)
      if (!g) return undefined
      g.color = color
      g.updatedAt = Date.now()
      void persist()
      return { ...g }
    },
    deleteTaskGroup: (groupId) => {
      const before = (cache.taskGroups ?? []).length
      cache.taskGroups = (cache.taskGroups ?? []).filter((x) => x.id !== groupId)
      // 组删了成员跟着走（vendor 语义：调用方先把任务移回顶层；这里兜底清理）。
      cache.taskGroupMembers = (cache.taskGroupMembers ?? []).filter((m) => m.groupId !== groupId)
      cache.taskGroupTopOrders = (cache.taskGroupTopOrders ?? []).filter((o) => !(o.type === 'group' && o.groupId === groupId))
      const changed = cache.taskGroups.length !== before
      if (!cache.taskGroups.length) delete cache.taskGroups
      if (!cache.taskGroupMembers?.length) delete cache.taskGroupMembers
      if (!cache.taskGroupTopOrders?.length) delete cache.taskGroupTopOrders
      if (changed) void persist()
      return changed
    },
    listTaskGroupMembers: () => JSON.parse(JSON.stringify(cache.taskGroupMembers ?? [])),
    listTaskGroupTopOrders: () => JSON.parse(JSON.stringify(cache.taskGroupTopOrders ?? [])),
    applyGroupedTaskView: (members, topOrders) => {
      cache.taskGroupMembers = members.length ? members : undefined
      cache.taskGroupTopOrders = topOrders.length ? topOrders : undefined
      void persist()
    },
    getSessionCost: (sid) => sessionCosts.get(sid),
    setSessionCost: (sid, cost) => {
      if (cost === undefined) sessionCosts.delete(sid)
      else sessionCosts.set(sid, cost)
    },
    getGoal: (sid) => {
      const g = cache.goals?.[sid]
      return g ? (JSON.parse(JSON.stringify(g)) as GoalRecord) : undefined
    },
    setGoal: (sid, goal) => {
      ;(cache.goals ??= {})[sid] = JSON.parse(JSON.stringify(goal)) as GoalRecord
      void persist()
    },
    updateGoal: (sid, patch) => {
      const g = cache.goals?.[sid]
      if (!g) return undefined
      cache.goals![sid] = { ...g, ...patch }
      void persist()
      return JSON.parse(JSON.stringify(cache.goals![sid])) as GoalRecord
    },
    clearGoal: (sid) => {
      if (!cache.goals?.[sid]) return false
      delete cache.goals[sid]
      if (!Object.keys(cache.goals).length) delete cache.goals
      void persist()
      return true
    },
    listGoals: () => JSON.parse(JSON.stringify(cache.goals ?? {})) as Record<string, GoalRecord>,
    getSessionBackend: (sid) => cache.sessionBackends?.[sid],
    setSessionBackend: (sid, backendId) => {
      if (backendId === undefined) {
        if (cache.sessionBackends) delete cache.sessionBackends[sid]
      } else {
        ;(cache.sessionBackends ??= {})[sid] = backendId
      }
      void persist()
    },
    getSessionApprovalPolicy: (sid) => cache.sessionApprovalPolicy?.[sid],
    setSessionApprovalPolicy: (sid, policy) => {
      if (policy === undefined) {
        if (cache.sessionApprovalPolicy) delete cache.sessionApprovalPolicy[sid]
      } else {
        ;(cache.sessionApprovalPolicy ??= {})[sid] = policy
      }
      void persist()
    },
    getActiveBackend: () => cache.activeBackend,
    setActiveBackend: (backendId) => {
      if (backendId === undefined) delete cache.activeBackend
      else cache.activeBackend = backendId
      void persist()
    },
    normalizeSessionId,
    getSessionSuggestions: (sid) => {
      const e = sessionSuggestions.get(sid)
      if (!e) return undefined
      if (Date.now() - e.at > 10 * 60_000) { sessionSuggestions.delete(sid); return undefined }
      return e.items
    },
    setSessionSuggestions: (sid, items) => {
      sessionSuggestions.set(sid, { items, at: Date.now() })
    },
    flush: async () => persist(),
  }
}

function load(path: string): PersistedState {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as PersistedState
  } catch (err) {
    log.warn(`state file malformed, treating as empty: ${(err as Error).message}`)
    return {}
  }
}
