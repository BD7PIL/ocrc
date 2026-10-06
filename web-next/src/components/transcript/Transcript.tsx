// components/transcript/Transcript.tsx — the windowed conversation timeline
// (ocrc register: FIRST_WINDOW 24 / +80 expansion / REST 加载更早;
// content-visibility keeps off-screen cards cheap; stick-to-bottom with a
// 48px tolerance — follow only when the user is actually at the bottom).
import { useEffect, useRef, useState } from 'react'
import { api } from '$lib/api/client.js'
import { useFeeds, cardsOf, prependHistory, type SessionFeed } from '$lib/stores/feeds.js'
import { CardView } from '../cards/CardView.js'

const FIRST_WINDOW = 24
const WINDOW = 80

export function Transcript({ sessionId, feed }: { sessionId: string; feed: SessionFeed | undefined }) {
  const cards = cardsOf(feed)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(FIRST_WINDOW)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const pinnedRef = useRef(true)

  // Stick-to-bottom: follow new content only when the user is within 48px of
  // the bottom (user scroll-up yields; the 最新 chip returns in M2-3).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Follow new content (streaming appends / new cards) while pinned.
  const signature = cards.length + ':' + (cards[cards.length - 1]?.id ?? '')
  useEffect(() => {
    if (pinnedRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [signature])

  // Session switch: jump to the latest immediately.
  useEffect(() => {
    setVisibleCount(FIRST_WINDOW)
    pinnedRef.current = true
    const el = scrollRef.current
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [sessionId])

  const loadOlder = async () => {
    if (loadingOlder || !feed) return
    setLoadingOlder(true)
    try {
      const hidden = cards.length - visibleCount
      const { cards: older } = await api.history(sessionId, { offset: hidden, limit: Math.min(WINDOW, hidden) })
      if (older.length > 0) {
        const el = scrollRef.current
        const before = el?.scrollHeight ?? 0
        prependHistory(sessionId, older)
        setVisibleCount((v) => v + older.length) // widen the window to include the prepended page
        requestAnimationFrame(() => {
          if (el) el.scrollTop += el.scrollHeight - before // anchor: no jump
        })
      } else {
        setVisibleCount((v) => v + WINDOW) // local expansion fallback
      }
    } finally {
      setLoadingOlder(false)
    }
  }

  if (!feed) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5" style={{ color: 'var(--text-3)' }}>
        <span className="ocrc-pulse-dot size-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
        <span style={{ fontSize: 'var(--ui-sm)' }}>加载转写…</span>
      </div>
    )
  }

  const windowed = cards.length > visibleCount
  const shown = windowed ? cards.slice(cards.length - visibleCount) : cards

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
        {windowed && (
          <button
            type="button"
            className="mx-auto rounded-full px-3 py-1"
            style={{ border: '1px solid var(--border)', color: 'var(--text-3)', fontSize: 'var(--ui-xs)' }}
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? '加载中…' : `加载更早消息（${cards.length - visibleCount} 条）`}
          </button>
        )}
        {shown.map((c) => (
          <div key={c.id} className="cv-card">
            <CardView card={c} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function useFeed(sessionId: string): SessionFeed | undefined {
  return useFeeds((s) => s.feeds[sessionId])
}
