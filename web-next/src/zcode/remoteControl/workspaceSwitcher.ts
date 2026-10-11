// zcode/remoteControl/workspaceSwitcher.ts — ocrc 侧的 WebRemoteControlWorkspaceSwitcherApi
// 实现（W1 数据面）。官方移动壳（/z/ 移动视口）的工作区/任务真相源：
// GET /api/sessions 按 directory 分组；写路径只碰 ocrc 已有端点
// （POST /api/sessions/:id/unread、POST /api/session）。
// 跨工作区切换 = 向 ZCodeApp 发重挂请求（Root remount，与 ?session= 深链同一已验证
// 通路）；本模块不碰 React，重挂由注入的 onRequestSwitch 回调承接（W2 接线）。
import type {
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
} from '@zcode/shared'
import type { WebRemoteControlWorkspaceSwitcherApi } from '@zcode/ui/root/types.js'

/** ocrc 实现的 switcher：vendor 接口里我们实现的方法都是必选
 *  （onWorkspaceListUpdated 推送与 reconnectWorkspace 确实不实现，保持缺席）。 */
export type OcrcWorkspaceSwitcher = Omit<
  WebRemoteControlWorkspaceSwitcherApi,
  'markTaskRead' | 'updateMobileViewState' | 'startDraft'
> & {
  markTaskRead: (task: WebRemoteControlTaskTarget) => Promise<void>
  updateMobileViewState: (workspaceKey: string, taskId?: string) => Promise<void>
  startDraft: (
    workspaceKey: string,
    options?: { mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent },
  ) => Promise<void>
}

/** 发给 ZCodeApp 的重挂请求：<Root key={nonce}> + initialWorkspaceAbsPath/initialTaskId。 */
export interface WorkspaceSwitchRequest {
  workspacePath: string
  taskId?: string
  intent?: WebRemoteControlMobileNavigationIntent
  nonce: number
}

export interface OcrcWorkspaceSwitcherDeps {
  fetchImpl?: typeof fetch
  /** 引导期工作区路径（首屏/深链落点）；此后每次接受的切换都会更新内部游标。 */
  initialWorkspacePath?: string
  /** 活动工作区路径的权威来源（可选注入）；缺省用内部游标。返回 undefined = 未知，
   *  一律走重挂（安全侧）。 */
  getActiveWorkspacePath?: () => string | undefined
  /** 重挂请求出口；缺省时 switchWorkspace/startDraft 报「未就绪」。 */
  onRequestSwitch?: (req: WorkspaceSwitchRequest) => void
}

