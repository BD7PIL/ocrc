import { describe, it, expect, vi } from 'vitest'
import { createWsHub } from '../../../src/transport/web/ws-hub'
import { createCardBus } from '../../../src/core/card-bus'

function fakeWs() {
  const sent: any[] = []
  return {
    sent,
    readyState: 1,
    send: vi.fn((msg: string) => { sent.push(JSON.parse(msg)) }),
    close: vi.fn(),
    on: vi.fn(),
  }
}

function fakeClient() {
  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  } as any
}

function fakeState() {
  return {
    getSessionCost: vi.fn().mockReturnValue(undefined),
    normalizeSessionId: (id: string) => id,
  } as any
}

describe('WsHub', () => {
  it('broadcastDelta follows the subscription filter and is never buffered', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const sub = fakeWs()
    const other = fakeWs()
    await hub.attach(sub as any, { email: 'u@x' } as any)
    await hub.attach(other as any, { email: 'u@x' } as any)
    hub.handleClientMessage(sub as any, { type: 'subscribe', sessionId: 'ses_1' })
    hub.handleClientMessage(other as any, { type: 'subscribe', sessionId: 'ses_2' })
    hub.broadcastDelta({ sessionId: 'ses_1', cardId: 'turn:1', partId: 'p1', text: 'lo' })
    hub.broadcastDelta({ sessionId: 'ses_2', cardId: 'turn:2', partId: 'p1', text: 'x' })
    const deltas = sub.sent.filter((m: any) => m.type === 'sdelta')
    expect(deltas).toEqual([
      { type: 'sdelta', sessionId: 'ses_1', cardId: 'turn:1', partId: 'p1', text: 'lo' },
    ])
    expect(other.sent.filter((m: any) => m.type === 'sdelta').map((m: any) => m.sessionId)).toEqual(['ses_2'])
    // Deltas bypass the CardBus — replay never carries them.
    expect(bus.recent('ses_1')).toHaveLength(0)
    expect(bus.currentSeq('ses_1')).toBe(0)
  })
  it('broadcasts cards for subscribed sessionId', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1' })
    bus.publish({ kind: 'thinking', sessionId: 'ses_1', showStop: true })
    expect(ws.sent.some((m: any) => m.type === 'card')).toBe(true)
  })

  it('does not forward cards for other sessions', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1' })
    bus.publish({ kind: 'thinking', sessionId: 'ses_2', showStop: true })
    const cardMsgs = ws.sent.filter((m: any) => m.type === 'card')
    expect(cardMsgs.length).toBe(0)
  })

  it('does NOT broadcast proactive (push) cards to web — live', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1' })
    bus.publish({ kind: 'info', sessionId: 'ses_1', title: 'Test failure detected', sections: [], proactive: true })
    bus.publish({ kind: 'info', sessionId: 'ses_1', title: 'Normal info', sections: [] })
    const titles = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.title)
    expect(titles).toEqual(['Normal info']) // proactive one filtered out
  })

  it('does NOT replay proactive (push) cards on subscribe', async () => {
    const bus = createCardBus()
    bus.publish({ kind: 'info', sessionId: 'ses_1', title: 'Session finished', sections: [], proactive: true }) // seq 1
    bus.publish({ kind: 'assistant', sessionId: 'ses_1', blocks: [], meta: {} })                                 // seq 2
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1', sinceSeq: 0 })
    const kinds = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.kind)
    expect(kinds).toEqual(['assistant']) // proactive info not replayed
  })

  it('replies pong to ping', async () => {
    const hub = createWsHub({ cardBus: createCardBus(), client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'ping' })
    expect(ws.sent.at(-1)).toEqual({ type: 'pong' })
  })

  it('replays buffered cards with seq > sinceSeq on subscribe, then replayEnd', async () => {
    const bus = createCardBus()
    bus.publish({ kind: 'user', sessionId: 'ses_1', text: 'a', ts: 0 })       // seq 1
    bus.publish({ kind: 'assistant', sessionId: 'ses_1', blocks: [], meta: {} }) // seq 2
    bus.publish({ kind: 'assistant', sessionId: 'ses_1', blocks: [], meta: {} }) // seq 3

    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1', sinceSeq: 1 })

    const replayed = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.seq)
    expect(replayed).toEqual([2, 3]) // seq 1 already in the client's snapshot
    expect(ws.sent.at(-1)).toMatchObject({ type: 'replayEnd', sessionId: 'ses_1', lastSeq: 3 })
  })

  it('replays nothing when sinceSeq is current', async () => {
    const bus = createCardBus()
    bus.publish({ kind: 'user', sessionId: 'ses_1', text: 'a', ts: 0 }) // seq 1
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1', sinceSeq: 1 })
    expect(ws.sent.filter((m: any) => m.type === 'card').length).toBe(0)
  })

  it('flags replayEnd complete=true when the snapshot is inside the buffer', async () => {
    const bus = createCardBus(3)
    bus.publish({ kind: 'user', sessionId: 'ses_1', text: 'a', ts: 0 })         // seq 1
    bus.publish({ kind: 'assistant', sessionId: 'ses_1', blocks: [], meta: {} }) // seq 2
    bus.publish({ kind: 'assistant', sessionId: 'ses_1', blocks: [], meta: {} }) // seq 3
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1', sinceSeq: 1 })
    expect(ws.sent.at(-1)).toMatchObject({ type: 'replayEnd', lastSeq: 3, complete: true })
  })

  it('flags replayEnd complete=false when the snapshot predates the buffer (torn feed)', async () => {
    const bus = createCardBus(2)
    for (let i = 0; i < 5; i++) bus.publish({ kind: 'user', sessionId: 'ses_1', text: `m${i}`, ts: 0 }) // seq 1..5, buffer holds 4-5
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1', sinceSeq: 1 })
    expect(ws.sent.at(-1)).toMatchObject({ type: 'replayEnd', lastSeq: 5, complete: false })
    const replayed = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.seq)
    expect(replayed).toEqual([4, 5]) // replay bridges only part of the gap
  })

  it('empty buffer with a dropped session reports complete (drop resets the counter)', async () => {
    const bus = createCardBus()
    bus.publish({ kind: 'user', sessionId: 'ses_1', text: 'a', ts: 0 }) // seq 1
    bus.drop('ses_1') // buffer AND seq counter reset → currentSeq = 0
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1', sinceSeq: 1 })
    expect(ws.sent.at(-1)).toMatchObject({ type: 'replayEnd', lastSeq: 0, complete: true })
  })

  it('registers the client synchronously: subscribe sent before attach resolves is not lost', async () => {
    const bus = createCardBus()
    let resolveSummaries!: (rows: any[]) => void
    const registry = {
      all: () => [{ id: 'b', backend: { listSessionSummaries: () => new Promise<any[]>((r) => { resolveSummaries = r }) } }],
      tag: vi.fn(),
    } as any
    const hub = createWsHub({ cardBus: bus, registry, state: fakeState() })
    const ws = fakeWs()
    const attached = hub.attach(ws as any, { email: 'u@x' } as any)
    // Message arrives in the window before the summaries fetch resolves.
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_1' })
    resolveSummaries([])
    await attached
    expect(ws.sent.some((m: any) => m.type === 'hello')).toBe(true)
    bus.publish({ kind: 'thinking', sessionId: 'ses_1', showStop: true })
    expect(ws.sent.some((m: any) => m.type === 'card')).toBe(true)
  })

  it('detach during a pending attach leaves no dead client and skips hello', async () => {
    const bus = createCardBus()
    let resolveSummaries!: (rows: any[]) => void
    const registry = {
      all: () => [{ id: 'b', backend: { listSessionSummaries: () => new Promise<any[]>((r) => { resolveSummaries = r }) } }],
      tag: vi.fn(),
    } as any
    const hub = createWsHub({ cardBus: bus, registry, state: fakeState() })
    const ws = fakeWs()
    const attached = hub.attach(ws as any, { email: 'u@x' } as any)
    ws.readyState = 0 // socket closed while summaries were loading
    hub.detach(ws as any)
    resolveSummaries([])
    await attached
    bus.publish({ kind: 'thinking', sessionId: 'ses_1', showStop: true })
    expect(ws.sent.length).toBe(0)
  })
})

