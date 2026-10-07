// zcode-services/zcodeTaskService.ts — ocrc-backed IZCodeTaskService (N1).
// 「任务」= ocrc session。列表级方法走 ocrc REST（/api/sessions）；会话体
// （snapshot/流）N2 再接。整个服务最后包一层兜底代理：接口 ~60 个方法，
// 未显式实现的一律走「订阅类返回空句柄、其余 reject 明确报错」——绝不让
// UI 踩到 "not a function"（实测会把侧栏整个推进错误边界）。
import type { IZCodeTaskService } from '@zcode/services'
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewStructure,
} from '@zcode/services'
import type { ZCodeTaskMeta, ZCodePersistedMessage } from '@zcode/shared'

interface OcrcSessionSummary {
  id: string
  title: string
  lastActiveAt: number
  directory?: string
  model?: string
  unread?: boolean
  error?: boolean
}

const SUBSCRIBE_RE = /^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function ocrcSessions(): Promise<OcrcSessionSummary[]> {
  const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) return []
  return (await res.json()) as OcrcSessionSummary[]
}

function toMeta(s: OcrcSessionSummary): ZCodeTaskMeta {
  return {
    taskId: s.id,
    traceId: s.id,
    title: s.title || '(未命名)',
    workspacePath: s.directory ?? '/home/demo/develop/opencode-plugin/ocrc',
    createdAt: s.lastActiveAt,
    updatedAt: s.lastActiveAt,
    mode: 'build',
    model: s.model,
  } as ZCodeTaskMeta
}

// ── N2: snapshot 构建（ocrc cards → ZCodePersistedMessage[]）──
interface OcrcBlock { type: string; text?: string; tool?: string; args?: string; status?: string; output?: unknown }
interface OcrcCard { kind: string; text?: string; ts?: number; blocks?: OcrcBlock[]; meta?: { model?: string } }

async function ocrcHistory(taskId: string, limit = 200): Promise<{ cards: OcrcCard[] }> {
  const res = await fetch(`/api/session/${taskId}?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token()}` },
  })
  if (!res.ok) return { cards: [] }
  return (await res.json()) as { cards: OcrcCard[] }
}

function cardToMessage(c: OcrcCard): ZCodePersistedMessage | null {
  if (c.kind === 'user') {
    return { role: 'user', content: c.text ?? '', timestamp: c.ts ?? Date.now() } as ZCodePersistedMessage
  }
  if (c.kind === 'assistant' && c.blocks) {
    const parts: Array<{ type: 'content' | 'thought' | 'tool-call'; content?: string; toolIndex?: number }> = []
    const tools: Array<Record<string, unknown>> = []
    let thought = ''
    const textChunks: string[] = []
    for (const b of c.blocks) {
      if (b.type === 'text') {
        parts.push({ type: 'content', content: b.text })
        textChunks.push(b.text ?? '')
      } else if (b.type === 'reasoning') {
        parts.push({ type: 'thought', content: b.text })
        thought += b.text ?? ''
      } else if (b.type === 'tool') {
        parts.push({ type: 'tool-call', toolIndex: tools.length })
        tools.push({
          toolName: b.tool,
          status: b.status === 'error' ? 'failed' : b.status === 'done' ? 'completed' : undefined,
          input: b.args,
          output: b.output,
        })
      }
    }
    return {
      role: 'assistant',
      content: textChunks.join('\n\n'),
      timestamp: c.ts ?? Date.now(),
      thought: thought || undefined,
      model: c.meta?.model,
      parts: parts as never,
      tools: tools as never,
    } as ZCodePersistedMessage
  }
  return null
}

async function buildSnapshot(params: { taskId: string; messageLimit?: number }): Promise<any> {
  const { cards } = await ocrcHistory(params.taskId, params.messageLimit ?? 200)
  const messages = cards.map(cardToMessage).filter((m): m is ZCodePersistedMessage => m !== null)
  const sessions = await ocrcSessions()
  const s = sessions.find((x) => x.id === params.taskId)
  const meta = s
    ? toMeta(s)
    : ({ taskId: params.taskId, traceId: params.taskId, title: '(未命名)', workspacePath: '/', createdAt: Date.now(), updatedAt: Date.now(), mode: 'build' } as ZCodeTaskMeta)
  return {
    meta,
    messages,
    history: { truncatedBefore: false, totalMessages: messages.length },
  }
}

