// SessionPage — the real M2 page: viewSession wiring (history + subscribe +
// prune), the transcript over the live feed, and the composer. Chips/docks
// are M2-3b.
import { useParams } from 'react-router'
import { useEffect, useState } from 'react'
import { useSessions } from '../lib/stores/sessions.js'
import { useFeeds, cardsOf, isRunningCard } from '../lib/stores/feeds.js'
import { viewSession } from '../lib/ws/boot.js'
import { Transcript, useFeed } from '../components/transcript/Transcript.js'
import { Composer } from '../components/composer/Composer.js'
import { Dock } from '../components/transcript/Dock.js'
import { useApprovals } from '../lib/stores/approvals.js'
import { SessionIdContext } from '../components/transcript/sessionContext.js'
import { useUi } from '../lib/stores/ui.js'

export function SessionPage() {
  const { id } = useParams<{ id: string }>()
  return id ? <SessionPageInner id={id} /> : null
}

function SessionPageInner({ id }: { id: string }) {
  const setActiveSession = useUi((s) => s.setActiveSession)
  const activeSessionId = useUi((s) => s.activeSessionId)
  const list = useSessions((s) => s.list)
  const serverBusy = useSessions((s) => s.serverBusy[id])
  const feed = useFeed(id)
  const [, force] = useState(0)

  useEffect(() => {
    if (id !== activeSessionId) setActiveSession(id)
    void viewSession(id)
    // id is the full dependency; activeSessionId reads latest via closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // re-render on feed writes (cardsOf derives from the feed object identity)
  useEffect(() => useFeeds.subscribe(() => force((n) => n + 1)), [])

  const s = list.find((x) => x.id === id)
  const running = !!serverBusy || cardsOf(feed).some((c) => isRunningCard(c.kind))

  // dock: pending approvals/questions surface below the composer and are
  // filtered out of the timeline; answered ones stay in the transcript
  const answered = useApprovals((st) => st.answered)
  const cards = cardsOf(feed)
  const isPending = (c: (typeof cards)[number]): boolean => {
    if (c.kind === 'approval') return !answered[c.requestId]
    if (c.kind === 'question') return !c.resolved && !answered[c.requestId]
    return false
  }
  const pendingApproval = [...cards].reverse().find((c) => c.kind === 'approval' && isPending(c)) as
    | Extract<(typeof cards)[number], { kind: 'approval' }>
    | undefined
  const pendingQuestion = [...cards].reverse().find((c) => c.kind === 'question' && isPending(c)) as
    | Extract<(typeof cards)[number], { kind: 'question' }>
    | undefined

  return (
    <SessionIdContext.Provider value={id}>
      <div className="flex h-full flex-col">
        <Transcript sessionId={id} feed={feed} filter={isPending} />
        <div
          className="flex h-7 shrink-0 items-center gap-2 border-t px-4"
          style={{ borderColor: 'var(--border-2)' }}
        >
          <span
            className={`size-1.5 rounded-full ${running ? 'ocrc-pulse-dot' : ''}`}
            style={{ background: running ? 'var(--accent)' : 'var(--ok)' }}
            aria-hidden
          />
          <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>{running ? '运行中' : '空闲'}</span>
          {s?.model && <span className="mono" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{s.model}</span>}
        </div>
        <Composer sessionId={id} />
        <Dock sessionId={id} data={{ pendingApproval, pendingQuestion }} />
      </div>
    </SessionIdContext.Provider>
  )
}