describe('WsHub multi-subscribe (right-pane live tabs)', () => {
  it('forwards cards for BOTH the viewed session and a pane-subscribed child', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_main' })
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_child' })
    bus.publish({ kind: 'thinking', sessionId: 'ses_main', showStop: true })
    bus.publish({ kind: 'thinking', sessionId: 'ses_child', showStop: true })
    const sids = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.sessionId)
    expect(sids).toContain('ses_main')
    expect(sids).toContain('ses_child')
  })

  it('unsubscribe stops forwarding that session but keeps the other', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_main' })
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_child' })
    hub.handleClientMessage(ws as any, { type: 'unsubscribe', sessionId: 'ses_child' })
    bus.publish({ kind: 'thinking', sessionId: 'ses_child', showStop: true })
    bus.publish({ kind: 'thinking', sessionId: 'ses_main', showStop: true })
    const sids = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.sessionId)
    expect(sids).not.toContain('ses_child')
    expect(sids).toContain('ses_main')
  })

  it('replays the newly-subscribed child only (not the whole main feed)', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const ws = fakeWs()
    await hub.attach(ws as any, { email: 'u@x' } as any)
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_main' })
    bus.publish({ kind: 'thinking', sessionId: 'ses_child', showStop: true })
    ws.sent.length = 0
    hub.handleClientMessage(ws as any, { type: 'subscribe', sessionId: 'ses_child' })
    const replayed = ws.sent.filter((m: any) => m.type === 'card').map((m: any) => m.card.sessionId)
    expect(replayed).toEqual(['ses_child'])
  })
})

describe('WsHub fan-out stringify', () => {
  it('sends identical card bytes to multiple clients (single serialization)', async () => {
    const bus = createCardBus()
    const hub = createWsHub({ cardBus: bus, client: fakeClient(), state: fakeState() })
    const wsA = fakeWs()
    const wsB = fakeWs()
    await hub.attach(wsA as any, { email: 'a@x' } as any)
    await hub.attach(wsB as any, { email: 'b@x' } as any)
    hub.handleClientMessage(wsA as any, { type: 'subscribe', sessionId: 'ses_1' })
    hub.handleClientMessage(wsB as any, { type: 'subscribe', sessionId: 'ses_1' })
    bus.publish({ kind: 'thinking', sessionId: 'ses_1', showStop: true })
    const a = wsA.sent.find((m: any) => m.type === 'card')
    const b = wsB.sent.find((m: any) => m.type === 'card')
    expect(a).toEqual(b)
  })
})
