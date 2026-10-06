// components/transcript/turns.ts — TurnNavigator pure math (dsh
// TurnNavigator register): turn anchors from the card list + measured
// offsets, proportional tick positions, busy marking.
import type { StructuredCard } from '$lib/api/types.js'

export interface TurnAnchor {
  cardId: string
  index: number
  running: boolean
  /** 0..1 proportional position inside the scrolled content. */
  frac: number
}

/** A turn starts at every USER card; it runs while any running-kind card
 *  follows it up to the next user card. */
export function isRunningCard(kind: string | undefined): boolean {
  return kind === 'thinking' || kind === 'streaming' || kind === 'think-stream'
}

export function computeTurnAnchors(cards: StructuredCard[], offsets: Map<string, number>, contentHeight: number): TurnAnchor[] {
  const anchors: TurnAnchor[] = []
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!
    if (c.kind !== 'user') continue
    let running = false
    for (let j = i + 1; j < cards.length && cards[j]!.kind !== 'user'; j++) {
      if (isRunningCard(cards[j]!.kind)) { running = true; break }
    }
    const offset = offsets.get(c.id ?? '')
    const frac = offset != null && contentHeight > 0 ? Math.min(1, Math.max(0, offset / contentHeight)) : 0
    anchors.push({ cardId: c.id ?? `idx:${i}`, index: i, running, frac })
  }
  // Guard against ticks piling at frac 0/1 edges: nudge overlapping fracs apart
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i]!.frac - anchors[i - 1]!.frac < 0.015) {
      anchors[i]!.frac = Math.min(1, anchors[i - 1]!.frac + 0.015)
    }
  }
  return anchors
}
