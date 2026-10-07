// components/composer/Composer.tsx — M2-3a: send/abort core. Optimistic user
// card (failed sends roll back), busy = serverBusy OR any running live card,
// Enter sends / Shift+Enter newlines, autogrow. Chips (权限四档/模型/思考/用
// 量) and the dock pattern land in M2-3b.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { api } from '$lib/api/client.js'
import { ModeChip, ModelChip, EffortChip, ContextChip } from './Chips.js'
import { useUi } from '../../lib/stores/ui.js'
import { useSessions } from '../../lib/stores/sessions.js'
import { upsertCard, removeCard, isRunningCard, cardsOf, feedOf } from '../../lib/stores/feeds.js'

let clientIdSeq = 0

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [variant, setVariant] = useState<string | null>(null)
  const [contextUsage, setContextUsage] = useState<{ used: number; max: number } | undefined>(undefined)
  const setComposerEmpty = useUi((st) => st.setComposerEmpty)
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

  // StatusPanel auto-expand consumes this (composer empty = user idle)
  useEffect(() => { setComposerEmpty(text.trim().length === 0) }, [text, setComposerEmpty])

  // context usage (session-scoped) — refresh on turn completion is M3's feed tick
  useEffect(() => {
    void api.context(sessionId).then((c) => {
      const t = (c as { tokens?: { used?: number; max?: number } }).tokens
      if (t?.used && t?.max) setContextUsage({ used: t.used, max: t.max })
    }).catch(() => {})
  }, [sessionId])

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
      const { messageId } = await api.sendMessage({ sessionId, text: t, clientId, variant: variant ?? undefined })
      // The server republishes the user card with the real message id (relay
      // register: reconciles in place) — drop our temporary-id copy either way.
      if (messageId) removeCard(clientId)
    } catch {
      removeCard(clientId)
      setText(t)
    } finally {
      setSending(false)
    }
  }

  const stop = () => { void api.abort(sessionId) }

  return (
    // ZCode composer register：会话态输入面 = rounded-2xl bg-surface（无框），
    // 输入行在上、chips 行 + 发送钮在下（都在面内）。
    <div className="px-4 pb-4">
      <div className="mx-auto max-w-3xl rounded-2xl bg-surface p-2">
        <textarea
          ref={taRef}
          rows={1}
          className="min-h-[24px] w-full flex-1 resize-none bg-transparent px-2 py-1.5 text-foreground outline-none"
          style={{ fontSize: 'var(--text-mobile-input-safe)' }}
          placeholder={busy ? '运行中 — 可继续输入排队' : '发出后续修改要求'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
          }}
        />
        <div className="mt-1 flex items-center gap-1.5 px-1">
          <ModeChip sessionId={sessionId} />
          <ModelChip sessionId={sessionId} />
          <EffortChip variant={variant} setVariant={setVariant} />
          <ContextChip usage={contextUsage} />
          <span className="ml-auto hidden text-ui-2xs text-foreground-subtlest md:inline">
            Enter 发送 · Shift+Enter 换行
          </span>
          {busy ? (
            <button
              type="button"
              aria-label="停止"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-hover text-foreground transition-colors hover:bg-surface-hover"
              onClick={stop}
            >
              <Square className="size-3" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="发送"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg bg-brand text-foreground-inverse transition-opacity hover:opacity-80 disabled:opacity-50"
              disabled={!text.trim() || sending}
              onClick={() => void send()}
            >
              <ArrowUp className="size-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
