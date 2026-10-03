import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRelay } from '../../src/core/relay'
import { createCardBus } from '../../src/core/card-bus'
import type { StructuredCard } from '../../src/core/structured-card'

// selectTuiSession uses raw fetch (SDK v1 lacks tui.selectSession).
// Stub global fetch so tests don't hit real localhost:4096 — that would
// navigate the developer's actual TUI.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function fakeBackend() {
  return {
    id: 'opencode',
    capabilities: { liveMirror: true, tuiSelect: true },
    prompt: vi.fn().mockResolvedValue(undefined),
    hasSession: vi.fn().mockResolvedValue(true),
    listSessions: vi.fn().mockResolvedValue([{ id: 'ses_test', createdAt: 1 }]),
    getSessionMeta: vi.fn().mockResolvedValue({ cost: 0.04, tokens: { input: 5100, output: 1200 }, agent: 'build', model: 'k2p6' }),
    getMessageBlocks: vi.fn().mockResolvedValue([]),
    selectTuiSession: vi.fn().mockResolvedValue(undefined),
  } as any
}

function fakeState() {
  let sid: string | undefined = 'ses_test'
  let agent: string | undefined
  let model: any
  const aborts = new Map<string, AbortController>()
  const sessionBackends = new Map<string, string>()
  let activeBackend: string | undefined
  return {
    getLastSessionId: () => sid,
    setLastSessionId: (id: string | undefined) => { sid = id },
    getPinnedSessionId: () => undefined,
    setPinnedSessionId: vi.fn(),
    getNextAgent: () => agent,
    setNextAgent: (n: string | undefined) => { agent = n },
    getNextModel: () => model,
    setNextModel: (m: any) => { model = m },
    getTuiSelectedSession: () => undefined,
    setTuiSelectedSession: vi.fn(),
    getCurrentAgent: () => undefined,
    setCurrentAgent: vi.fn(),
    getActiveAbort: (id: string) => aborts.get(id),
    setActiveAbort: vi.fn((id: string, ac: AbortController | undefined) => {
      if (ac === undefined) aborts.delete(id)
      else aborts.set(id, ac)
    }),
    getSessionCost: () => undefined,
    setSessionCost: vi.fn(),
    getSessionBackend: (id: string) => sessionBackends.get(id),
    setSessionBackend: (id: string, b: string | undefined) => { if (b === undefined) sessionBackends.delete(id); else sessionBackends.set(id, b) },
    getActiveBackend: () => activeBackend,
    setActiveBackend: (b: string | undefined) => { activeBackend = b },
    normalizeSessionId: (id: string) => id,
    flush: async () => {},
  } as any
}

