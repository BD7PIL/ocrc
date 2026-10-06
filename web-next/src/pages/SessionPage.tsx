// M2 placeholder: the conversation timeline + composer land here. The page
// already binds the route param to the shell's active-session state.
import { useParams } from 'react-router'
import { useEffect } from 'react'
import { useSessions } from '../lib/stores/sessions.js'
import { useUi } from '../lib/stores/ui.js'

export function SessionPage() {
  const { id } = useParams<{ id: string }>()
  const setActiveSession = useUi((s) => s.setActiveSession)
  const activeSessionId = useUi((s) => s.activeSessionId)
  const list = useSessions((s) => s.list)
  const s = list.find((x) => x.id === id)

  useEffect(() => {
    if (id && id !== activeSessionId) setActiveSession(id)
  }, [id, activeSessionId, setActiveSession])

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 style={{ fontSize: 'var(--ui-lg)', color: 'var(--text)' }}>{s?.title || '会话'}</h1>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>
        <dt className="mono">id</dt><dd className="mono truncate">{id}</dd>
        {s?.directory && (<><dt className="mono">dir</dt><dd className="mono truncate">{s.directory}</dd></>)}
        {s?.model && (<><dt className="mono">model</dt><dd>{s.model}</dd></>)}
        {s?.backendId && (<><dt className="mono">backend</dt><dd className="mono">{s.backendId}</dd></>)}
      </dl>
      <p className="mt-6" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>
        聊天流（回合式时间线 / composer / dock）按蓝图在 M2 落地。
      </p>
    </div>
  )
}
