// components/transcript/Dock.tsx — the composer dock (opencode app register):
// pending approvals / questions and the live todo list dock BELOW the composer
// instead of interrupting the transcript. Pending items are filtered OUT of
// the timeline (SessionPage passes the filter); answered ones remain there.
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, ListChecks } from 'lucide-react'
import { api } from '$lib/api/client.js'
import { CardView } from '../cards/CardView.js'
import type { StructuredCard } from '$lib/api/types.js'

export interface DockData {
  pendingApproval?: Extract<StructuredCard, { kind: 'approval' }>
  pendingQuestion?: Extract<StructuredCard, { kind: 'question' }>
}

export function Dock({ data, sessionId }: { data: DockData; sessionId: string }) {
  const hasDock = !!data.pendingApproval || !!data.pendingQuestion
  return (
    <>
      {hasDock && (
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-2"
          role="region"
          aria-label="待处理交互"
        >
          {data.pendingApproval && <CardView card={data.pendingApproval} />}
          {data.pendingQuestion && <CardView card={data.pendingQuestion} />}
        </div>
      )}
      <TodoDock sessionId={sessionId} />
    </>
  )
}

interface TodoRow { content?: string; text?: string; status?: string }

/** Live todo list (3s poll, visible-only): collapsed to a progress strip,
 *  expandable to the checklist. Read-only — opencode has no todo-write API. */
function TodoDock({ sessionId }: { sessionId: string }) {
  const [todos, setTodos] = useState<TodoRow[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.hidden || !alive) return
      void api.todo(sessionId).then((rows) => {
        if (alive && Array.isArray(rows) && rows.length > 0) setTodos(rows as TodoRow[])
      }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionId])

  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const pct = Math.round((done / todos.length) * 100)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div
        className="flex items-center gap-2 rounded-[9px] px-3 py-1.5"
        style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-2)' }}
      >
        <ListChecks size={13} strokeWidth={1.75} style={{ color: 'var(--text-3)' }} aria-hidden />
        <button type="button" className="flex items-center gap-2" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-2)' }} onClick={() => setOpen((v) => !v)}>
          待办 {done}/{todos.length}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <div className="ml-auto h-1 w-24 overflow-hidden rounded-full" style={{ background: 'var(--border-2)' }} aria-hidden>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--accent)', transition: 'width var(--dur-2) var(--ease-out)' }} />
        </div>
      </div>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 rounded-[9px] p-3" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-2)' }}>
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5" style={{ fontSize: 'var(--ui-sm)' }}>
              <span
                className="mt-[7px] size-1.5 shrink-0 rounded-full"
                style={{ background: t.status === 'completed' ? 'var(--ok)' : t.status === 'in_progress' ? 'var(--accent)' : 'var(--border)' }}
                aria-hidden
              />
              <span style={{ color: t.status === 'completed' ? 'var(--text-3)' : 'var(--text-2)' }}>
                {t.content ?? t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
