import type { StructuredCard, SessionSummary, ConfigSummary, ProjectOverview } from './types.js'
import { clearAuthReloadFlag } from '../auth-reload.js'
import { onUnauthorized } from '../auth.js'
import { getToken } from '../auth-token.js'
import { hostConn } from '../../zcode-services/hostConnection.js'

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

// Every REST call gets a hard timeout: a hung fetch (EL7 host under load,
// proxy stall) must surface as a catchable error, not a forever-pending
// promise — the session loading dots spin on `!feed` and would never clear.
const FETCH_TIMEOUT_MS = 20_000

// P5：REST 层向 host 连接状态机做佐证上报。分流铁律：401 = host 可达（走
// onUnauthorized 认证分流，绝不触碰连接状态机）；只有网络层失败（断连/超时）
// 才计入 restFail 连击（达到阈值由状态机强制 ws 重验）。
async function trackedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init)
    hostConn.restOk()
    return res
  } catch (e) {
    hostConn.restFail()
    throw e
  }
}

async function jsonGet<T>(path: string): Promise<T> {
  const res = await trackedFetch(`${base}${path}`, { credentials: 'include', headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (res.status === 401) { onUnauthorized(); throw new Error(`GET ${path} 401`) }
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
}

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const res = await trackedFetch(`${base}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    credentials: 'include',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 401) { onUnauthorized(); throw new Error(`POST ${path} 401`) }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
}

async function jsonMethod<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await trackedFetch(`${base}${path}`, {
    method,
    headers: authHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 401) { onUnauthorized(); throw new Error(`${method} ${path} 401`) }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
}

async function jsonPatch<T>(path: string, body: unknown): Promise<T> {
  return jsonMethod('PATCH', path, body)
}

async function jsonPut<T>(path: string, body: unknown): Promise<T> {
  const res = await trackedFetch(`${base}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    credentials: 'include',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 401) { onUnauthorized(); throw new Error(`PUT ${path} 401`) }
  if (!res.ok) throw new Error(`PUT ${path} ${res.status}`)
  clearAuthReloadFlag()
  return res.json()
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
  /** Revert the last exchange / undo a revert (opencode session.revert). */
  revertSession: (id: string, messageId: string) => jsonPost<{ id: string; revert?: { messageID: string } }>(`/api/session/${id}/revert?messageID=${encodeURIComponent(messageId)}`, {}),
  unrevertSession: (id: string) => jsonPost<{ id: string; revert?: { messageID: string } }>(`/api/session/${id}/unrevert`, {}),
  revertState: (id: string) => jsonGet<{ reverted: boolean; messageID?: string }>(`/api/session/${id}/revert-state`),
  deleteSession: (id: string) => jsonPost<{ ok: boolean }>(`/api/sessions/${id}/delete`, {}),
  renameSession: (id: string, title: string) => jsonPost<{ ok: boolean }>(`/api/sessions/${id}/rename`, { title }),
  history: (id: string, opts?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (opts?.limit != null) q.set('limit', String(opts.limit))
    if (opts?.offset != null) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return jsonGet<{ cards: StructuredCard[]; lastSeq: number; hasMore?: boolean; busy?: boolean }>(`/api/session/${id}${qs ? `?${qs}` : ''}`)
  },
  todo: (id: string) => jsonGet<any[]>(`/api/session/${id}/todo`),
  context: (id: string) => jsonGet<{ sessionId: string; agent?: string; model?: string; tokens?: any; cost?: number; directory?: string; nextAgent?: string; nextModel?: any }>(`/api/session/${id}/context`),
  workspaces: () => jsonGet<Array<{ directory: string; name: string; sessionCount: number; lastActiveAt: number }>>('/api/workspaces'),
  createSession: (body: { directory: string; title?: string; backendId?: string }) => jsonPost<{ id: string }>('/api/session', body),
  mcp: () => jsonGet<Array<{ name: string; type?: string; status: 'configured' | 'disabled' }>>('/api/mcp'),
  commands: (backendId?: string) => jsonGet<Array<{ name: string; description: string }>>(`/api/commands${backendId ? `?backend=${encodeURIComponent(backendId)}` : ''}`),
  runCommand: (body: { sessionId: string; command: string; arguments?: string }) => jsonPost<{ ok: boolean }>('/api/command', body),
  agents: () => jsonGet<Array<{ name: string; model: string; description: string }>>('/api/agents'),
  models: () => jsonGet<Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants?: string[] }> }>>('/api/models'),
  getOverrides: () => jsonGet<{ agent: string | null; model: { providerID: string; modelID: string } | null; variant?: string | null }>('/api/overrides'),
  setOverrides: (body: { agent?: string | null; model?: { providerID: string; modelID: string } | null; variant?: string | null }) =>
    jsonPost<{ ok: boolean }>('/api/overrides', body),
  sendMessage: (body: { sessionId?: string; text: string; clientId?: string; variant?: string; images?: Array<{ data: string; mimeType: string }> }) => jsonPost<{ messageId: string }>('/api/message', body),
  abort: (sessionId: string) => jsonPost<{ ok: boolean }>('/api/abort', { sessionId }),
  suggestions: (sessionId: string) => jsonGet<{ suggestions: string[] }>(`/api/session/${sessionId}/suggestions`),
  getConfig: () => jsonGet<ConfigSummary>('/api/settings/opencode-config'),
  putConfig: (raw: string) => jsonPut<{ ok?: boolean; error?: string }>('/api/settings/opencode-config', { raw }),
  patchProvider: (patch: { providerId: string; baseURL?: string; apiKey?: string; models?: Array<{ id: string; name?: string; [k: string]: unknown }> }) =>
    jsonPost<{ ok?: boolean; error?: string }>('/api/settings/opencode-config/provider', patch),
  fetchModels: async (baseURL: string, apiKey?: string) => {
    try {
      return await jsonPost<{ models?: Array<{ id: string; name?: string }>; error?: string }>('/api/settings/fetch-models', { baseURL, apiKey })
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
  getProjectOverview: (dir: string) => jsonGet<ProjectOverview>(`/api/settings/project?dir=${encodeURIComponent(dir)}`),
  getProjectFile: (dir: string, path: string) =>
    jsonGet<{ ok: boolean; content: string }>(`/api/settings/project/file?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`),
  putProjectFile: (dir: string, path: string, content: string) =>
    jsonPut<{ ok: boolean; error?: string }>(`/api/settings/project/file`, { dir, path, content }),
  getModelPresets: (dir: string) =>
    jsonGet<{ current: Record<string, string>; presets: Record<string, Record<string, string>> }>(`/api/settings/model-presets?dir=${encodeURIComponent(dir)}`),
  applyModelPreset: (dir: string, name: string, mapping: Record<string, string>) =>
    jsonPost<{ ok: boolean; error?: string }>(`/api/settings/model-presets`, { dir, name, mapping }),
  getProjectMcp: (dir: string) => jsonGet<{ mcp: Record<string, Record<string, unknown>> }>(`/api/settings/project/mcp?dir=${encodeURIComponent(dir)}`),
  setProjectMcp: (dir: string, id: string, entry: Record<string, unknown> | null) =>
    jsonPost<{ ok: boolean; error?: string }>(`/api/settings/project/mcp`, { dir, id, entry }),
  browserState: () => jsonGet<{ ok: boolean; url?: string; title?: string; screenshot?: string; error?: string }>('/api/browser/state'),
  browserNavigate: (url: string) => jsonPost<{ ok: boolean; url?: string; error?: string }>('/api/browser/navigate', { url }),
  browserClick: (xPct: number, yPct: number) => jsonPost<{ ok: boolean }>('/api/browser/click', { xPct, yPct }),
  browserScroll: (dyPct: number) => jsonPost<{ ok: boolean }>('/api/browser/scroll', { dyPct }),
  browserBack: () => jsonPost<{ ok: boolean }>('/api/browser/back', {}),
  skillsManager: () => jsonGet<{ effectiveDir: string; sources: string[]; skills: Array<{ name: string; source: string; path: string; description?: string; enabled: boolean; conflict: boolean }>; conflicts: string[]; error?: string }>('/api/settings/skills-manager'),
  addSkillsSource: (dir: string) =>
    jsonPost<{ ok: boolean; sources: string[] }>('/api/settings/skills-manager/sources', { dir }),
  removeSkillsSource: (dir: string) =>
    jsonPost<{ ok: boolean; sources: string[] }>(`/api/settings/skills-manager/sources?remove=1`, { dir }),
  toggleSkillSource: (name: string, source: string, enabled: boolean) =>
    jsonPost<{ ok: boolean; error?: string }>('/api/settings/skills-manager/toggle', { name, source, enabled }),
  getPolicy: (sessionId: string) => jsonGet<{ policy: 'default' | 'edit' | 'yolo' }>(`/api/session/${sessionId}/policy`),
  setPolicy: (sessionId: string, policy: 'default' | 'edit' | 'yolo') =>
    jsonPost<{ ok: boolean; policy: 'default' | 'edit' | 'yolo' }>(`/api/session/${sessionId}/policy`, { policy }),
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
  remotes: () => jsonGet<{ remotes: RemoteRow[] }>('/api/remotes'),
  saveRemote: (body: {
    id?: string; host: string; port?: number; user?: string; remotePort?: number; name?: string; enabled?: boolean
    httpProxy?: string; httpsProxy?: string; noProxy?: string; caPath?: string
  }) =>
    jsonPost<{ remote: RemoteRow; error?: string }>('/api/remotes', body),
  setRemoteEnabled: (id: string, enabled: boolean) => jsonPatch<{ remote: RemoteRow }>(`/api/remotes/${id}`, { enabled }),
  deleteRemote: (id: string) => jsonPost<{ ok: boolean }>(`/api/remotes/${id}/delete`, {}),
  inspectRemote: (id: string) => jsonPost<{ inspection: Record<string, unknown> }>(`/api/remotes/${id}/inspect`, {}),
  provisionRemote: (id: string, path?: 'auto' | 'push' | 'install') =>
    jsonPost<{ ok: boolean; detail: string }>(`/api/remotes/${id}/provision`, { path: path ?? 'auto' }),
  syncRemoteAuth: (id: string) => jsonPost<{ ok: boolean; detail: string }>(`/api/remotes/${id}/sync-auth`, {}),
  syncRemoteConfig: (id: string) => jsonPost<{ ok: boolean; detail: string }>(`/api/remotes/${id}/sync-config`, {}),
  subagents: (id: string) => jsonGet<{ subagents: SubagentRow[] }>(`/api/session/${id}/subagents`),
  /** Raw server message — tool parts carry state.output (tool output pages). */
  messageRaw: (id: string, messageId: string) =>
    jsonGet<{ info: unknown; parts: Array<Record<string, any>> }>(`/api/session/${id}/message/${encodeURIComponent(messageId)}`),
  /** Git pane: branch + per-file working-tree status. */
  vcs: (sessionId?: string) => jsonGet<{ branch?: string; defaultBranch?: string; status: Array<{ file: string; additions?: number; deletions?: number; status?: string }> }>(`/api/vcs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  /** Git pane: one file's working-tree patch (lazy per file). */
  vcsDiff: (sessionId: string | undefined, file: string) =>
    jsonGet<{ file: string; patch: string }>(`/api/vcs/diff?file=${encodeURIComponent(file)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  version: () => jsonGet<{ version: string; commit?: string; mode?: 'plugin' | 'host'; uptime: string; node?: string }>('/api/version'),
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
    jsonGet<{ channels: ChannelRow[]; telegram?: ChannelsInfo }>('/api/channels'),
  updateChannel: (id: string, patch: { enabled?: boolean; replyGranularity?: 'standard' | 'detailed'; workspaces?: { mode: 'all' } | { mode: 'custom'; dirs: string[] }; credentials?: Record<string, string>; allowUsers?: number[] }) =>
    jsonPatch<{ channel?: ChannelRow; warning?: string; error?: string }>(`/api/channels/${id}`, patch),
  resetChannel: (id: string) =>
    jsonPost<{ channel?: ChannelRow; error?: string }>(`/api/channels/${id}/reset`, {}),
  pairQr: () => jsonGet<{ url: string; svg: string; expiresAt?: number }>('/api/pair/qr'),
  pairReset: () => jsonPost<{ ok?: boolean; paired?: number; error?: string }>('/api/pair/reset', {}),
  pairOnboarding: () => jsonGet<{
    url: string
    svg: string
    expiresAt: number
    paired?: number
    channels: Array<{ channel: 'telegram' | 'wechat' | 'lark' | 'dingtalk'; enabled: boolean; live: { connected: boolean; username?: string } | null }>
    host: { hostname: string; platform: string; arch: string }
  }>('/api/pair/onboarding'),
  exchangePair: (pending: string) => jsonPost<{ token?: string; error?: string }>('/api/pair/exchange', { pending }),
  addSchedule: (body: { name?: string; prompt: string; spec: ScheduleSpec; enabled?: boolean }) =>
    jsonPost<{ schedule?: ScheduleRow; error?: string }>('/api/schedules', body),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    jsonPatch<{ schedule?: ScheduleRow; error?: string }>(`/api/schedules/${id}`, { enabled }),
  deleteSchedule: (id: string) => jsonDelete<{ ok: boolean }>(`/api/schedules/${id}`),
  runSchedule: (id: string) => jsonPost<{ ok?: boolean; error?: string }>(`/api/schedules/${id}/run`, {}),
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
export interface RemoteRow {
  id: string
  name?: string
  host: string
  port: number
  user?: string
  remotePort: number
  enabled: boolean
  hasPassword: boolean
  /** Enterprise relay (0.27) — proxy URLs come back userinfo-redacted. */
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
  caPath?: string
  status: {
    state: 'unknown' | 'detecting' | 'provisioning' | 'launching' | 'online' | 'needs-auth' | 'error' | 'offline' | 'disabled'
    detail?: string
    localPort?: number
    pid?: number
    since?: number
    inspection?: {
      platform?: string
      arch?: string
      glibc?: string
      opencodePath?: string
      version?: string
      authPresent?: boolean
      portListening?: boolean
    }
    logTail: string[]
  } | null
}

export interface SkillRow { name: string; description?: string }
export interface FileEntryRow { name: string; path: string; type: 'file' | 'directory' }
export interface WorktreeRow { name: string; directory?: string }
export type ChannelKind = 'telegram' | 'wechat' | 'lark' | 'dingtalk'
export interface ChannelRow {
  id: string
  channel: ChannelKind
  enabled: boolean
  /** Write-only since 0.27: GET redacts credentials to hasToken/tokenHint. */
  credentials?: Record<string, string>
  hasToken?: boolean
  tokenHint?: string
  /** Telegram allowlist (numeric user ids). Editable since 0.27; empty/absent
   *  = falls back to config.env ALLOWED_USER_IDS at boot. */
  allowUsers?: number[]
  replyGranularity: 'standard' | 'detailed'
  workspaces: { mode: 'all' } | { mode: 'custom'; dirs: string[] }
  live?: { connected: boolean; username?: string } | null
}
export interface ChannelsInfo {
  /** Where the running token comes from: panel credential / config.env / none. */
  tokenSource: 'panel' | 'env' | 'none'
  /** Effective allowlist (panel value wins over env) + its source. */
  allowSource: 'panel' | 'env'
  allowUsers: number
  /** Bot API proxy egress source (panel credential / env / none). */
  proxySource?: 'panel' | 'env' | 'none'
  /** Masked last-4 of an env-sourced token (write-only; undefined when panel wins). */
  envTokenHint?: string
}
