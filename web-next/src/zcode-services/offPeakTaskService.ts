// zcode-services/offPeakTaskService.ts — ocrc-backed IOffPeakTaskService (N4).
// ocrc schedules（name/prompt/cron spec/enabled）↔ ZCode offPeak 任务投影：
// list 映射 /api/schedules；create → POST /api/schedules；pause/continue →
// PATCH enabled；delete → DELETE。其余服务端取号语义（ticket）不适用 ocrc。
import type { IOffPeakTaskService } from '@zcode/services'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

interface OcrcSchedule {
  id: string
  name: string
  prompt: string
  spec: { kind: string; cron?: string; everyMs?: number }
  enabled: boolean
  createdAt: number
  lastRunAt?: number
}

async function fetchSchedules(): Promise<OcrcSchedule[]> {
  const res = await fetch('/api/schedules', { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) return []
  return ((await res.json()) as { schedules: OcrcSchedule[] }).schedules ?? []
}

function toTask(s: OcrcSchedule): any {
  return {
    offPeakTaskId: s.id,
    title: s.name || s.prompt.slice(0, 40),
    prompt: s.prompt,
    permissionMode: 'build',
    enabled: s.enabled,
    paused: !s.enabled,
    createdAt: s.createdAt,
    lastRunAt: s.lastRunAt,
    schedule: { kind: s.spec?.kind ?? 'cron', cron: s.spec?.cron },
  }
}

export function createOcrcOffPeakTaskService(): any {
  const impl: Record<string, unknown> = {
    getCodingPlanSupport: async () => ({ supported: false, reason: 'ocrc engine' }),
    getTakeNumberAvailability: async () => ({ available: false }),
    list: async () => {
      const schedules = await fetchSchedules()
      return schedules.map(toTask)
    },
    get: async (offPeakTaskId: string) => {
      const all = await fetchSchedules()
      const s = all.find((x) => x.id === offPeakTaskId)
      return s ? toTask(s) : null
    },
    createTask: async (params: { title: string; prompt: string }) => {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ name: params.title, prompt: params.prompt, enabled: true }),
      })
      if (!res.ok) throw new Error(`[ocrc-fork] schedule create failed: ${res.status}`)
      const { schedule } = (await res.json()) as { schedule: OcrcSchedule }
      return { offPeakTaskId: schedule.id, status: 'queued' }
    },
    deleteTask: async (offPeakTaskId: string) => {
      await fetch(`/api/schedules/${offPeakTaskId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token()}` },
      })
    },
    pauseTask: async (offPeakTaskId: string) => {
      await fetch(`/api/schedules/${offPeakTaskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ enabled: false }),
      })
      return null
    },
    continueTask: async (offPeakTaskId: string) => {
      await fetch(`/api/schedules/${offPeakTaskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ enabled: true }),
      })
      return null
    },
    cancelTask: async () => null,
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
