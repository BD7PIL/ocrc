import { describe, it, expect } from 'vitest'
import { computeTurnAnchors } from './turns.js'
import type { StructuredCard } from '$lib/api/types.js'

const card = (kind: string, id: string): StructuredCard =>
  ({ kind, sessionId: 's', id } as unknown as StructuredCard)

describe('computeTurnAnchors', () => {
  it('anchors at user cards only, marking running turns', () => {
    const cards = [
      card('user', 'u1'), card('assistant', 'a1'),
      card('user', 'u2'), card('streaming', 'st2'),
      card('user', 'u3'), card('assistant', 'a3'),
    ]
    const offsets = new Map(cards.map((c) => [c.id!, 10]))
    const anchors = computeTurnAnchors(cards, offsets, 1000)
    expect(anchors.map((a) => a.cardId)).toEqual(['u1', 'u2', 'u3'])
    expect(anchors[1]!.running).toBe(true)
    expect(anchors[0]!.running).toBe(false)
    expect(anchors[2]!.running).toBe(false)
  })

  it('running state stops at the next user card', () => {
    const cards = [
      card('user', 'u1'), card('streaming', 's'), card('user', 'u2'),
    ]
    const anchors = computeTurnAnchors(cards, new Map([['u1', 0], ['u2', 500]]), 1000)
    expect(anchors[0]!.running).toBe(true)
    expect(anchors[1]!.running).toBe(false)
  })

  it('fracs are proportional and never collide (<1.5% apart)', () => {
    const cards = [card('user', 'u1'), card('user', 'u2'), card('user', 'u3')]
    const anchors = computeTurnAnchors(cards, new Map([['u1', 10], ['u2', 11], ['u3', 900]]), 1000)
    expect(anchors[1]!.frac - anchors[0]!.frac).toBeGreaterThanOrEqual(0.015)
    expect(anchors.every((a) => a.frac >= 0 && a.frac <= 1)).toBe(true)
  })
})
