import { useNavigate } from 'react-router'
import { useSessions } from '../lib/stores/sessions.js'
import { useUi } from '../lib/stores/ui.js'

export function HomePage() {
  const navigate = useNavigate()
  const list = useSessions((s) => s.list)
  const setNewSessionOpen = useUi((s) => s.setNewSessionOpen)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="inline-block size-4 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
      <h1 style={{ fontSize: 'var(--ui-xl)', color: 'var(--text)' }}>要让 agent 做什么？</h1>
      <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>
        {list.length > 0 ? `左栏选择一个会话，或新建任务（${list.length} 个会话）` : '新建一个任务开始'}
      </p>
      <button
        type="button"
        className="rounded-[9px] px-4 py-2"
        style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
        onClick={() => setNewSessionOpen(true)}
      >
        新建任务
      </button>
      <p className="mono" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
        聊天流在 M2 落地 · <a href="/next/dev/tokens" style={{ color: 'var(--text-4)' }}>token gallery</a>
      </p>
      {/* keep navigate referenced for the upcoming session shortcuts */}
      <span className="hidden">{typeof navigate}</span>
    </div>
  )
}