describe('createRelay', () => {
  it('publishes thinking + user cards after submit, no assistant card until idle', async () => {
    const cardBus = createCardBus()
    const cards: StructuredCard[] = []
    cardBus.subscribeAll((c) => cards.push(c))

    const relay = createRelay({
      cardBus,
      backend: fakeBackend(),
      state: fakeState(),
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })

    expect(cards.some(c => c.kind === 'thinking')).toBe(true)
    expect(cards.some(c => c.kind === 'user' && (c as any).text === 'hi')).toBe(true)
    // assistant is published asynchronously via handleEvent on session.idle
    expect(cards.some(c => c.kind === 'assistant')).toBe(false)
  })

  it('routes a turn to the session-owning backend in a multi-backend registry', async () => {
    const { createBackendRegistry } = await import('../../src/core/agent/registry')
    const opencode = fakeBackend() // id 'opencode'
    const kimi = fakeBackend(); kimi.id = 'acp:kimi'
    const state = fakeState()
    state.setSessionBackend('ses_kimi', 'acp:kimi')
    const registry = createBackendRegistry({ state, backends: [
      { id: 'opencode', backend: opencode }, { id: 'acp:kimi', backend: kimi },
    ] })
    const relay = createRelay({ cardBus: createCardBus(), registry, state, chatTimeoutMs: 5000, tuiVisible: false })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm', sessionId: 'ses_kimi' })
    expect(kimi.prompt).toHaveBeenCalledWith('ses_kimi', expect.objectContaining({ text: 'hi' }))
    expect(opencode.prompt).not.toHaveBeenCalled()
  })

  it('routes to msg.sessionId (web-selected) over the global pinned session', async () => {
    const backend = fakeBackend()
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_pinned' // global pin points elsewhere
    const relay = createRelay({
      cardBus: createCardBus(),
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm', sessionId: 'ses_web_selected' })
    expect(backend.prompt).toHaveBeenCalledWith(
      'ses_web_selected',
      expect.objectContaining({ text: 'hi' }),
    )
  })

  it('navigates the TUI via /tui/select-session when tuiVisible', async () => {
    const backend = fakeBackend()
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_pinned'
    const relay = createRelay({
      cardBus: createCardBus(),
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: true,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })
    expect(backend.prompt).toHaveBeenCalled()
    expect(backend.selectTuiSession).toHaveBeenCalledWith('ses_pinned', expect.anything())
  })

  it('retries submitPrompt on network error then succeeds', async () => {
    const backend = fakeBackend()
    let calls = 0
    backend.prompt = vi.fn().mockImplementation(async () => {
      calls++
      if (calls <= 2) throw new Error('fetch failed')
      return { data: {} }
    })
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_test'
    const relay = createRelay({
      cardBus: createCardBus(),
      backend,
      state,
      chatTimeoutMs: 120000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })
    expect(calls).toBe(3)
    expect(backend.prompt).toHaveBeenCalledTimes(3)
  })

  it('gives up after max retries on network error', async () => {
    const backend = fakeBackend()
    backend.prompt = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const cardBus = createCardBus()
    const cards: StructuredCard[] = []
    cardBus.subscribeAll((c) => cards.push(c))

    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_test'
    const relay = createRelay({
      cardBus,
      backend,
      state,
      chatTimeoutMs: 120000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })
    expect(backend.prompt).toHaveBeenCalledTimes(5)
    const errorCard = cards.find(c => c.kind === 'error')
    expect(errorCard).toBeDefined()
    expect((errorCard as any).message).toMatch(/fetch failed/)
  }, 60000)

  it('does NOT retry on non-network errors', async () => {
    const backend = fakeBackend()
    backend.prompt = vi.fn().mockRejectedValue(new Error('no session found'))
    const cardBus = createCardBus()
    const cards: StructuredCard[] = []
    cardBus.subscribeAll((c) => cards.push(c))

    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_test'
    const relay = createRelay({
      cardBus,
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })
    expect(backend.prompt).toHaveBeenCalledTimes(1)
    const errorCard = cards.find(c => c.kind === 'error')
    expect(errorCard).toBeDefined()
    expect((errorCard as any).message).toMatch(/no session found/)
  })

  it('stops retrying when aborted', async () => {
    const backend = fakeBackend()
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_test'
    backend.prompt = vi.fn().mockImplementation(async (_sid: string, input: any) => {
      if (input.signal?.aborted) throw new Error('aborted')
      throw new Error('fetch failed')
    })
    const relay = createRelay({
      cardBus: createCardBus(),
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    setTimeout(() => {
      const ac = state.getActiveAbort('ses_test')
      ac?.abort()
    }, 10)
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })
    expect(backend.prompt).toHaveBeenCalledTimes(1)
  })

  it('registers abort controller during run, clears it on idle', async () => {
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_test'
    const relay = createRelay({
      cardBus: createCardBus(),
      backend: fakeBackend(),
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'msg1' })
    // registered with an AbortController while in flight
    expect(state.setActiveAbort).toHaveBeenCalledWith('ses_test', expect.any(AbortController))
    expect(state.getActiveAbort('ses_test')).toBeInstanceOf(AbortController)
    // session idle clears it
    await relay.handleEvent({ kind: 'idle', sessionId: 'ses_test' })
    expect(state.setActiveAbort).toHaveBeenCalledWith('ses_test', undefined)
    expect(state.getActiveAbort('ses_test')).toBeUndefined()
  })

  it('keeps the provisional abort key mapped until the turn ends (abort works by either id)', async () => {
    const state = fakeState()
    state.setLastSessionId(undefined) // provisional key falls back to 'pending'
    const relay = createRelay({
      cardBus: createCardBus(),
      backend: fakeBackend(),
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm', sessionId: 'ses_web' })
    // While the turn is in flight BOTH keys map to the same controller — an
    // abort by the provisional id must not fall through during the race window.
    const ac = state.getActiveAbort('ses_web')
    expect(ac).toBeInstanceOf(AbortController)
    expect(state.getActiveAbort('pending')).toBe(ac)
    // turn end clears both keys — nothing lingers to wedge hasActiveGeneration()
    await relay.handleEvent({ kind: 'idle', sessionId: 'ses_web' })
    expect(state.setActiveAbort).toHaveBeenCalledWith('pending', undefined)
    expect(state.getActiveAbort('ses_web')).toBeUndefined()
    expect(state.getActiveAbort('pending')).toBeUndefined()
  })

  it('aborts the in-flight turn via the provisional key', async () => {
    const state = fakeState()
    state.setLastSessionId(undefined)
    const relay = createRelay({
      cardBus: createCardBus(),
      backend: fakeBackend(),
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm', sessionId: 'ses_web' })
    state.getActiveAbort('pending')!.abort()
    expect(state.getActiveAbort('ses_web')).toBeUndefined()
    expect(state.getActiveAbort('pending')).toBeUndefined()
  })

  it('normalizes the pinned fallback session id (short suffix pinned by Telegram)', async () => {
    const backend = fakeBackend()
    const state = fakeState()
    state.getPinnedSessionId = () => 'abcdef'
    state.normalizeSessionId = (id: string) => (id === 'abcdef' ? 'ses_full_abcdef' : id)
    const relay = createRelay({
      cardBus: createCardBus(),
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm' })
    expect(backend.prompt).toHaveBeenCalledWith('ses_full_abcdef', expect.objectContaining({ text: 'hi' }))
    // provisional key (the short pinned id) stays mapped during the turn…
    expect(state.getActiveAbort('abcdef')).toBe(state.getActiveAbort('ses_full_abcdef'))
    // …and is cleared when the turn ends
    await relay.handleEvent({ kind: 'idle', sessionId: 'ses_full_abcdef' })
    expect(state.setActiveAbort).toHaveBeenCalledWith('abcdef', undefined)
  })

  it('ends the turn with an error card when hasSession throws (no fallback reroute)', async () => {
    const backend = fakeBackend()
    backend.hasSession = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const cardBus = createCardBus()
    const cards: StructuredCard[] = []
    cardBus.subscribeAll((c) => cards.push(c))
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_test'
    const relay = createRelay({
      cardBus,
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm' })
    const errorCard = cards.find((c) => c.kind === 'error') as any
    expect(errorCard).toBeDefined()
    expect(errorCard.sessionId).toBe('ses_test')
    expect(errorCard.message).toMatch(/fetch failed/)
    // no fallback: never listed/picked another session, never submitted
    expect(backend.listSessions).not.toHaveBeenCalled()
    expect(backend.prompt).not.toHaveBeenCalled()
    // abort registry fully cleared
    expect(state.getActiveAbort('ses_test')).toBeUndefined()
  })

  it('falls back to the newest session only when hasSession says the target is gone', async () => {
    const backend = fakeBackend()
    backend.hasSession = vi.fn().mockResolvedValue(false)
    backend.listSessions = vi.fn().mockResolvedValue([{ id: 'ses_newest', createdAt: 2 }, { id: 'ses_older', createdAt: 1 }])
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_deleted'
    const relay = createRelay({
      cardBus: createCardBus(),
      backend,
      state,
      chatTimeoutMs: 5000,
      tuiVisible: false,    })
    await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm' })
    expect(backend.prompt).toHaveBeenCalledWith('ses_newest', expect.objectContaining({ text: 'hi' }))
    // provisional key 'ses_deleted' stays mapped to the turn's controller…
    expect(state.getActiveAbort('ses_deleted')).toBe(state.getActiveAbort('ses_newest'))
    // …and is cleared when the turn ends
    await relay.handleEvent({ kind: 'idle', sessionId: 'ses_newest' })
    expect(state.setActiveAbort).toHaveBeenCalledWith('ses_deleted', undefined)
    expect(state.getActiveAbort('ses_deleted')).toBeUndefined()
  })

  // ── Streaming + finalization via the plugin event hook ──

  describe('plugin event hook', () => {
    it('publishes thinking + user cards and returns without assistant card', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'plugin test', messageId: 'p1' })

      expect(cards.some(c => c.kind === 'thinking')).toBe(true)
      expect(cards.some(c => c.kind === 'user' && (c as any).text === 'plugin test')).toBe(true)
      expect(cards.some(c => c.kind === 'assistant')).toBe(false)
      expect(cards.some(c => c.kind === 'error')).toBe(false)
    })

    it('adopts an externally-initiated turn (no prior submit) and streams it', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state: fakeState(),
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      // No relay() submit — simulate a command/TUI-initiated turn arriving as events.
      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_external',
        part: { id: 'x1', type: 'text', text: 'from a command' },
      })
      const streaming = cards.filter((c) => c.kind === 'streaming') as any[]
      expect(streaming.length).toBeGreaterThan(0)
      expect(streaming[streaming.length - 1].sessionId).toBe('ses_external')
    })

    it('publishes streaming card via handleEvent for message.part.updated', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'test', messageId: 'p2' })

      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 't1', type: 'text', text: 'hello world' },
      })

      const streamingCards = cards.filter(c => c.kind === 'streaming')
      expect(streamingCards.length).toBeGreaterThan(0)
      const lastStream = streamingCards[streamingCards.length - 1] as any
      expect(lastStream.blocks.some((b: any) => b.type === 'text' && b.text === 'hello world')).toBe(true)
    })

    it('publishes assistant card when session.idle fires', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'test', messageId: 'p3' })

      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 't1', type: 'text', text: 'response text' },
      })

      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_plugin' })

      // publishAssistantCard is deferred via setTimeout(0); wait for it
      await new Promise((r) => setTimeout(r, 10))

      const assistantCard = cards.find(c => c.kind === 'assistant') as any
      expect(assistantCard).toBeDefined()
      expect(assistantCard.blocks.some((b: any) => b.type === 'text' && b.text === 'response text')).toBe(true)
    })

    it('carries live reasoning on streaming cards and thinkingText on the final card', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'test', messageId: 'p9' })

      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 'r1', type: 'reasoning', text: 'Let me think this through' },
      })
      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 't9', type: 'text', text: 'The answer' },
      })

      // Live: reasoning rides the streaming card in first-seen order… (the
      // second publish coalesces onto the 120ms trailing tick — wait it out)
      await new Promise((r) => setTimeout(r, 200))
      const lastStream = cards.filter(c => c.kind === 'streaming').at(-1) as any
      expect(lastStream.blocks.map((b: any) => b.type)).toEqual(['reasoning', 'text'])

      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_plugin' })
      await new Promise((r) => setTimeout(r, 10))

      // …final: reasoning leaves the blocks, lands in thinkingText.
      const assistantCard = cards.find(c => c.kind === 'assistant') as any
      expect(assistantCard.blocks.some((b: any) => b.type === 'reasoning')).toBe(false)
      expect(assistantCard.thinkingText).toBe('Let me think this through')
    })

    it('publishes error card when session.error fires', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'test', messageId: 'p4' })

      cards.length = 0

      await relay.handleEvent({ kind: 'error', sessionId: 'ses_plugin', message: 'something broke' })

      const errorCard = cards.find(c => c.kind === 'error') as any
      expect(errorCard).toBeDefined()
      expect(errorCard.message).toMatch(/something broke/)
    })

    it('handles message.part.delta accumulation', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'test', messageId: 'p5' })

      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 'd1', type: 'text', text: 'Hello' },
      })
      await relay.handleEvent({ kind: 'delta', sessionId: 'ses_plugin', partId: 'd1', text: ' world' })
      await relay.handleEvent({ kind: 'delta', sessionId: 'ses_plugin', partId: 'd1', text: '!' })
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_plugin' })
      await new Promise((r) => setTimeout(r, 10))

      const assistantCard = cards.find(c => c.kind === 'assistant') as any
      expect(assistantCard).toBeDefined()
      expect(assistantCard.blocks.some((b: any) => b.type === 'text' && b.text === 'Hello world!')).toBe(true)
    })

    it('forwards raw deltas as sdelta frames, skipping user-role parts', async () => {
      const cardBus = createCardBus()
      const deltas: any[] = []
      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,
        onStreamDelta: (f) => deltas.push(f),
      })
      await relay({ userId: '1', chatId: '100', text: 'test', messageId: 'p5' })
      await relay.handleEvent({ kind: 'role', sessionId: 'ses_plugin', messageId: 'u1', role: 'user' })
      await relay.handleEvent({ kind: 'part', sessionId: 'ses_plugin', part: { id: 'd1', type: 'text', text: 'Hel' } })
      await relay.handleEvent({ kind: 'delta', sessionId: 'ses_plugin', partId: 'd1', text: 'lo' })
      // A user part's delta must never reach the channel (relay drops user text).
      await relay.handleEvent({ kind: 'delta', sessionId: 'ses_plugin', messageId: 'u1', partId: 'u1p', text: 'echo' })
      expect(deltas).toEqual([
        { sessionId: 'ses_plugin', cardId: expect.any(String), partId: 'd1', text: 'lo' },
      ])
    })

    it('deduplicates tools by part.id on repeated tool updates', async () => {
      const cardBus = createCardBus()
      const cards: StructuredCard[] = []
      cardBus.subscribeAll((c) => cards.push(c))

      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_plugin'
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'x', messageId: 'p6' })

      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 't1', type: 'tool', tool: 'bash', args: 'ls', status: 'running' },
      })
      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_plugin',
        part: { id: 't1', type: 'tool', tool: 'bash', args: 'ls', status: 'done' },
      })
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_plugin' })
      await new Promise((r) => setTimeout(r, 10))

      const final = cards.find(c => c.kind === 'assistant') as any
      const bashBlocks = final.blocks.filter((b: any) => b.type === 'tool' && b.tool === 'bash')
      expect(bashBlocks.length).toBe(1)
      expect(bashBlocks[0].status).toBe('done')
    })

    it('registers an abort for an adopted (TUI) turn and clears it on idle', async () => {
      const state = fakeState()
      const relay = createRelay({
        cardBus: createCardBus(),
        backend: fakeBackend(),
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay.handleEvent({
        kind: 'part', sessionId: 'ses_tui',
        part: { id: 'x1', type: 'text', text: 'typed in the TUI' },
      })
      // adopted turns count as active generation too (per-session gating)
      expect(state.getActiveAbort('ses_tui')).toBeInstanceOf(AbortController)
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_tui' })
      expect(state.getActiveAbort('ses_tui')).toBeUndefined()
    })

    it('cleans up a leaked adopted turn when its real timeout fires', async () => {
      vi.useFakeTimers()
      try {
        const state = fakeState()
        const relay = createRelay({
          cardBus: createCardBus(),
          backend: fakeBackend(),
          state,
          chatTimeoutMs: 5000,
          tuiVisible: false,        })
        await relay.handleEvent({
          kind: 'part', sessionId: 'ses_tui',
          part: { id: 'x1', type: 'text', text: 'no idle ever arrives' },
        })
        expect(state.getActiveAbort('ses_tui')).toBeInstanceOf(AbortController)
        await vi.advanceTimersByTimeAsync(5000)
        expect(state.getActiveAbort('ses_tui')).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ── Per-session turn serialization ──

  describe('per-session turn serialization', () => {
    it('queues a second message for the same session until the first turn idles', async () => {
      const backend = fakeBackend()
      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_test'
      const relay = createRelay({
        cardBus: createCardBus(),
        backend,
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'first', messageId: 'm1' })
      expect(backend.prompt).toHaveBeenCalledTimes(1)

      // Second message while turn 1 is still streaming: must NOT submit yet
      // (an immediate submit would clobber turn 1's ctx/timer/abort).
      const p2 = relay({ userId: '1', chatId: '100', text: 'second', messageId: 'm2' })
      await new Promise((r) => setTimeout(r, 20))
      expect(backend.prompt).toHaveBeenCalledTimes(1)

      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_test' })
      await p2
      expect(backend.prompt).toHaveBeenCalledTimes(2)
      expect(backend.prompt).toHaveBeenLastCalledWith('ses_test', expect.objectContaining({ text: 'second' }))
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_test' })
    })

    it('runs messages for different sessions concurrently', async () => {
      const backend = fakeBackend()
      const state = fakeState()
      const relay = createRelay({
        cardBus: createCardBus(),
        backend,
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await Promise.all([
        relay({ userId: '1', chatId: '100', text: 'a', messageId: 'm1', sessionId: 'ses_a' }),
        relay({ userId: '1', chatId: '100', text: 'b', messageId: 'm2', sessionId: 'ses_b' }),
      ])
      expect(backend.prompt).toHaveBeenCalledTimes(2)
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_a' })
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_b' })
    })

    it('does not wedge the queue when a turn fails before installing a ctx', async () => {
      const backend = fakeBackend()
      backend.prompt = vi.fn()
        .mockRejectedValueOnce(new Error('no session found')) // non-network: no retry
        .mockResolvedValue(undefined)
      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_test'
      const relay = createRelay({
        cardBus: createCardBus(),
        backend,
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'boom', messageId: 'm1' })
      // the failed turn released the queue — the next message submits normally
      await relay({ userId: '1', chatId: '100', text: 'ok', messageId: 'm2' })
      expect(backend.prompt).toHaveBeenCalledTimes(2)
      expect(backend.prompt).toHaveBeenLastCalledWith('ses_test', expect.objectContaining({ text: 'ok' }))
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_test' })
    })
  })

  // ── Network-error classification ──

  describe('isNetworkError classification', () => {
    it('does not retry errors that merely mention "timeout"/"network" in the message', async () => {
      const backend = fakeBackend()
      backend.prompt = vi.fn().mockRejectedValue(new Error('model generation timeout exceeded'))
      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_test'
      const relay = createRelay({
        cardBus: createCardBus(),
        backend,
        state,
        chatTimeoutMs: 5000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm' })
      expect(backend.prompt).toHaveBeenCalledTimes(1)
    })

    it('retries when the error carries a network cause code (undici)', async () => {
      const backend = fakeBackend()
      let calls = 0
      backend.prompt = vi.fn().mockImplementation(async () => {
        calls++
        if (calls < 2) throw Object.assign(new Error('request failed'), { cause: { code: 'ECONNRESET' } })
      })
      const state = fakeState()
      state.getPinnedSessionId = () => 'ses_test'
      const relay = createRelay({
        cardBus: createCardBus(),
        backend,
        state,
        chatTimeoutMs: 120000,
        tuiVisible: false,      })
      await relay({ userId: '1', chatId: '100', text: 'hi', messageId: 'm' })
      expect(calls).toBe(2)
      await relay.handleEvent({ kind: 'idle', sessionId: 'ses_test' })
    })
  })

  describe('notice events', () => {
    it('publishes a notice as an info card', async () => {
      const cardBus = createCardBus()
      const cards: any[] = []
      cardBus.subscribeAll((c) => cards.push(c))
      const relay = createRelay({
        cardBus,
        backend: fakeBackend(),
        state: fakeState(),
        chatTimeoutMs: 5000,
        tuiVisible: false,
      })
      await relay.handleEvent({ kind: 'notice', sessionId: 'ses_a', title: 'Session continued outside OCRC', body: 'reopen to resync' })
      expect(cards).toContainEqual(expect.objectContaining({
        kind: 'info',
        sessionId: 'ses_a',
        title: 'Session continued outside OCRC',
        sections: [{ body: 'reopen to resync' }],
      }))
    })
  })
})

describe('createRelay > streaming broadcast throttle', () => {
  it('coalesces rapid deltas: 50 deltas publish far fewer streaming cards', async () => {
    const cardBus = createCardBus()
    const cards: StructuredCard[] = []
    cardBus.subscribeAll((c) => cards.push(c))
    const state = fakeState()
    state.getPinnedSessionId = () => 'ses_plugin'
    const relay = createRelay({ cardBus, backend: fakeBackend(), state, chatTimeoutMs: 30_000, tuiVisible: false })
    await relay({ userId: '1', chatId: '100', text: 'go', messageId: 'pt1' })
    cards.length = 0

    // 50 rapid deltas within ~200ms — unthrottled would publish 50 cards.
    for (let i = 0; i < 50; i++) {
      await relay.handleEvent({
        kind: 'delta', sessionId: 'ses_plugin',
        partId: 'd1', messageId: 'msg_d', text: `chunk ${i} `,
      })
      await new Promise((r) => setTimeout(r, 4))
    }
    const streamingCount = cards.filter((c) => c.kind === 'streaming').length
    expect(streamingCount).toBeLessThan(15)
    // the trailing tick lands the latest content
    await new Promise((r) => setTimeout(r, 300))
    const last = cards.filter((c) => c.kind === 'streaming').at(-1) as any
    expect(last.blocks.some((b: any) => b.text?.includes('chunk 49'))).toBe(true)
  })
})
