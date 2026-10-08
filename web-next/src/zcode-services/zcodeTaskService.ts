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
import { withGhosts } from './ghost.js'

interface OcrcSessionSummary {
  id: string
  title: string
  lastActiveAt: number
  directory?: string
  model?: string
  unread?: boolean
  error?: boolean
  pinned?: boolean
  archived?: boolean
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body ?? {}),
  }).catch((e) => { throw new Error(`${path} 网络失败：${(e as Error).message}`) })
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`${path} ${res.status}${detail.error ? `：${detail.error}` : ''}`)
  }
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

/** 写后回 meta：UI 会立刻读 meta.title（WorkspaceSidebarItem 等），不能回 undefined。 */
function metaOf(taskId: string, sessions: OcrcSessionSummary[]): ZCodeTaskMeta {
  const s = sessions.find((x) => x.id === taskId)
  if (!s) throw new Error(`[ocrc-fork] task ${taskId} not found`)
  return toMeta(s)
}

interface ModelSelectionLike {
  providerId?: string
  modelId?: string
  options?: { reasoningLevel?: string }
}

interface OcrcModelProvider { id: string; name?: string; models?: Array<{ id: string; name?: string; variants?: string[] }> }

/** 服务端权威 configOptions（模型/思考档位/协作模式）——setModel/setConfigOption 的
 *  返回值形状，也是 getTaskConfigOptions 的数据源。 */
