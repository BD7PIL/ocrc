import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('state')

/** Minimum length for a short display suffix to be resolved via endsWith. */
const MIN_SUFFIX_LEN = 6

interface PersistedState {
  lastSessionId?: string
  pinnedSessionId?: string
  nextAgent?: string
  nextModel?: { providerID: string; modelID: string }
  tuiSelectedSession?: string
  currentAgent?: string
  activeWorkspace?: string
  /** Multi-backend: which backend owns each session (sid → backendId). */
  sessionBackends?: Record<string, string>
  /** Multi-backend: the backend new sessions are created on (UI selection). */
  activeBackend?: string
}

export interface SessionState {
  getLastSessionId(): string | undefined
  setLastSessionId(id: string | undefined): void
  getPinnedSessionId(): string | undefined
  setPinnedSessionId(id: string | undefined): void
  getNextAgent(): string | undefined
  setNextAgent(name: string | undefined): void
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
  getSessionCost(sessionId: string): number | undefined
  setSessionCost(sessionId: string, cost: number | undefined): void
  /** Multi-backend: the backend that owns a session (undefined → default). */
  getSessionBackend(sessionId: string): string | undefined
  setSessionBackend(sessionId: string, backendId: string | undefined): void
  /** Multi-backend: the backend new sessions are created on. */
  getActiveBackend(): string | undefined
  setActiveBackend(backendId: string | undefined): void
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
      if (dirty) void persist()
    },
    setSessionBusy: (sid, busy) => { if (busy) sessionBusy.set(sid, true); else sessionBusy.delete(sid) },
    isSessionBusy: (sid) => sessionBusy.get(sid) === true,
    getSessionCost: (sid) => sessionCosts.get(sid),
    setSessionCost: (sid, cost) => {
      if (cost === undefined) sessionCosts.delete(sid)
      else sessionCosts.set(sid, cost)
    },
    getSessionBackend: (sid) => cache.sessionBackends?.[sid],
    setSessionBackend: (sid, backendId) => {
      if (backendId === undefined) {
        if (cache.sessionBackends) delete cache.sessionBackends[sid]
      } else {
        ;(cache.sessionBackends ??= {})[sid] = backendId
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