// /api/sessions 行 = ocrc SessionSummary（web 聚合层输出，backend.ts 形状）。
interface OcrcSessionSummary {
  id: string
  title?: string
  lastActiveAt: number
  createdAt?: number
  unread: boolean
  directory?: string
  error?: boolean
  busy?: boolean
  pinned?: boolean
  archived?: boolean
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function createOcrcWorkspaceSwitcher(deps: OcrcWorkspaceSwitcherDeps = {}): OcrcWorkspaceSwitcher {
  const doFetch: typeof fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  let activePath = deps.initialWorkspacePath
  let switchSeq = 0

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token()}` }
  }

  async function markTaskReadById(taskId: string): Promise<void> {
    const res = await doFetch(`/api/sessions/${encodeURIComponent(taskId)}/unread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ unread: false }),
    })
    if (!res.ok) throw new Error(`标记已读失败 (HTTP ${res.status})`)
  }

  function requestRemount(workspacePath: string, taskId?: string, intent?: WebRemoteControlMobileNavigationIntent): void {
    if (!deps.onRequestSwitch) throw new Error('切换入口未就绪，请刷新重试')
    activePath = workspacePath
    deps.onRequestSwitch({
      workspacePath,
      ...(taskId ? { taskId } : {}),
      ...(intent ? { intent } : {}),
      nonce: ++switchSeq,
    })
  }

  const api: OcrcWorkspaceSwitcher = {
    async listWorkspaces() {
      const res = await doFetch('/api/sessions', { headers: authHeaders() })
      if (!res.ok) throw new Error(`任务列表加载失败 (HTTP ${res.status})`)
      const rows = (await res.json()) as OcrcSessionSummary[]
      const byPath = new Map<string, { lastActiveAt: number; tasks: WebRemoteControlTaskTarget[] }>()
      for (const s of rows) {
        const dir = typeof s.directory === 'string' ? s.directory.trim() : ''
        if (!dir) continue // 无目录的会话进不了工作区模型
        const task: WebRemoteControlTaskTarget = {
          taskId: s.id,
          title: s.title || '(未命名)',
          workspacePath: dir,
          workspaceLabel: basename(dir),
          workspaceKind: 'local',
          createdAt: s.createdAt ?? s.lastActiveAt,
          updatedAt: s.lastActiveAt,
          ...(s.unread ? { unreadAt: s.lastActiveAt } : {}),
          // ocrc 不追 finished 事件 → 无 completed 闩锁；error/running/idle 三态。
          displayStatus: s.error ? 'error' : s.busy ? 'running' : 'idle',
          ...(s.pinned ? { pinned: true } : {}),
          ...(s.archived ? { archived: true } : {}),
        }
        const bucket = byPath.get(dir)
        if (bucket) {
          bucket.tasks.push(task)
          bucket.lastActiveAt = Math.max(bucket.lastActiveAt, s.lastActiveAt)
        } else {
          byPath.set(dir, { lastActiveAt: s.lastActiveAt, tasks: [task] })
        }
      }
      const workspaces = [...byPath.entries()]
        .sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt)
        .map(([path]) => ({ workspacePath: path, label: basename(path), kind: 'local' as const }))
      const tasks = [...byPath.values()].flatMap((b) => b.tasks).sort((a, b) => b.updatedAt - a.updatedAt)
      // 不设 activeWorkspaceKey/activeTaskId——vendor 用实时 props 更准（W1 裁决，
      // TaskHome 模型对缺省键有自己的回退链）。
      return { workspaces, tasks }
    },

    markTaskRead: (task) => markTaskReadById(task.taskId),

    // 全部工作区都是本机 local：重连入口只对 remote 出现，无需实现。
    updateMobileViewState: () => Promise.resolve(),

    async switchWorkspace(workspaceKey, options) {
      const key = workspaceKey.trim()
      const current = deps.getActiveWorkspacePath ? deps.getActiveWorkspacePath() : activePath
      // 同工作区短路仅在纯工作区切换时安全；带 taskId 时一律重挂——内部游标可能与
      // vendor 实时 active 路径有偏差，重挂落 initialTaskId 与深链同路，不会错。
      if (current === key && !options?.taskId) return
      if (options?.taskId) {
        // 跨工作区打开任务 = 已读。await 让重挂后新 Root 的列表快照看到已清蓝点；
        // 失败不阻塞切换（返回首页的权威快照会恢复蓝点）。
        try { await markTaskReadById(options.taskId) } catch { /* 尽力而为 */ }
      }
      // 带 taskId 的切换 = 落进该任务的 chat。vendor 的 intent 是单值联合（只有
      // 'chat'），TaskHome/taskOpen 实际都传 'chat'；缺省兜底，防止重挂后落回任务首页。
      const intent: WebRemoteControlMobileNavigationIntent | undefined = options?.taskId
        ? (options.mobileNavigationIntent ?? 'chat')
        : options?.mobileNavigationIntent
      requestRemount(key, options?.taskId, intent)
    },

    async startDraft(workspaceKey, options) {
      const key = workspaceKey.trim()
      const res = await doFetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ directory: key }),
      })
      if (!res.ok) throw new Error(`新建对话失败 (HTTP ${res.status})`)
      const { id } = (await res.json()) as { id?: string }
      if (!id) throw new Error('新建对话失败：返回缺少 id')
      requestRemount(key, id, options?.mobileNavigationIntent ?? 'chat')
    },
  }
  return api
}
