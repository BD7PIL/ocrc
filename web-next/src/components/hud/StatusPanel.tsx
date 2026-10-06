// components/hud/StatusPanel.tsx — the floating status panel (ZCode
// ConversationStatusPanel register + the ocrc auto-expand spec the user
// adjudicated): collapsed summary strip ⇄ expanded partitions (计划/子代理),
// ⋯ menu, maximize; auto-expand fires only when the user is idle (desktop +
// right pane closed + composer empty + plan incomplete + a subagent running),
// a manual collapse latches for the current subagent wave, and the latch
// resets when subagents return to zero. Desktop-only (≥821px).
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { api } from '$lib/api/client.js'
import { useUi } from '../../lib/stores/ui.js'

interface TodoRow { content?: string; text?: string; status?: string }
interface SubagentRow { id: string; name?: string; busy?: boolean }

export function StatusPanel({ sessionId, running }: { sessionId: string; running: boolean }) {
  // primitive selectors — an object-returning selector re-renders on every
  // store touch and React #185-loops (useSyncExternalStore sees a new
  // snapshot each call)
  const inspectorOpen = useUi((s) => s.inspectorOpen)
  const composerEmpty = useUi((s) => s.composerEmpty)
  const [expanded, setExpanded] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [todos, setTodos] = useState<TodoRow[]>([])
  const [subs, setSubs] = useState<SubagentRow[]>([])
  const latchRef = useRef(false)
  const busy = running

  // data: todos (3s) + subagents (3s)
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.hidden || !alive) return
      void api.todo(sessionId).then((rows) => { if (alive && Array.isArray(rows)) setTodos(rows) }).catch(() => {})
      void api.subagents(sessionId).then((r) => { if (alive) setSubs(r.subagents ?? []) }).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [sessionId])

  const done = todos.filter((t) => t.status === 'completed').length
  const planIncomplete = todos.length > 0 && done < todos.length
  const busySubs = subs.filter((s) => s.busy)

  // ── auto-expand（用户裁决规格，v0.26.21 起）──
  useEffect(() => {
    if (busySubs.length === 0) {
      latchRef.current = false // wave finished → reset the latch
      return
    }
    if (latchRef.current || dismissed) return
    if (inspectorOpen || !composerEmpty) return
    if (typeof document !== 'undefined' && document.hidden) return
    if (!planIncomplete) return
    setExpanded(true)
  }, [busySubs.length, latchRef.current, dismissed, inspectorOpen, composerEmpty, planIncomplete])

  // collapse from inside = latch the current wave
  const collapse = () => { setExpanded(false); latchRef.current = true }

  if (dismissed) return null

  if (!expanded) {
    return (
      <div
        className="fixed right-4 z-[var(--z-hud)] hidden items-center gap-2 rounded-full px-3 py-1.5 md:flex"
        style={{ top: 56, background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--elev-soft)' }}
      >
        <span className="ocrc-pulse-dot size-1.5 rounded-full" style={{ background: busySubs.length ? 'var(--accent)' : 'var(--ok)' }} aria-hidden />
        <button type="button" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }} onClick={() => setExpanded(true)}>
          计划 {done}/{todos.length}{busySubs.length ? ` · 子代理 ${busySubs.length} 运行中` : ''}
        </button>
        <button type="button" aria-label="展开" style={{ color: 'var(--text-4)' }} onClick={() => setExpanded(true)}>
          <ChevronUp size={11} />
        </button>
        <button type="button" aria-label="本回合不再提醒" style={{ color: 'var(--text-4)' }} onClick={() => { setDismissed(true); latchRef.current = true }}>
          <X size={11} />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`fixed right-4 z-[var(--z-hud)] hidden flex-col overflow-hidden rounded-[14px] md:flex ${maximized ? 'w-[420px]' : 'w-[340px]'}`}
      style={{ top: 56, maxHeight: '60vh', background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--elev-panel)' }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: 'var(--border-2)' }}>
        <span className="label">状态</span>
        <span className="mono ml-auto" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
          {busy ? '运行中' : '空闲'}
        </span>
        <button type="button" className="rounded-[4px] p-1" style={{ color: 'var(--text-3)' }} title="收起" onClick={collapse}>
          <ChevronDown size={12} />
        </button>
        <button type="button" className="rounded-[4px] p-1" style={{ color: 'var(--text-3)' }} title={maximized ? '还原' : '最大化'} onClick={() => setMaximized((v) => !v)}>
          <span className="mono" style={{ fontSize: 9 }}>{maximized ? '▤' : '▣'}</span>
        </button>
        <button type="button" className="rounded-[4px] p-1" style={{ color: 'var(--text-3)' }} title="本回合不再提醒" onClick={() => { setDismissed(true); latchRef.current = true }}>
          <X size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="label mb-1.5">计划 · {done}/{todos.length}</p>
        {todos.length === 0 && <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-4)' }}>没有待办</p>}
        <ul className="mb-3 flex flex-col gap-1">
          {todos.slice(0, 8).map((t, i) => (
            <li key={i} className="flex items-start gap-1.5" style={{ fontSize: 'var(--ui-xs)' }}>
              <span
                className="mt-[5px] size-1.5 shrink-0 rounded-full"
                style={{ background: t.status === 'completed' ? 'var(--ok)' : t.status === 'in_progress' ? 'var(--accent)' : 'var(--border)' }}
                aria-hidden
              />
              <span style={{ color: t.status === 'completed' ? 'var(--text-3)' : 'var(--text-2)' }}>{t.content ?? t.text}</span>
            </li>
          ))}
        </ul>

        <p className="label mb-1.5">子代理 · 运行中 {busySubs.length}</p>
        {busySubs.length === 0 && <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-4)' }}>没有正在运行的子代理</p>}
        <div className="flex flex-col gap-1">
          {busySubs.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-2)' }}>
              <span className="ocrc-pulse-dot size-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{s.name || s.id}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
