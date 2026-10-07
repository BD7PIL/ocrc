// zcode-services/offPeakTaskService.ts — ocrc-backed IOffPeakTaskService (N5 裁决③).
// ocrc /api/offpeak（一次性取号工单：queued→running→completed/failed，低峰窗口
// FIFO 派发）↔ ZCode ZCodeOffPeakTask，状态机同形。派发（建会话+发 prompt）、
// 模型/权限映射都在 host 端 core/offpeak.ts；本服务只做 REST 面。
import type { IOffPeakTaskService } from '@zcode/services'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

interface OcrcOffPeakTask {
  id: string
  title: string
  prompt: string
  permissionMode: string
  modelSelection?: { providerID: string; modelID: string }
  directory?: string
  status: 'queued' | 'paused' | 'running' | 'completed' | 'failed' | 'cancelled'
  queuedAt: number
  startedAt?: number
  endedAt?: number
  failureReason?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
}

async function fetchOffPeak(): Promise<{ tasks: OcrcOffPeakTask[]; window: { start: string; end: string }; windowOpen: boolean }> {
  const res = await fetch('/api/offpeak', { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) return { tasks: [], window: { start: '00:00', end: '08:00' }, windowOpen: false }
  return await res.json()
}

function toTask(t: OcrcOffPeakTask): any {
  return {
    offPeakTaskId: t.id,
    title: t.title,
    prompt: t.prompt,
    permissionMode: t.permissionMode,
    modelSelection: t.modelSelection,
    workspacePath: t.directory,
    workspaceKey: t.directory ?? 'default',
    status: t.status,
    queuedAt: t.queuedAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    failureReason: t.failureReason,
    sessionId: t.sessionId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` })

export function createOcrcOffPeakTaskService(): any {
  const impl: Record<string, unknown> = {
    // 取号即时快照：ocrc 无外部票务配额——窗口开着就恒可取号
    getCodingPlanSupport: async () => ({ supported: false, reason: 'ocrc engine' }),
    getTakeNumberAvailability: async () => {
      const { windowOpen } = await fetchOffPeak()
      return { available: true, ...(windowOpen ? {} : { reason: 'off-peak window closed; task will queue' }) }
    },
    list: async () => {
      const { tasks } = await fetchOffPeak()
      return tasks.map(toTask)
    },
    get: async (offPeakTaskId: string) => {
      const { tasks } = await fetchOffPeak()
      const t = tasks.find((x) => x.id === offPeakTaskId)
      return t ? toTask(t) : null
    },
    // vendor ZCodeOffPeakTaskCreateParams 全量收下：title/prompt/permissionMode/
    // modelSelection/workspacePath 落 ocrc 工单；boundSessionId（会话内创建）N5.x
    createTask: async (params: { title: string; prompt: string; permissionMode?: string; modelSelection?: { providerID: string; modelID: string }; workspacePath?: string }) => {
      const res = await fetch('/api/offpeak', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          title: params.title,
          prompt: params.prompt,
          permissionMode: params.permissionMode,
          modelSelection: params.modelSelection,
          directory: params.workspacePath,
        }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? `[ocrc-fork] offpeak create failed: ${res.status}`)
      }
      const { task } = (await res.json()) as { task: OcrcOffPeakTask }
      return { offPeakTaskId: task.id, status: 'queued' as const }
    },
    deleteTask: async (offPeakTaskId: string) => {
      await fetch(`/api/offpeak/${offPeakTaskId}`, { method: 'DELETE', headers: auth() })
    },
    pauseTask: async (offPeakTaskId: string) => {
      const res = await fetch(`/api/offpeak/${offPeakTaskId}`, {
        method: 'PATCH', headers: auth(), body: JSON.stringify({ action: 'pause' }),
      })
      const { task } = (await res.json().catch(() => ({}))) as { task?: OcrcOffPeakTask }
      return task ? toTask(task) : null
    },
    continueTask: async (offPeakTaskId: string) => {
      const res = await fetch(`/api/offpeak/${offPeakTaskId}`, {
        method: 'PATCH', headers: auth(), body: JSON.stringify({ action: 'continue' }),
      })
      const { task } = (await res.json().catch(() => ({}))) as { task?: OcrcOffPeakTask }
      return task ? toTask(task) : null
    },
    cancelTask: async (offPeakTaskId: string) => {
      const res = await fetch(`/api/offpeak/${offPeakTaskId}`, {
        method: 'PATCH', headers: auth(), body: JSON.stringify({ action: 'cancel' }),
      })
      const { task } = (await res.json().catch(() => ({}))) as { task?: OcrcOffPeakTask }
      return task ? toTask(task) : null
    },
    deleteHistory: async () => null,
    updateTask: async () => null,
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
        Promise.reject(new Error(`[ocrc-fork] offPeakTaskService.${name} 尚未接入 ocrc`))
    },
  }) as unknown as IOffPeakTaskService
}
