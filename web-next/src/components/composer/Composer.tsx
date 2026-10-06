// components/composer/Composer.tsx — M2-3a: send/abort core. Optimistic user
// card (failed sends roll back), busy = serverBusy OR any running live card,
// Enter sends / Shift+Enter newlines, autogrow. Chips (权限四档/模型/思考/用
// 量) and the dock pattern land in M2-3b.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { api } from '$lib/api/client.js'
import { useSessions } from '../../lib/stores/sessions.js'
import { upsertCard, removeCard, isRunningCard, cardsOf, feedOf } from '../../lib/stores/feeds.js'

let clientIdSeq = 0

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const serverBusy = useSessions((s) => s.serverBusy[sessionId])

  // busy = server snapshot flag OR any running live card ("any live card
  // exists" — a queued USER card must not flip it; register: sessions.ts).
  const feed = feedOf(sessionId)
  const anyRunning = cardsOf(feed).some((c) => isRunningCard(c.kind))
  const busy = !!serverBusy || anyRunning

  // Autogrow (keystroke discipline: write style only when height changes).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const h = Math.min(140, ta.scrollHeight)
    if (ta.style.height !== `${h}px`) ta.style.height = `${h}px`
  }, [text])

  const send = async () => {
    const t = text.trim()
    if (!t || busy || sending) return
    const clientId = `web-${Date.now()}-${++clientIdSeq}`
    setText('')
    setSending(true)
    // Optimistic user card; reconciles in place via the shared id mechanism
    // (server republishes the user card with its own id — ours is temporary).
    upsertCard({ kind: 'user', sessionId, text: t, ts: Date.now(), origin: 'web', id: clientId } as any)
    try {
      await api.sendMessage({ sessionId, text: t, clientId })
    } catch {
      removeCard(clientId)
      setText(t)
    } finally {
      setSending(false)
    }
  }

  const stop = () => { void api.abort(sessionId) }

  return (
    <div className="px-4 pb-4">
      <div
        className="mx-auto flex max-w-3xl items-end gap-2 rounded-[14px] p-2"
        style={{ background: 'var(--bg-input)', border: `1px solid ${busy ? 'var(--accent-line)' : 'var(--border)'}` }}
      >
        <textarea
          ref={taRef}
          rows={1}
          className="min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 outline-none"
          style={{ color: 'var(--text)', fontSize: 'var(--text-mobile-input-safe)' }}
          placeholder={busy ? '运行中 — 可继续输入排队' : '发出后续修改要求'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
          }}
        />
        {busy ? (
          <button
            type="button"
            aria-label="停止"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'var(--bg-elev2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            onClick={stop}
          >
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="发送"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            disabled={!text.trim() || sending}
            onClick={() => void send()}
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl px-2" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
        Enter 发送 · Shift+Enter 换行 · 权限/模型 chips 在 M2-3b 落地
      </p>
    </div>
  )
}