async function configOptions(): Promise<Array<Record<string, unknown>>> {
  const headers = { Authorization: `Bearer ${token()}` }
  const [providersRes, overridesRes] = await Promise.all([
    fetch('/api/models', { headers }).catch(() => null),
    fetch('/api/overrides', { headers }).catch(() => null),
  ])
  const providers = providersRes?.ok ? ((await providersRes.json()) as OcrcModelProvider[]) : []
  const overrides = overridesRes?.ok
    ? ((await overridesRes.json()) as { model?: { providerID: string; modelID: string } | null; variant?: string | null })
    : {}
  const currentModel = overrides.model ? `${overrides.model.providerID}/${overrides.model.modelID}` : ''
  const currentModelEntry = providers
    .find((p) => p.id === overrides.model?.providerID)
    ?.models?.find((m) => m.id === overrides.model?.modelID)
  return [
    {
      id: 'model',
      name: '模型',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: providers.flatMap((p) => (p.models ?? []).map((m) => ({ value: `${p.id}/${m.id}`, label: m.name ?? m.id }))),
    },
    {
      id: 'thought_level',
      name: '思考档位',
      category: 'thought_level',
      type: 'select',
      currentValue: overrides.variant ?? '',
      options: (currentModelEntry?.variants ?? []).map((v) => ({ value: v, label: v })),
    },
    {
      id: 'mode',
      name: '协作模式',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [
        { value: 'build', label: 'build' },
        { value: 'edit', label: 'edit' },
        { value: 'yolo', label: 'yolo' },
      ],
    },
  ]
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
  const messages = cards
    .map(cardToMessage)
    .filter((m): m is ZCodePersistedMessage => m !== null)
    .map((m, i) => ({
      // timeline 以 id 锚定；parts/tools 永为数组——UI 有无可选链的 .length 读取
      id: `${params.taskId}:m${i}`,
      parts: [],
      tools: [],
      ...m,
    }))
  const sessions = await ocrcSessions()
  const s = sessions.find((x) => x.id === params.taskId)
  const meta = s
    ? toMeta(s)
    : ({ taskId: params.taskId, traceId: params.taskId, title: '(未命名)', workspacePath: '/', createdAt: Date.now(), updatedAt: Date.now(), mode: 'build' } as ZCodeTaskMeta)
  return {
    meta,
    messages,
    fileChanges: [],
    turnCheckpoints: [],
    pendingPermissions: [],
    pendingElicitations: [],
    plan: null,
    todoGroups: null,
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
    listPinnedTasks: async (_params: { workspacePath: string }): Promise<ZCodeTaskMeta[]> =>
      (await ocrcSessions()).filter((s) => s.pinned).map(toMeta),
    listTaskList: async (query: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> => {
      const sessions = await ocrcSessions()
      // 过滤在 summary 层做（archived 标记在 session 上，meta 里没有）
      const scoped = sessions.filter((s) => (query.kind === 'archived' ? s.archived === true : s.archived !== true))
      const items = scoped
        .map(toMeta)
        .filter((m) => (query.search ? m.title.toLowerCase().includes(query.search.toLowerCase()) : true))
        .sort((a, b) => (query.sortBy === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt))
      const limit = query.limit ?? items.length
      return { items: items.slice(0, limit), total: items.length, hasMore: items.length > limit }
    },
    // 置顶真相在 host（state.pinnedTaskIds）——TG 与 /z/ 共用同一份，不是浏览器本地偏好。
    listPinnedTaskIds: async () => (await ocrcSessions()).filter((s) => s.pinned).map((s) => s.id),
    listDeletedTaskIds: async () => [],
    listGroupedTaskViewStructure: async () =>
      ({ groups: [], members: [], topLevelOrders: [] }) as ZCodeGroupedTaskViewStructure,
    applyGroupedTaskViewOrder: async () => ({ nodes: [] }) as ZCodeGroupedTaskView,
    listArchivedTasks: async (_params: { workspacePath: string }): Promise<ZCodeTaskMeta[]> =>
      (await ocrcSessions()).filter((s) => s.archived).map(toMeta),
    /** ZCode 语义：只归档已完成（非 busy/非 error 即视为完成）、无未读、非 pinned 的超期任务。 */
    archiveStaleTasks: async (params: { workspacePath?: string; olderThanDays: number }): Promise<ZCodeTaskMeta[]> => {
      const cutoff = Date.now() - Math.max(1, params.olderThanDays) * 86_400_000
      const stale = (await ocrcSessions()).filter((s) =>
        !s.archived && !s.pinned && !s.unread && !s.error && (s.lastActiveAt || 0) < cutoff)
      for (const s of stale) {
        await postJson(`/api/sessions/${s.id}/archive`, { archived: true })
      }
      return stale.map(toMeta)
    },
    archiveWorkspaceTasks: async (params: { workspacePath?: string }): Promise<ZCodeTaskMeta[]> => {
      const norm = (p: string) => p.replace(/\/+$/, '')
      const inWorkspace = (await ocrcSessions()).filter((s) =>
        !s.archived && params.workspacePath && norm(s.directory ?? '') === norm(params.workspacePath))
      for (const s of inWorkspace) {
        await postJson(`/api/sessions/${s.id}/archive`, { archived: true })
      }
      return inWorkspace.map(toMeta)
    },
    archiveTask: async (params: { taskId: string }): Promise<ZCodeTaskMeta> => {
      await postJson(`/api/sessions/${params.taskId}/archive`, { archived: true })
      return metaOf(params.taskId, await ocrcSessions())
    },
    unarchiveTask: async (params: { taskId: string }): Promise<ZCodeTaskMeta> => {
      await postJson(`/api/sessions/${params.taskId}/archive`, { archived: false })
      return metaOf(params.taskId, await ocrcSessions())
    },
    deleteArchivedTask: async (params: { taskId: string }): Promise<boolean> => {
      const res = await fetch(`/api/sessions/${params.taskId}/delete`, {
        method: 'POST', headers: { Authorization: `Bearer ${token()}` },
      }).catch(() => null)
      return Boolean(res?.ok)
    },
    deleteArchivedTasks: async (params: { taskIds: string[] }): Promise<Record<string, unknown>> => {
      const failedTaskIds: string[] = []
      for (const id of [...new Set(params.taskIds)]) {
        const res = await fetch(`/api/sessions/${id}/delete`, {
          method: 'POST', headers: { Authorization: `Bearer ${token()}` },
        }).catch(() => null)
        if (!res?.ok) failedTaskIds.push(id)
      }
      return {
        deletedTaskIds: params.taskIds.filter((id) => !failedTaskIds.includes(id)),
        skippedTaskIds: [],
        failedTaskIds,
      }
    },
    getTaskMeta: async (params: { taskId: string }) => {
      const sessions = await ocrcSessions()
      const s = sessions.find((x) => x.id === params.taskId)
      if (!s) throw new Error(`[ocrc-fork] task ${params.taskId} not found`)
      return toMeta(s)
    },
    getTaskConfigOptions: async () => configOptions(),
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
      const res = await fetch('/api/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ sessionId: params.taskId }),
      })
      // 此前不看响应码：中断失败（会话不存在/400）在 UI 上表现为"点了没反应"。
      if (!res.ok) throw new Error(`[ocrc-fork] abort failed: ${res.status}`)
    },
    // ── 写路径（N6 批次 1）：这些曾是静默 no-op——UI 拿到 undefined 后就去读
    //    meta.title / 做缓存 mutation，假成功比报错更难查。现在全部真写并回 meta。 ──
    renameTask: async (params: { taskId: string; title: string }): Promise<ZCodeTaskMeta> => {
      await postJson(`/api/sessions/${params.taskId}/rename`, { title: params.title })
      return metaOf(params.taskId, await ocrcSessions())
    },
    setTaskPinned: async (params: { taskId: string; pinned: boolean }): Promise<ZCodeTaskMeta> => {
      await postJson(`/api/sessions/${params.taskId}/pin`, { pinned: params.pinned })
      return metaOf(params.taskId, await ocrcSessions())
    },
    setTaskUnread: async (params: { taskId: string; unread: boolean }): Promise<ZCodeTaskMeta> => {
      await postJson(`/api/sessions/${params.taskId}/unread`, { unread: params.unread })
      return metaOf(params.taskId, await ocrcSessions())
    },
    /** 协作模式：ZCode 的 build/edit/plan/yolo ↔ ocrc 的审批策略（plan/build 归 default）。 */
    setMode: async (params: { taskId: string; mode: string }): Promise<void> => {
      const policy = params.mode === 'yolo' ? 'yolo' : params.mode === 'edit' ? 'edit' : 'default'
      await postJson(`/api/session/${params.taskId}/policy`, { policy })
    },
    /** 模型切换：opencode 无会话级切换 → /api/overrides 的「下一轮覆盖」。 */
    setModel: async (params: { taskId: string; modelSelection?: ModelSelectionLike }): Promise<unknown[]> => {
      const sel = params.modelSelection
      if (!sel?.providerId || !sel?.modelId) throw new Error('[ocrc-fork] setModel 需要完整 modelSelection')
      await postJson('/api/overrides', {
        model: { providerID: sel.providerId, modelID: sel.modelId },
        variant: sel.options?.reasoningLevel ?? null,
      })
      return configOptions()
    },
    /** 其他 configOption（思考档位最常用）：thinking/reasoning → overrides.variant。 */
    setConfigOption: async (params: { taskId: string; configId: string; value: string }): Promise<unknown[]> => {
      if (params.configId === 'thought_level' || params.configId === 'reasoning_level') {
        await postJson('/api/overrides', { variant: params.value || null })
        return configOptions()
      }
      if (params.configId === 'mode') {
        const policy = params.value === 'yolo' ? 'yolo' : params.value === 'edit' ? 'edit' : 'default'
        await postJson(`/api/session/${params.taskId}/policy`, { policy })
        return configOptions()
      }
      if (params.configId === 'model') {
        const [providerId, modelId] = String(params.value).split('/')
        if (!providerId || !modelId) throw new Error('[ocrc-fork] model 取值应为 provider/model')
        await postJson('/api/overrides', { model: { providerID: providerId, modelID: modelId } })
        return configOptions()
      }
      throw new Error(`[ocrc-fork] 未知 configOption：${params.configId}`)
    },
  } as unknown as IZCodeTaskService
}

export function createOcrcTaskService(): IZCodeTaskService {
  const impl = createExplicitTaskService() as unknown as Record<string, unknown>
  return withGhosts('zcodeTaskService', impl, '（N6 接线中）') as IZCodeTaskService
}
