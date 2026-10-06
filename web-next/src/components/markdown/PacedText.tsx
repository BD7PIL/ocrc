// components/markdown/PacedText.tsx — 24ms paced reveal for STREAMING text
// (opencode message-part register: length-adaptive step + punctuation snap —
// pure math in cards/tool/pure.ts). Finalized text renders instantly.
// Markdown parses only at finalize; streaming shows paced plain text (the
// ocrc streaming register — no per-tick re-parse).
import { useEffect, useRef, useState } from 'react'
import { PACE_MS, nextReveal } from '../cards/tool/pure.js'

export function PacedText({ text, streaming }: { text: string; streaming: boolean }) {
  const [shown, setShown] = useState(() => (streaming ? Math.min(text.length, 64) : text.length))
  const shownRef = useRef(shown)
  shownRef.current = shown

  useEffect(() => {
    if (!streaming) {
      setShown(text.length)
      return
    }
    // Target grew (or shrank on snapshot replace): catch up at PACE_MS.
    const timer = setInterval(() => {
      setShown((cur) => nextReveal(cur, text))
    }, PACE_MS)
    return () => clearInterval(timer)
  }, [text, streaming])

  const visible = streaming ? text.slice(0, shown) : text
  return (
    <span className="whitespace-pre-wrap" style={{ color: 'var(--text)' }}>
      {visible}
      {streaming && shown < text.length && (
        <span className="ocrc-blink-dot ml-0.5 inline-block h-3.5 w-[7px] align-text-bottom" style={{ background: 'var(--accent)' }} aria-hidden />
      )}
    </span>
  )
}