function createExplicitTaskService(): IZCodeTaskService {
  return {
    initialize: async () => ({ available: true, version: 'ocrc' }),
    listTasks: async (params: { workspacePath: string }): Promise<ZCodeTaskMeta[]> => {
      const sessions = await ocrcSessions()
      // ZCode 按 workspace 过滤；ocrc 会话自带目录——同目录即同工作区（忽略尾斜杠差异）
      const norm = (p: string) => p.replace(/\/+$/, '')
      return sessions
        .filter((s) => !params.workspacePath || norm(s.directory ?? '') === norm(params.workspacePath))
        .map(toMeta)
    },
    listPinnedTasks: async (_params: { workspacePath: string }) => [], // N1.x：本地 pins 与 ZCode pinned 状态对齐后接入
    listTaskList: async (query: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> => {
      const sessions = await ocrcSessions()
      const items = sessions
        .map(toMeta)
        .filter((m) => {
          if (query.kind === 'archived') return false // ocrc 本地归档 N1.x 接入
          if (query.search) return m.title.toLowerCase().includes(query.search.toLowerCase())
          return true
        })
        .sort((a, b) => (query.sortBy === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt))
      const limit = query.limit ?? items.length
      return { items: items.slice(0, limit), total: items.length, hasMore: items.length > limit }
    },
    listPinnedTaskIds: async () => {
      try { return JSON.parse(localStorage.getItem('ocrc.pins') ?? '[]') as string[] } catch { return [] }
    },
    listDeletedTaskIds: async () => [],
    listGroupedTaskViewStructure: async () =>
      ({ groups: [], members: [], topLevelOrders: [] }) as ZCodeGroupedTaskViewStructure,
    applyGroupedTaskViewOrder: async () => ({ nodes: [] }) as ZCodeGroupedTaskView,
    listArchivedTasks: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskMeta: async (params: { taskId: string }) => {
      const sessions = await ocrcSessions()
      const s = sessions.find((x) => x.id === params.taskId)
      if (!s) throw new Error(`[ocrc-fork] task ${params.taskId} not found`)
      return toMeta(s)
    },
    getTaskConfigOptions: async () => [],
    getTaskModelSelection: async () => null,
    getTaskTokenUsage: async () => null,
    // ── N2: 打开任务 = 返回该会话 meta（ZCode 语义里 resume 即打开转写）──
    resumeTask: async (params: { taskId: string }) => {
      const sessions = await ocrcSessions()
      const s = sessions.find((x) => x.id === params.taskId)
      if (!s) throw new Error(`[ocrc-fork] resumeTask: task ${params.taskId} not found`)
      return toMeta(s)
    },
    // ── N2: 会话核心 ──
    getTaskSnapshot: async (params: { taskId: string; messageLimit?: number }) => buildSnapshot(params),
    getTaskSnapshotWithEtag: async (params: { taskId: string; messageLimit?: number }) => ({
      snapshot: await buildSnapshot(params),
      etag: undefined,
      notModified: false,
    }),
    sendPrompt: async (params: { taskId: string; content: string; clientId?: string }) => {
      const res = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ sessionId: params.taskId, text: params.content, clientId: params.clientId }),
      })
      if (!res.ok) throw new Error(`[ocrc-fork] send failed: ${res.status}`)
    },
    stopGeneration: async (params: { taskId: string }) => {
      await fetch('/api/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ sessionId: params.taskId }),
      })
    },
    renameTask: async () => {},
    setTaskPinned: async () => {},
    setTaskUnread: async () => {},
    setMode: async () => {},
    setModel: async () => {},
    setConfigOption: async () => {},
  } as unknown as IZCodeTaskService
}

export function createOcrcTaskService(): IZCodeTaskService {
  const impl = createExplicitTaskService() as unknown as Record<string, unknown>
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const name = String(prop)
      if (SUBSCRIBE_RE.test(name)) {
        return (_listener?: unknown) => {
          const un: any = () => {}
          un.dispose = () => {}
          return un
        }
      }
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`[ocrc-fork] zcodeTaskService.${name} 尚未接入 ocrc（N2）`))
    },
  }) as unknown as IZCodeTaskService
}
