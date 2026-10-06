// components/transcript/TurnNavigator.tsx — the turn-scale rail on the
// transcript's right edge (dsh TurnNavigator register): one tick per user
// turn at its proportional position, click jumps to the turn, running turns
// pulse. Re-measures on content growth and container resize.
import { useEffect, useState, type RefObject } from 'react'
import type { StructuredCard } from '$lib/api/types.js'
import { computeTurnAnchors, type TurnAnchor } from './turns.js'

export function TurnNavigator({ scrollerRef, cards, busy }: {
  scrollerRef: RefObject<HTMLDivElement | null>
  cards: StructuredCard[]
  busy: boolean
}) {
  const [anchors, setAnchors] = useState<TurnAnchor[]>([])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => {
      const offsets = new Map<string, number>()
      scroller.querySelectorAll<HTMLElement>('.cv-card[data-card-id]').forEach((el) => {
        const id = el.dataset.cardId
        if (id) offsets.set(id, el.offsetTop - scroller.offsetTop)
      })
      setAnchors(computeTurnAnchors(cards, offsets, scroller.scrollHeight))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scroller)
    const list = scroller.querySelector('.flex.flex-col')
    if (list) ro.observe(list)
    return () => ro.disconnect()
  }, [cards, scrollerRef])

  if (anchors.length === 0) return null

  const jump = (a: TurnAnchor) => {
    const el = scrollerRef.current?.querySelector(`.cv-card[data-card-id="${CSS.escape(a.cardId)}"]`)
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <nav
      className="absolute right-0.5 top-2 bottom-2 w-3"
      aria-label="回合导航"
      style={{ zIndex: 5 }}
    >
      {anchors.map((a) => (
        <button
          key={a.cardId}
          type="button"
          title={`跳转到回合 · ${a.running ? '运行中' : '已完成'}`}
          onClick={() => jump(a)}
          className={`turn-tick ${a.running ? 'turn-tick-busy' : ''}`}
          style={{ top: `${a.frac * 100}%` }}
          aria-label={`回合 ${a.cardId}`}
        />
      ))}
      {busy && <span className="turn-tick-busy-pulse" aria-hidden />}
    </nav>
  )
}
