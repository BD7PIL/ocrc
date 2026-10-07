// SessionPage — the real M2 page: viewSession wiring (history + subscribe +
// prune), the transcript over the live feed, the composer, the workbench
// split (M6) and the whiteboard dialog. Chips/docks are M2-3b.
import { useParams } from 'react-router'
import { useEffect, useState } from 'react'
import { useSessions } from '../lib/stores/sessions.js'
import { useFeeds, cardsOf, isRunningCard } from '../lib/stores/feeds.js'
import { peekSession, viewSession } from '../lib/ws/boot.js'
import { Transcript, useFeed } from '../components/transcript/Transcript.js'
import { Composer } from '../components/composer/Composer.js'
import { Dock } from '../components/transcript/Dock.js'
import { useApprovals } from '../lib/stores/approvals.js'
import { SessionIdContext } from '../components/transcript/sessionContext.js'
import { StatusPanel } from '../components/hud/StatusPanel.js'
import { Whiteboard } from '../components/hud/Whiteboard.js'
import { useUi } from '../lib/stores/ui.js'
import { CardView } from '../components/cards/CardView.js'

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

  const splitSessionId = useUi((st) => st.splitSessionId)
  const setSplitSessionId = useUi((st) => st.setSplitSessionId)
  const whiteboardOpen = useUi((st) => st.whiteboardOpen)
  const setWhiteboardOpen = useUi((st) => st.setWhiteboardOpen)

  useEffect(() => {
    if (id !== activeSessionId) setActiveSession(id)
    void viewSession(id)
    // id is the dependency; activeSessionId reads latest via closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // re-render on feed writes (cardsOf derives from the feed object identity)
  useEffect(() => useFeeds.subscribe(() => force((n) => n + 1)), [])

  const s = list.find((x) => x.id === id)
  const running = !!serverBusy || cardsOf(feed).some((c) => isRunningCard(c.kind))
  const splitSession = splitSessionId ? list.find((x) => x.id === splitSessionId) : null

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
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <StatusPanel sessionId={id} running={running} />
        <Transcript sessionId={id} feed={feed} filter={isPending} busy={running} />
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
          <button
            type="button"
            className="ml-auto rounded-[6px] px-2 py-0.5"
            style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)', border: '1px solid var(--border-2)' }}
            title="画板"
            onClick={() => setWhiteboardOpen(true)}
          >
            画板
          </button>
          <button
            type="button"
            className="rounded-[6px] px-2 py-0.5"
            style={{
              fontSize: 'var(--ui-2xs)',
              color: splitSessionId ? 'var(--accent)' : 'var(--text-3)',
              border: `1px solid ${splitSessionId ? 'var(--accent-line)' : 'var(--border-2)'}`,
            }}
            title="多会话分屏"
            onClick={() => setSplitSessionId(splitSessionId ? null : (list.find((x) => x.id !== id)?.id ?? null))}
          >
            分屏
          </button>
        </div>
        <Composer sessionId={id} />
        <Dock sessionId={id} data={{ pendingApproval, pendingQuestion }} />
      </div>

      {/* workbench split (M6): a second live session pane — peek-subscribed,
          each pane keeps its own composer */}
      {splitSession && (
        <div className="flex h-full min-w-0 flex-1 flex-col border-l" style={{ borderColor: 'var(--border)' }}>
          <SplitPaneHeader
            sessions={list.filter((x) => x.id !== id)}
            value={splitSession.id}
            onChange={setSplitSessionId}
            onClose={() => setSplitSessionId(null)}
          />
          <SplitTranscript sessionId={splitSession.id} />
        </div>
      )}

      {whiteboardOpen && <Whiteboard sessionId={id} onClose={() => setWhiteboardOpen(false)} />}
    </SessionIdContext.Provider>
  )
}

function SplitPaneHeader({ sessions, value, onChange, onClose }: {
  sessions: Array<{ id: string; title: string }>
  value: string
  onChange: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: 'var(--border-2)' }}>
      <span className="label">分屏</span>
      <select
        className="min-w-0 flex-1 rounded-[9px] px-2 py-1 outline-none"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-xs)' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {sessions.map((x) => (
          <option key={x.id} value={x.id}>{x.title || x.id}</option>
        ))}
      </select>
      <button type="button" className="rounded-[6px] p-1" style={{ color: 'var(--text-3)' }} onClick={onClose} title="关闭分屏">✕</button>
    </div>
  )
}

function SplitTranscript({ sessionId }: { sessionId: string }) {
  const feed = useFeed(sessionId)
  useEffect(() => { peekSession(sessionId) }, [sessionId])
  useEffect(() => {
    // live follow: peek feeds update via the same ws hub; scroll to bottom
    const el = document.querySelector(`[data-split="${sessionId}"]`)
    if (el) el.scrollTop = el.scrollHeight
  }, [feed, sessionId])
  const cards = cardsOf(feed)
  return (
    <div data-split={sessionId} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
        {!feed && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>加载分屏转写…</p>}
        {cards.map((c) => (
          <div key={c.id} className="cv-card"><CardView card={c} /></div>
        ))}
        {feed && cards.length === 0 && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>（空会话）</p>}
      </div>
    </div>
  )
}
