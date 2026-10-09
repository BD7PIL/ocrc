import type { Schedule, ScheduleSpec } from '../core/scheduler.js'

/**
 * The `schedule_create` / `schedule_list` tool bodies, shared verbatim between the
 * two modes an ocrc plugin can run in:
 *  - FULL (no host): the tool talks to the plugin's own scheduler;
 *  - ATTACHED (host owns the lock): the tool talks to the HOST's scheduler over
 *    HTTP.
 * Only the side effect differs, so the argument validation and the user-visible
 * text live here — otherwise the two copies drift and the same tool answers
 * differently depending on which mode the user happens to be running.
 */
export interface ScheduleCreateArgs {
  prompt?: string
  every_minutes?: number
  daily_time?: string
  title?: string
}

export type ScheduleParse =
  | { ok: true; prompt: string; name?: string; spec: ScheduleSpec; human: string }
  | { ok: false; error: string }

export function parseScheduleCreate(args: ScheduleCreateArgs): ScheduleParse {
  const prompt = args.prompt?.trim()
  if (!prompt) return { ok: false, error: 'schedule_create failed: prompt is required' }
  const every = args.every_minutes
  const daily = args.daily_time?.trim()
  if (every != null && daily) return { ok: false, error: 'schedule_create failed: provide every_minutes OR daily_time, not both' }
  let spec: ScheduleSpec
  let human: string
  if (daily) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(daily)) return { ok: false, error: `schedule_create failed: daily_time must be HH:MM, got "${daily}"` }
    spec = { kind: 'daily', time: daily.padStart(5, '0') }
    human = `每天 ${spec.time}`
  } else if (every != null) {
    const minutes = Math.max(1, Math.round(every))
    spec = { kind: 'every', minutes }
    human = `每 ${minutes} 分钟`
  } else {
    return { ok: false, error: 'schedule_create failed: provide every_minutes or daily_time' }
  }
  const name = args.title?.trim() || undefined
  return { ok: true, prompt, name, spec, human }
}

export function scheduleCreatedMessage(s: Pick<Schedule, 'id'>, prompt: string, human: string): string {
  return `定时任务已创建（${s.id}）— ${human}执行：${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}。管理：Web 面板右栏 → 定时任务。`
}

export function formatScheduleList(list: Schedule[]): string {
  if (list.length === 0) return '（当前没有定时任务）'
  return list
    .map((s) => {
      const sched = s.spec.kind === 'every' ? `每 ${s.spec.minutes} 分钟` : `每天 ${s.spec.time}`
      return `#${s.id}${s.name ? ` ${s.name}` : ''} — ${sched}${s.enabled ? '' : '（已暂停）'} — ${s.prompt.slice(0, 60)}`
    })
    .join('\n')
}
