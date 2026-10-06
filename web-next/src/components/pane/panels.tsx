// components/pane/panels.tsx — the M3-1 home panels (task/subagent/
// schedules/mcp/skills/files). Session-scoped panels gate on the active
// session; each polls/refreshes lightly. Deeper panels (file viewer, tool
// output, subagent sessions, git) are M3-2.
import { useEffect, useState } from 'react'
import { api } from '$lib/api/client.js'
import { openPaneTab } from '$lib/stores/sidePane.js'
import type { SkillRow } from '$lib/api/client.js'

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-center" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>{text}</p>
}

function NoSession({ what }: { what: string }) {
  return <Empty text={`${what}面板跟随当前会话——先在左栏选择一个会话`} />
}

// ── 任务：todo checklist（3s 轮询，visible-only）──
export function TasksPanel({ sessionId }: { sessionId: string | null }) {
  const [todos, setTodos] = useState<Array<{ content?: string; text?: string; status?: string }>>([])
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const tick = () => {
      if (document.hidden || !alive) return
      void api.todo(sessionId).then((rows) => { if (alive && Array.isArray(rows)) setTodos(rows) }).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [sessionId])

  if (!sessionId) return <NoSession what="任务" />
  if (todos.length === 0) return <Empty text="本会话还没有待办" />
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="p-3">
      <p className="label mb-2">待办 {done}/{todos.length}</p>
      <ul className="flex flex-col gap-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2" style={{ fontSize: 'var(--ui-sm)' }}>
            <span
              className="mt-[6px] size-1.5 shrink-0 rounded-full"
              style={{ background: t.status === 'completed' ? 'var(--ok)' : t.status === 'in_progress' ? 'var(--accent)' : 'var(--border)' }}
              aria-hidden
            />
            <span style={{ color: t.status === 'completed' ? 'var(--text-3)' : 'var(--text-2)' }}>{t.content ?? t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 子代理：运行中/已结束（feed tick 驱动的 5s 轮询）──
interface SubagentRow { id: string; name?: string; busy?: boolean }
export function SubsPanel({ sessionId }: { sessionId: string | null }) {
  const [subs, setSubs] = useState<SubagentRow[]>([])
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const tick = () => {
      if (document.hidden || !alive) return
      void api.subagents(sessionId).then((r) => { if (alive) setSubs(r.subagents ?? []) }).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [sessionId])

  if (!sessionId) return <NoSession what="子代理" />
  if (subs.length === 0) return <Empty text="没有子代理记录" />
  const running = subs.filter((s) => s.busy)
  const finished = subs.filter((s) => !s.busy)
  return (
    <div className="p-3">
      <p className="label mb-1">正在运行 · {running.length}</p>
      {running.length === 0 && <p className="mb-2" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-4)' }}>没有正在运行的子代理</p>}
      {running.map((s) => <SubRow key={s.id} s={s} />)}
      <p className="label mb-1 mt-3">已结束 · {finished.length}</p>
      {finished.map((s) => <SubRow key={s.id} s={s} />)}
    </div>
  )
}

function SubRow({ s }: { s: SubagentRow }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left transition-colors hover:bg-[var(--bg-elev2)]"
      title="打开子会话转写"
      onClick={() => openPaneTab({ id: `sub:${s.id}`, kind: 'subagent', title: s.name || s.id, childId: s.id })}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${s.busy ? 'ocrc-pulse-dot' : ''}`}
        style={{ background: s.busy ? 'var(--accent)' : 'var(--ok)' }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{s.name || s.id}</span>
    </button>
  )
}

// ── 定时任务：启停开关 ──
interface ScheduleRow { id: string; name?: string; title?: string; enabled?: boolean; cron?: string; everyMinutes?: number }
export function SchedulesPanel() {
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const reload = () => { void api.schedules().then((r) => setRows(r.schedules ?? [])).catch(() => {}) }
  useEffect(reload, [])
  if (rows.length === 0) return <Empty text="没有定时任务——在自动化视图创建（M4）" />
  return (
    <div className="flex flex-col gap-1.5 p-3">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 rounded-[9px] px-3 py-2" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-2)' }}>
          <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
            {r.title || r.name || r.id}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={!!r.enabled}
            className="h-4 w-7 rounded-full transition-colors"
            style={{ background: r.enabled ? 'var(--accent)' : 'var(--border)' }}
            onClick={() => { void api.setScheduleEnabled(r.id, !r.enabled).then(reload) }}
          >
            <span
              className="block h-3 w-3 rounded-full transition-transform"
              style={{ background: 'var(--bg-elev)', transform: r.enabled ? 'translateX(14px)' : 'translateX(2px)' }}
            />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── MCP：只读状态列表 ──
export function McpPanel() {
  const [rows, setRows] = useState<Array<{ name: string; type?: string; status: string }>>([])
  useEffect(() => { void api.mcp().then(setRows).catch(() => {}) }, [])
  if (rows.length === 0) return <Empty text="没有配置 MCP 服务器" />
  return (
    <div className="flex flex-col gap-1 p-3">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5" style={{ fontSize: 'var(--ui-sm)' }}>
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: r.status === 'configured' ? 'var(--ok)' : 'var(--border)' }}
            aria-hidden
          />
          <span className="mono min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }}>{r.name}</span>
          <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{r.status}</span>
        </div>
      ))}
    </div>
  )
}

// ── Skills：只读 chips ──
export function SkillsPanel() {
  const [rows, setRows] = useState<SkillRow[]>([])
  useEffect(() => { void api.skills().then((r) => setRows(r.skills ?? [])).catch(() => {}) }, [])
  if (rows.length === 0) return <Empty text="没有 Skills" />
  return (
    <div className="flex flex-wrap gap-1.5 p-3">
      {rows.map((r) => (
        <span key={r.name} className="rounded-full px-2.5 py-1" style={{ border: '1px solid var(--border)', fontSize: 'var(--ui-2xs)', color: 'var(--text-2)' }} title={r.description}>
          {r.name}
        </span>
      ))}
    </div>
  )
}
