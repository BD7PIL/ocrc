import type { StructuredCard, SessionSummary } from './types.js'
import { clearAuthReloadFlag } from '../auth-reload.js'
import { onUnauthorized } from '../auth.js'
import { getToken } from '../auth-token.js'

let base = ''

export function setBaseUrl(url: string) {
  base = url.replace(/\/$/, '')
}

// Attach the app token as a Bearer header when present (token-auth mode);
// `credentials: 'include'` keeps the CF Access cookie working when that mode is on.
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) }
  const t = getToken()
  if (t) h['authorization'] = `Bearer ${t}`
  return h
}

async function jsonGet<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { credentials: 'include', headers: authHeaders() })
  if (res.status === 401) { onUnauthorized(); throw new Error(`GET ${path} 401`) }
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
}

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (res.status === 401) { onUnauthorized(); throw new Error(`POST ${path} 401`) }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
}

async function jsonMethod<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: authHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) { onUnauthorized(); throw new Error(`${method} ${path} 401`) }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
}

async function jsonPatch<T>(path: string, body: unknown): Promise<T> {
  return jsonMethod('PATCH', path, body)
}

async function jsonDelete<T>(path: string): Promise<T> {
  return jsonMethod('DELETE', path)
}

export const api = {
  me: () => jsonGet<{ email: string }>('/api/me'),
  capabilities: () => jsonGet<{ id: string; capabilities: Record<string, boolean> }>('/api/capabilities'),
  backends: () => jsonGet<{ backends: { id: string; capabilities: Record<string, boolean> }[]; activeId: string }>('/api/backends'),
  setActiveBackend: (backendId: string) => jsonPost<{ ok: boolean; activeId: string }>('/api/backends/active', { backendId }),
  sessions: () => jsonGet<SessionSummary[]>('/api/sessions'),
  cleanupSubagents: () => jsonPost<{ deleted: number }>('/api/sessions/cleanup-subagents', {}),
  deleteSession: (id: string) => jsonPost<{ ok: boolean }>(`/api/sessions/${id}/delete`, {}),
  renameSession: (id: string, title: string) => jsonPost<{ ok: boolean }>(`/api/sessions/${id}/rename`, { title }),
  history: (id: string, opts?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (opts?.limit != null) q.set('limit', String(opts.limit))
    if (opts?.offset != null) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return jsonGet<{ cards: StructuredCard[]; lastSeq: number; hasMore?: boolean }>(`/api/session/${id}${qs ? `?${qs}` : ''}`)
  },
  todo: (id: string) => jsonGet<any[]>(`/api/session/${id}/todo`),
  context: (id: string) => jsonGet<{ sessionId: string; agent?: string; model?: string; tokens?: any; cost?: number; directory?: string; nextAgent?: string; nextModel?: any }>(`/api/session/${id}/context`),
  workspaces: () => jsonGet<Array<{ directory: string; name: string; sessionCount: number; lastActiveAt: number }>>('/api/workspaces'),
  createSession: (body: { directory: string; title?: string }) => jsonPost<{ id: string }>('/api/session', body),
  mcp: () => jsonGet<Array<{ name: string; type?: string; status: 'configured' | 'disabled' }>>('/api/mcp'),
  commands: (backendId?: string) => jsonGet<Array<{ name: string; description: string }>>(`/api/commands${backendId ? `?backend=${encodeURIComponent(backendId)}` : ''}`),
  runCommand: (body: { sessionId: string; command: string; arguments?: string }) => jsonPost<{ ok: boolean }>('/api/command', body),
  agents: () => jsonGet<Array<{ name: string; model: string; description: string }>>('/api/agents'),
  models: () => jsonGet<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>('/api/models'),
  getOverrides: () => jsonGet<{ agent: string | null; model: { providerID: string; modelID: string } | null }>('/api/overrides'),
  setOverrides: (body: { agent?: string | null; model?: { providerID: string; modelID: string } | null }) =>
    jsonPost<{ ok: boolean }>('/api/overrides', body),
  sendMessage: (body: { sessionId?: string; text: string; clientId?: string; images?: Array<{ data: string; mimeType: string }> }) => jsonPost<{ messageId: string }>('/api/message', body),
  abort: (sessionId: string) => jsonPost<{ ok: boolean }>('/api/abort', { sessionId }),
  suggestions: (sessionId: string) => jsonGet<{ suggestions: string[] }>(`/api/session/${sessionId}/suggestions`),
  approve: (sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject') =>
    jsonPost<{ ok: boolean }>('/api/approval', { sessionId, requestId, decision }),
  answerQuestion: (sessionId: string, requestId: string, answers: string[][]) =>
    jsonPost<{ ok: boolean; stale?: boolean }>('/api/question/reply', { sessionId, requestId, answers }),
  rejectQuestion: (sessionId: string, requestId: string) =>
    jsonPost<{ ok: boolean; stale?: boolean }>('/api/question/reject', { sessionId, requestId }),
  controls: (id: string) =>
    jsonGet<{ mode?: { current?: string; options: Array<{ id: string; name: string }> }; model?: { current?: string; options: Array<{ id: string; name: string }> } }>(`/api/session/${id}/controls`),
  setMode: (id: string, modeId: string) =>
    jsonPost<{ ok: boolean }>(`/api/session/${id}/mode`, { modeId }),
  setModel: (id: string, modelId: string) =>
    jsonPost<{ ok: boolean }>(`/api/session/${id}/model`, { modelId }),
  files: (id: string, q: string) =>
    jsonGet<string[]>(`/api/session/${id}/files?q=${encodeURIComponent(q)}`),
  schedules: () => jsonGet<{ schedules: ScheduleRow[] }>('/api/schedules'),
  subagents: (id: string) => jsonGet<{ subagents: SubagentRow[] }>(`/api/session/${id}/subagents`),
  /** Raw server message — tool parts carry state.output (tool output pages). */
  messageRaw: (id: string, messageId: string) =>
    jsonGet<{ info: unknown; parts: Array<Record<string, any>> }>(`/api/session/${id}/message/${encodeURIComponent(messageId)}`),
  /** Git pane: branch + per-file working-tree status. */
  vcs: (sessionId?: string) => jsonGet<{ branch?: string; defaultBranch?: string; status: Array<{ file: string; additions?: number; deletions?: number; status?: string }> }>(`/api/vcs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  /** Git pane: per-file working-tree patches. */
  vcsDiff: (sessionId?: string) => jsonGet<{ files: Array<{ file: string; patch?: string; additions?: number; deletions?: number; status?: string }> }>(`/api/vcs/diff${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  version: () => jsonGet<{ version: string; commit?: string; uptime: string; node?: string }>('/api/version'),
  skills: (directory?: string) =>
    jsonGet<{ skills: SkillRow[] }>(`/api/skills${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`),
  browse: (directory: string, path: string) =>
    jsonGet<{ files: FileEntryRow[] }>(`/api/browse?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`),
  fileContent: (directory: string, path: string) =>
    jsonGet<{ type: string; content: string }>(`/api/file-content?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`),
  worktrees: (directory?: string) =>
    jsonGet<{ worktrees: WorktreeRow[] }>(`/api/worktrees${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`),
  createWorktree: (directory: string, name: string) =>
    jsonPost<{ worktree?: WorktreeRow; error?: string }>('/api/worktrees', { directory, name }),
  removeWorktree: (directory: string, name: string) =>
    jsonDelete<{ ok: boolean }>(`/api/worktrees?directory=${encodeURIComponent(directory)}&name=${encodeURIComponent(name)}`),
  channels: () =>
    jsonGet<{ channels: ChannelRow[] }>('/api/channels'),
  updateChannel: (id: string, patch: { enabled?: boolean; replyGranularity?: 'standard' | 'detailed'; workspaces?: { mode: 'all' } | { mode: 'custom'; dirs: string[] }; credentials?: Record<string, string> }) =>
    jsonPatch<{ channel?: ChannelRow; error?: string }>(`/api/channels/${id}`, patch),
  resetChannel: (id: string) =>
    jsonPost<{ channel?: ChannelRow; error?: string }>(`/api/channels/${id}/reset`, {}),
  pairQr: () => jsonGet<{ url: string; svg: string; expiresAt?: number }>('/api/pair/qr'),
  pairOnboarding: () => jsonGet<{
    url: string
    svg: string
    expiresAt: number
    channels: Array<{ channel: 'telegram' | 'wechat' | 'lark'; enabled: boolean; live: { connected: boolean; username?: string } | null }>
    host: { hostname: string; platform: string; arch: string }
  }>('/api/pair/onboarding'),
  exchangePair: (pending: string) => jsonPost<{ token?: string; error?: string }>('/api/pair/exchange', { pending }),
  addSchedule: (body: { name?: string; prompt: string; spec: ScheduleSpec; enabled?: boolean }) =>
    jsonPost<{ schedule?: ScheduleRow; error?: string }>('/api/schedules', body),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    jsonPatch<{ schedule?: ScheduleRow; error?: string }>(`/api/schedules/${id}`, { enabled }),
  deleteSchedule: (id: string) => jsonDelete<{ ok: boolean }>(`/api/schedules/${id}`),
}

export type ScheduleSpec = { kind: 'every'; minutes: number } | { kind: 'daily'; time: string }
export interface ScheduleRow {
  id: string
  name: string
  prompt: string
  spec: ScheduleSpec
  enabled: boolean
  createdAt: number
  lastRunAt?: number
}
export interface SubagentRow { id: string; title: string; updatedAt?: number; done: number; total: number; busy?: boolean }
export interface SkillRow { name: string; description?: string }
export interface FileEntryRow { name: string; path: string; type: 'file' | 'directory' }
export interface WorktreeRow { name: string; directory?: string }
export type ChannelKind = 'telegram' | 'wechat' | 'lark'
export interface ChannelRow {
  id: string
  channel: ChannelKind
  enabled: boolean
  credentials: Record<string, string>
  replyGranularity: 'standard' | 'detailed'
  workspaces: { mode: 'all' } | { mode: 'custom'; dirs: string[] }
  live?: { connected: boolean; username?: string } | null
}
