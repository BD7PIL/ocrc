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
import type { ZCodeTaskMeta } from '@zcode/shared'

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
