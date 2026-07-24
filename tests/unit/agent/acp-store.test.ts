import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAcpStore, MAX_CARDS_PER_SESSION } from '../../../src/core/agent/acp-store'
import type { StructuredCard } from '../../../src/core/structured-card'

const tmp = () => `/tmp/acp-store-cap-${Math.random().toString(36).slice(2)}.json`
const card = (n: number) => ({ kind: 'user', sessionId: 's1', id: `c${n}`, text: `msg ${n}`, ts: n }) as unknown as StructuredCard

describe('createAcpStore card cap', () => {
  it('evicts the oldest cards beyond MAX_CARDS_PER_SESSION (write side is bounded)', () => {
    const store = createAcpStore(tmp())
    store.create('s1')
    for (let i = 0; i < MAX_CARDS_PER_SESSION + 50; i++) store.recordCard('s1', card(i), i)
    const cards = store.getCards('s1')
    expect(cards).toHaveLength(MAX_CARDS_PER_SESSION)
    // the oldest 50 were evicted; newest retained, order preserved
    expect((cards[0] as { id: string }).id).toBe('c50')
    expect((cards[cards.length - 1] as { id: string }).id).toBe(`c${MAX_CARDS_PER_SESSION + 49}`)
  })

  it('replacing an existing card (same id) does not grow or evict', () => {
    const store = createAcpStore(tmp())
    store.create('s1')
    for (let i = 0; i < MAX_CARDS_PER_SESSION; i++) store.recordCard('s1', card(i), i)
    store.recordCard('s1', { ...card(0), text: 'edited' } as unknown as StructuredCard, 999)
    const cards = store.getCards('s1')
    expect(cards).toHaveLength(MAX_CARDS_PER_SESSION)
    expect((cards[0] as { text: string }).text).toBe('edited')
  })

  it('persists the trimmed list (state file stays bounded)', async () => {
    const path = tmp()
    const store = createAcpStore(path)
    store.create('s1')
    for (let i = 0; i < MAX_CARDS_PER_SESSION + 10; i++) store.recordCard('s1', card(i), i)
    await store.flush()
    const persisted = JSON.parse(readFileSync(path, 'utf-8'))
    expect(persisted.sessions.s1.cards).toHaveLength(MAX_CARDS_PER_SESSION)
  })
})
