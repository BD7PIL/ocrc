import { describe, it, expect, vi } from 'vitest'
import { createAcpBackend, type AcpClient, type AcpConnection } from '../../../src/core/agent/acp-backend'
import type { AgentEvent } from '../../../src/core/agent/event'

/** A fake ACP connection that captures our client so tests can drive updates. */
function makeHarness(opts: { promptResult?: Promise<{ stopReason: string }> } = {}) {
  let client!: AcpClient
  const promptCalls: Array<{ sessionId: string; text: string }> = []
  const cancelCalls: string[] = []
  const conn: AcpConnection = {
    newSession: vi.fn(async () => ({ sessionId: 'ses_new' })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    deleteSession: vi.fn(async () => ({})),
    authenticate: vi.fn(async () => ({})),
    prompt: vi.fn(async (p: { sessionId: string; prompt: Array<{ text: string }> }) => {
      promptCalls.push({ sessionId: p.sessionId, text: p.prompt[0].text })
      return opts.promptResult ? await opts.promptResult : { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async (p: { sessionId: string }) => { cancelCalls.push(p.sessionId); return {} }),
  }
  const connect = async (c: AcpClient) => { client = c; return { conn, authMethodId: 'login' } }
  return { connect, conn, promptCalls, cancelCalls, getClient: () => client }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createAcpBackend', () => {
  it('reports ACP capabilities (no live mirror / tui select)', () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    expect(b.id).toBe('acp:kimi')
    expect(b.capabilities).toEqual({ liveMirror: false, tuiSelect: false, workspaces: true, freeformWorkspace: true, diff: true, todos: true, catalog: false, mcp: true, commands: true, sessionControls: true, imageInput: true })
  })

  it('getMcp surfaces the agent-configured MCP servers via discoverMcp', async () => {
    const b = createAcpBackend({
      id: 'acp:kimi', cwd: '/tmp', connect: makeHarness().connect,
      discoverMcp: () => [{ name: 'pact', type: 'stdio', status: 'configured' }],
    })
    expect(b.capabilities.mcp).toBe(true)
    expect(await b.getMcp()).toEqual([{ name: 'pact', type: 'stdio', status: 'configured' }])
  })

  it('sends image blocks alongside text (imageInput)', async () => {
    let captured: unknown
    const conn: AcpConnection = {
      newSession: vi.fn(async () => ({ sessionId: 'ses_i' })),
      authenticate: vi.fn(async () => ({})),
      prompt: vi.fn(async (p: { prompt: unknown }) => { captured = p.prompt; return { stopReason: 'end_turn' } }),
      cancel: vi.fn(async () => ({})),
    }
    const connect = async (_c: AcpClient) => ({ conn, authMethodId: 'login' })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })
    await b.prompt('ses_i', { text: 'look', images: [{ data: 'BASE64', mimeType: 'image/png' }] })
    await flush()
    expect(captured).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'BASE64', mimeType: 'image/png' },
    ])
  })

  it('captures + switches session controls (mode + model)', async () => {
    const setMode = vi.fn(async () => ({}))
    const setOpt = vi.fn(async () => ({}))
    let client!: AcpClient
    const conn: AcpConnection = {
      newSession: vi.fn(async () => ({
        sessionId: 'ses_c',
        modes: { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'code', name: 'Code' }] },
        configOptions: [{
          id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'k2',
          options: [{ value: 'k2', name: 'Kimi K2' }, { value: 'k2-turbo', name: 'Kimi K2 Turbo' }],
        }],
      })),
      authenticate: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => ({})),
      setSessionMode: setMode,
      setSessionConfigOption: setOpt,
    }
    const connect = async (c: AcpClient) => { client = c; return { conn, authMethodId: 'login' } }
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })

    await b.createSession({ directory: '/work' })
    expect(await b.getControls!('ses_c')).toEqual({
      mode: { current: 'plan', options: [{ id: 'plan', name: 'Plan' }, { id: 'code', name: 'Code' }] },
      model: { current: 'k2', options: [{ id: 'k2', name: 'Kimi K2' }, { id: 'k2-turbo', name: 'Kimi K2 Turbo' }] },
    })

    // agent-initiated updates are reflected
    await client.sessionUpdate({ sessionId: 'ses_c', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } })
    expect((await b.getControls!('ses_c')).mode?.current).toBe('code')
    await client.sessionUpdate({ sessionId: 'ses_c', update: { sessionUpdate: 'config_option_update', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'k2-turbo', options: [{ value: 'k2-turbo', name: 'Kimi K2 Turbo' }] },
    ] } })
    expect((await b.getControls!('ses_c')).model?.current).toBe('k2-turbo')

    // setters call the connection with the right args (+ optimistic current)
    await b.setMode!('ses_c', 'plan')
    expect(setMode).toHaveBeenCalledWith({ sessionId: 'ses_c', modeId: 'plan' })
    expect((await b.getControls!('ses_c')).mode?.current).toBe('plan')
    await b.setModel!('ses_c', 'k2')
    expect(setOpt).toHaveBeenCalledWith({ sessionId: 'ses_c', configId: 'model', value: 'k2' })
    expect((await b.getControls!('ses_c')).model?.current).toBe('k2')
  })

  it('getHistory replays a native (unstreamed) session via session/load → cards', async () => {
    let client!: AcpClient
    const events: AgentEvent[] = []
    const conn: AcpConnection = {
      newSession: vi.fn(async () => ({ sessionId: 'ses_n' })),
      loadSession: vi.fn(async (p: { sessionId: string }) => {
        // kimi replays the session's history as session/update during load
        await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi there' } } })
        await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello back' } } })
        return { configOptions: [] }
      }),
      authenticate: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => ({})),
    }
    const connect = async (c: AcpClient) => { client = c; return { conn, authMethodId: 'login' } }
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })
    b.onEvent!((e) => events.push(e))

    const cards = await b.getHistory('ses_native')
    expect(conn.loadSession).toHaveBeenCalledWith({ sessionId: 'ses_native', cwd: '/tmp', mcpServers: [] })
    expect(cards.map((c) => c.kind)).toEqual(['user', 'assistant'])
    expect((cards[0] as { text: string }).text).toBe('hi there')
    expect((cards[1] as { blocks: unknown }).blocks).toEqual([{ type: 'text', text: 'hello back' }])
    // the replayed updates must NOT have leaked out as live streaming events
    expect(events).toEqual([])
  })

  it('serializes concurrent getHistory replays for the same session (one load, no leak)', async () => {
    let client!: AcpClient
    const events: AgentEvent[] = []
    let resolveGate!: () => void
    const gate = new Promise<void>((r) => { resolveGate = r })
    let loadCalls = 0
    const conn: AcpConnection = {
      newSession: vi.fn(async () => ({ sessionId: 'ses_n' })),
      loadSession: vi.fn(async (p: { sessionId: string }) => {
        loadCalls++
        await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi there' } } })
        await gate // hold the first load open while the second getHistory arrives
        await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello back' } } })
        return {}
      }),
      authenticate: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => ({})),
    }
    const connect = async (c: AcpClient) => { client = c; return { conn, authMethodId: 'login' } }
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })
    b.onEvent!((e) => events.push(e))

    const h1 = b.getHistory('ses_native')
    await flush() // first load is in-flight, replay buffer installed
    const h2 = b.getHistory('ses_native') // concurrent — must share, not start a 2nd load
    await flush()
    expect(loadCalls).toBe(1) // old bug: 2 (buffer overwritten, then deleted mid-replay)
    resolveGate()
    const [c1, c2] = await Promise.all([h1, h2])
    expect(loadCalls).toBe(1)
    // both callers get the same complete history
    expect(c1.map((c) => c.kind)).toEqual(['user', 'assistant'])
    expect(c2).toEqual(c1)
    // nothing replayed leaked out as live events
    expect(events).toEqual([])
  })

  it('buffers live updates that arrive mid-load instead of emitting them (they join the cards)', async () => {
    let client!: AcpClient
    const events: AgentEvent[] = []
    let resolveGate!: () => void
    const gate = new Promise<void>((r) => { resolveGate = r })
    const conn: AcpConnection = {
      newSession: vi.fn(async () => ({ sessionId: 'ses_n' })),
      loadSession: vi.fn(async (p: { sessionId: string }) => {
        await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } } })
        await gate // hold the load open: replay buffer stays installed
        return {}
      }),
      authenticate: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => ({})),
    }
    const connect = async (c: AcpClient) => { client = c; return { conn, authMethodId: 'login' } }
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })
    b.onEvent!((e) => events.push(e))

    const historyP = b.getHistory('ses_native')
    await flush() // load started; replay buffer is installed (loadSession gated)
    // an update arriving mid-load is appended to the replay buffer, not emitted live
    await client.sessionUpdate({ sessionId: 'ses_native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late live chunk' } } })
    expect(events).toEqual([])
    resolveGate()
    const cards = await historyP
    expect(events).toEqual([]) // never emitted as a live event
    expect(cards.map((c) => c.kind)).toEqual(['user', 'assistant']) // joined the rebuilt cards
  })

  it('createSession returns the agent sessionId and tracks it', async () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    const { id } = await b.createSession({ directory: '/work' })
    expect(id).toBe('ses_new')
    expect(h.conn.newSession).toHaveBeenCalledWith({ cwd: '/work', mcpServers: [] })
    expect(await b.hasSession('ses_new')).toBe(true)
  })

  it('streams normalized events from session updates via onEvent', async () => {
    // prompt stays pending so only streaming events are observed (no idle yet)
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    const events: AgentEvent[] = []
    b.onEvent!((e) => events.push(e))
    await b.prompt('ses_a', { text: 'hi' })
    // drive an agent message chunk through our client (as the connection would)
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } })
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } })
    expect(events).toEqual([
      { kind: 'part', sessionId: 'ses_a', part: { id: 'ses_a:text:0', type: 'text', text: 'Hello' } },
      { kind: 'delta', sessionId: 'ses_a', partId: 'ses_a:text:0', text: ' world' },
    ])
  })

  it('emits idle when the prompt turn completes', async () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    const events: AgentEvent[] = []
    b.onEvent!((e) => events.push(e))
    await b.prompt('ses_a', { text: 'hi' })
    await flush() // let the backgrounded prompt() promise settle
    expect(h.promptCalls).toEqual([{ sessionId: 'ses_a', text: 'hi' }])
    expect(events).toContainEqual({ kind: 'idle', sessionId: 'ses_a' })
  })

  it('emits error when the prompt turn rejects', async () => {
    const h = makeHarness({ promptResult: Promise.reject(new Error('boom')) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    const events: AgentEvent[] = []
    b.onEvent!((e) => events.push(e))
    await b.prompt('ses_a', { text: 'hi' })
    await flush()
    expect(events).toContainEqual({ kind: 'error', sessionId: 'ses_a', message: 'boom' })
  })

  it('resets per-turn part ids across turns (idle bumps the turn)', async () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    const events: AgentEvent[] = []
    b.onEvent!((e) => events.push(e))
    await b.prompt('ses_a', { text: 'turn1' })
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'a' } } })
    await flush() // idle fires → normalizer.reset
    await b.prompt('ses_a', { text: 'turn2' })
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'b' } } })
    const parts = events.filter((e) => e.kind === 'part') as Extract<AgentEvent, { kind: 'part' }>[]
    expect(parts.map((p) => p.part.id)).toEqual(['ses_a:text:0', 'ses_a:text:1'])
  })

  it('abort cancels the session', async () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.createSession({ directory: '/tmp' })
    await b.abort('ses_new')
    expect(h.cancelCalls).toEqual(['ses_new'])
  })

  it('bridges a permission request to onPermission and maps the decision to an optionId', async () => {
    const h = makeHarness()
    const onPermission = vi.fn(async () => 'approve_for_session')
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect, onPermission })
    await b.prompt('ses_a', { text: 'run it' })
    const outcome = await h.getClient().requestPermission({
      sessionId: 'ses_a',
      toolCall: { toolCallId: 'tc_1', title: 'Shell: echo hi' },
      options: [
        { optionId: 'approve', kind: 'allow_once' },
        { optionId: 'approve_for_session', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    })
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_a', requestId: 'tc_1' }))
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_for_session' } })
  })

  it('resolvePermission maps an OCRC decision → ACP optionId by kind', async () => {
    const h = makeHarness()
    // onPermission never resolves on its own — host drives it via resolvePermission
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect, onPermission: () => new Promise<string | null>(() => {}) })
    const permP = h.getClient!() // ensure connected
    await b.prompt('ses_a', { text: 'run it' })
    const outcomeP = h.getClient().requestPermission({
      sessionId: 'ses_a',
      toolCall: { toolCallId: 'tc_9', title: 'Shell' },
      options: [
        { optionId: 'approve', kind: 'allow_once' },
        { optionId: 'approve_for_session', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    })
    await flush()
    await b.resolvePermission('ses_a', 'tc_9', 'always')
    expect(await outcomeP).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_for_session' } })
    void permP
  })

  it('rejects by default when no onPermission bridge is provided', async () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.prompt('ses_a', { text: 'x' })
    const outcome = await h.getClient().requestPermission({
      sessionId: 'ses_a',
      toolCall: { toolCallId: 'tc_1', title: 'Shell' },
      options: [{ optionId: 'approve', kind: 'allow_once' }],
    })
    expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('captures available_commands_update into listCommands', async () => {
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.prompt('ses_a', { text: 'hi' }) // forces connection so the client exists
    expect(await b.listCommands()).toEqual([])
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the context' }, { name: 'clear' }] } })
    expect(await b.listCommands()).toEqual([
      { name: 'compact', description: 'Compact the context' },
      { name: 'clear', description: '' },
    ])
  })

  it('captures ACP plan updates into getTodos (full replace per update)', async () => {
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.prompt('ses_a', { text: 'hi' })
    expect(await b.getTodos('ses_a')).toEqual([])
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'plan', entries: [
      { content: 'Read the file', status: 'completed' },
      { content: 'Edit it', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ] } })
    expect(await b.getTodos('ses_a')).toEqual([
      { content: 'Read the file', status: 'completed' },
      { content: 'Edit it', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ])
    // plan replaces wholesale
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'plan', entries: [{ content: 'Done', status: 'completed' }] } })
    expect(await b.getTodos('ses_a')).toEqual([{ content: 'Done', status: 'completed' }])
  })

  it('captures kimi-code 0.18 todo tool_call (rawInput.todos) into getTodos', async () => {
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.prompt('ses_a', { text: 'hi' })
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_todo', title: 'Updating todo list', rawInput: { todos: [
      { title: 'Read', status: 'done' },
      { title: 'Edit', status: 'in_progress' },
      { title: 'Test', status: 'pending' },
    ] } } })
    expect(await b.getTodos('ses_a')).toEqual([
      { content: 'Read', status: 'done' },
      { content: 'Edit', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ])
  })

  it('accumulates tool_call diff content into getDiff (deduped by path)', async () => {
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.prompt('ses_a', { text: 'hi' })
    expect(await b.getDiff('ses_a')).toEqual([])
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', title: 'Edit', content: [
      { type: 'diff', path: '/work/a.ts', oldText: 'x', newText: 'y' },
    ] } })
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_2', title: 'Write', content: [
      { type: 'diff', path: '/work/b.ts', oldText: '', newText: 'new' },
    ] } })
    // re-editing the same path dedupes (keyed by path)
    await h.getClient().sessionUpdate({ sessionId: 'ses_a', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_1', title: 'Edit', content: [
      { type: 'diff', path: '/work/a.ts', oldText: 'y', newText: 'z' },
    ] } })
    const d = await b.getDiff('ses_a')
    expect(d.map((e) => e.path)).toEqual(['/work/a.ts', '/work/b.ts'])
    expect(d.find((e) => e.path === '/work/a.ts')).toMatchObject({ additions: 1, deletions: 1 })
    expect(d.find((e) => e.path === '/work/b.ts')).toMatchObject({ additions: 1, deletions: 0, lines: [{ kind: 'add', text: 'new' }] })
  })

  it('runCommand submits the slash-command as a prompt turn', async () => {
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    await b.runCommand('ses_a', 'compact', 'keep db')
    expect(h.promptCalls).toContainEqual({ sessionId: 'ses_a', text: '/compact keep db' })
  })

  it('without a store, listSessionSummaries reflects in-memory sessions', async () => {
    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
    expect(await b.listSessionSummaries()).toEqual([])
    await b.createSession({ directory: '/tmp' }) // ses_new
    expect(await b.listSessionSummaries()).toEqual([{ id: 'ses_new', title: '', lastActiveAt: 0, unread: false, directory: '/tmp' }])
  })

  it('with a store, sessions + history persist (survive a fresh backend / restart)', async () => {
    const { createAcpStore } = await import('../../../src/core/agent/acp-store')
    const path = `/tmp/acp-store-test-${Math.floor(performance.now())}.json`
    const store = createAcpStore(path)

    const h = makeHarness()
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect, store })
    const { id } = await b.createSession({ directory: '/tmp', title: 'Chat' })
    // record a couple of finalized cards (the host does this from the cardBus)
    store.recordCard(id, { kind: 'user', sessionId: id, id: 'u1', text: 'hi', ts: 1 } as any, 100)
    store.recordCard(id, { kind: 'assistant', sessionId: id, id: 'a1', blocks: [{ type: 'text', text: 'hello' }] } as any, 200)
    await store.flush()

    // a FRESH backend (simulating a host restart) sees the session + history
    const h2 = makeHarness()
    const b2 = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h2.connect, store: createAcpStore(path) })
    expect((await b2.listSessionSummaries()).map((s) => ({ id: s.id, title: s.title }))).toEqual([{ id, title: 'Chat' }])
    expect(await b2.hasSession(id)).toBe(true)
    const hist = await b2.getHistory(id)
    expect(hist.map((c: any) => c.kind)).toEqual(['user', 'assistant'])
  })

  it('surfaces kimi-native sessions (e.g. TUI-created) via session/list', async () => {
    const h = makeHarness()
    ;(h.conn as any).listSessions = vi.fn(async (p: { cwd?: string }) =>
      p?.cwd === '/work/proj'
        ? { sessions: [{ sessionId: 'ses_tui', title: 'TUI chat', cwd: '/work/proj', updatedAt: '2026-06-20T10:00:00Z' }] }
        : { sessions: [] })
    const { createAcpStore } = await import('../../../src/core/agent/acp-store')
    const store = createAcpStore(`/tmp/acp-native-${Math.floor(performance.now())}.json`)
    store.create('ses_own', 'Mine', '/work/proj')
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/home/me', connect: h.connect, store })
    const ids = (await b.listSessionSummaries()).map((s) => s.id).sort()
    expect(ids).toContain('ses_tui')   // discovered from session/list in /work/proj
    expect(ids).toContain('ses_own')   // from the OCRC store
    // native session is openable: hasSession true + its cwd resolved for resume
    expect(await b.hasSession('ses_tui')).toBe(true)
    expect((await b.getContext('ses_tui')).directory).toBe('/work/proj')
  })

  it('tombstones deleted sessions so session/list re-discovery cannot resurrect them', async () => {
    const h = makeHarness()
    ;(h.conn as any).listSessions = vi.fn(async (p: { cwd?: string }) =>
      p?.cwd === '/work'
        ? { sessions: [{ sessionId: 'ses_x', title: 'X', cwd: '/work', updatedAt: '2026-06-20T00:00:00Z' }] }
        : { sessions: [] })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/c', connect: h.connect, discoverDirs: () => ['/work'] })
    expect((await b.listSessionSummaries()).map((s) => s.id)).toContain('ses_x')
    await b.deleteSession('ses_x') // kimi keeps it (no session/delete); OCRC tombstones it
    expect((await b.listSessionSummaries()).map((s) => s.id)).not.toContain('ses_x')
  })

  it('discoverDirs surfaces native sessions in dirs OCRC never used (TUI anywhere)', async () => {
    const h = makeHarness()
    ;(h.conn as any).listSessions = vi.fn(async (p: { cwd?: string }) =>
      p?.cwd === '/home/me/secret'
        ? { sessions: [{ sessionId: 'ses_far', title: 'Far', cwd: '/home/me/secret', updatedAt: '2026-06-20T09:00:00Z' }] }
        : { sessions: [] })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/home/me', connect: h.connect, discoverDirs: () => ['/home/me/secret'] })
    const ids = (await b.listSessionSummaries()).map((s) => s.id)
    expect(ids).toContain('ses_far')
    expect((await b.getContext('ses_far')).directory).toBe('/home/me/secret')
  })

  it('persists per-session directory; listWorkspaces derives dirs (+ cwd default)', async () => {
    const { createAcpStore } = await import('../../../src/core/agent/acp-store')
    const store = createAcpStore(`/tmp/acp-dir-${Math.floor(performance.now())}.json`)
    const h = makeHarness()
    let n = 0
    ;(h.conn as any).newSession = vi.fn(async (p: { cwd: string }) => ({ sessionId: `ses_${p.cwd.split('/').pop()}_${n++}` }))
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/home/me/default', connect: h.connect, store })

    // no sessions yet → workspaces is just the cwd default
    expect((await b.listWorkspaces()).map((w) => w.directory)).toEqual(['/home/me/default'])

    await b.createSession({ directory: '/work/proj-a' })
    await b.createSession({ directory: '/work/proj-a' }) // same dir, 2 sessions
    await b.createSession({ directory: '/work/proj-b' })
    const ws = await b.listWorkspaces()
    expect(ws.find((w) => w.directory === '/work/proj-a')?.sessionCount).toBe(2)
    expect(ws.find((w) => w.directory === '/work/proj-b')?.name).toBe('proj-b')
    // getContext returns the session's own directory
    expect((await b.getContext('ses_proj-a_0')).directory).toBe('/work/proj-a')
  })

  it('resumes a persisted session before prompting it (host restart continuity)', async () => {
    const { createAcpStore } = await import('../../../src/core/agent/acp-store')
    const store = createAcpStore(`/tmp/acp-resume-${Math.floor(performance.now())}.json`)
    store.create('ses_old', 'Old chat')
    const resumed: string[] = []
    const h = makeHarness({ promptResult: new Promise(() => {}) })
    ;(h.conn as any).resumeSession = vi.fn(async (p: { sessionId: string }) => { resumed.push(p.sessionId); return {} })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect, store })
    await b.prompt('ses_old', { text: 'continue' })
    expect(resumed).toEqual(['ses_old']) // resumeSession called before the prompt
    expect(h.promptCalls).toContainEqual({ sessionId: 'ses_old', text: 'continue' })
  })

  it('drops a rejected connection promise so the next call reconnects', async () => {
    const h = makeHarness()
    let calls = 0
    const connect = vi.fn(async (c: AcpClient) => {
      calls++
      if (calls === 1) throw new Error('spawn failed')
      return h.connect(c)
    })
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })
    await expect(b.createSession({ directory: '/w' })).rejects.toThrow(/spawn failed/)
    // second attempt must retry the factory, not reuse the rejected promise
    const s = await b.createSession({ directory: '/w' })
    expect(s.id).toBe('ses_new')
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('drops the cached connection when the agent process disconnects', async () => {
    const h = makeHarness()
    let disconnect: (() => void) | undefined
    const connect = vi.fn(async (c: AcpClient) => ({
      ...(await h.connect(c)),
      onDisconnect: (cb: () => void) => { disconnect = cb },
    }))
    const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect })
    expect(await b.ping()).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
    // cached: no reconnect while alive
    expect(await b.ping()).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
    // agent died → next call reconnects
    disconnect!()
    expect(await b.ping()).toBe(true)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  describe('session takeover recovery', () => {
    function makeLoadableHarness() {
      let client!: AcpClient
      const loadSession = vi.fn(async () => ({}))
      const conn: AcpConnection = {
        newSession: vi.fn(async () => ({ sessionId: 'ses_s' })),
        authenticate: vi.fn(async () => ({})),
        prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
        cancel: vi.fn(async () => ({})),
        loadSession,
      }
      const connect = async (c: AcpClient) => { client = c; return { conn, authMethodId: 'login' } }
      return { connect, loadSession, getClient: () => client }
    }

    it('re-subscribes and notifies when the turn settles abruptly after an externally-failed tool call', async () => {
      vi.useFakeTimers()
      try {
        const h = makeLoadableHarness()
        const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
        const events: AgentEvent[] = []
        b.onEvent!((e) => events.push(e))
        await b.prompt('ses_s', { text: 'hi' })
        // externally killed tool (takeover signature), then the turn settles at once
        await h.getClient().sessionUpdate({
          sessionId: 'ses_s',
          update: {
            sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'AgentSwarm', status: 'failed',
            content: [{ type: 'content', content: { type: 'text', text: 'Tool execution was interrupted' } }],
          },
        })
        await vi.advanceTimersByTimeAsync(10) // let the prompt settle
        expect(events).toContainEqual({ kind: 'idle', sessionId: 'ses_s' })
        // ensureSession already loaded once at prompt start; the takeover resync loads again
        await vi.advanceTimersByTimeAsync(3100)
        expect(h.loadSession).toHaveBeenCalledTimes(2)
        expect(events.some((e) => e.kind === 'notice' && e.sessionId === 'ses_s')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not resync after a normal turn end (no recent failed tool)', async () => {
      vi.useFakeTimers()
      try {
        const h = makeLoadableHarness()
        const b = createAcpBackend({ id: 'acp:kimi', cwd: '/tmp', connect: h.connect })
        const events: AgentEvent[] = []
        b.onEvent!((e) => events.push(e))
        await b.prompt('ses_s', { text: 'hi' })
        await vi.advanceTimersByTimeAsync(10)
        expect(events).toContainEqual({ kind: 'idle', sessionId: 'ses_s' })
        await vi.advanceTimersByTimeAsync(3100)
        expect(h.loadSession).toHaveBeenCalledTimes(1) // ensureSession only
        expect(events.some((e) => e.kind === 'notice')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
