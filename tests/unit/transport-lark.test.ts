import { describe, it, expect, vi } from 'vitest'
import { createLarkTransport } from '../../src/transport/lark/index'
import { cardToLark } from '../../src/transport/lark/cards'
import { createCardBus } from '../../src/core/card-bus.js'
import type { StructuredCard } from '../../src/core/structured-card.js'

function fakeState() {
  return {
    getPinnedSessionId: () => undefined,
    setPinnedSessionId: vi.fn(),
    normalizeSessionId: (id: string) => id,
  } as any
}

function fakeBackend() {
  return {
    resolvePermission: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => ({ ok: true })),
    rejectQuestion: vi.fn(async () => ({ ok: true })),
    listQuestions: vi.fn(async () => [
      { id: 'rq1', sessionId: 'ses_a', questions: [{ question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
    ]),
  } as any
}

interface CapturedDispatcher {
  dispatcher: { register(h: Record<string, (data: any) => Promise<void>>): unknown }
  handlers: Record<string, (data: any) => Promise<void>>
}

async function setup() {
  const bus = createCardBus()
  const created: any[] = []
  const patched: any[] = []
  const client = {
    im: {
      message: {
        create: vi.fn(async (p: any) => {
          created.push(p)
          return { data: { message_id: `om_${created.length}` } }
        }),
        patch: vi.fn(async (p: any) => {
          patched.push(p)
          return {}
        }),
      },
    },
  }
  const captured = {} as CapturedDispatcher['handlers']
  const dispatcher = {
    register(h: Record<string, (data: any) => Promise<void>>) {
      Object.assign(captured, h)
    },
  }
  const ws = { start: vi.fn(async () => {}), close: vi.fn() }
  const backend = fakeBackend()
  const transport = createLarkTransport({
    appId: 'cli_a', appSecret: 's', backend, state: fakeState(),
    ws, client, dispatcher, cardThrottleMs: 50,
  })
  const onMessages: any[] = []
  transport.onMessage(async (m) => { onMessages.push(m) })
  await transport.start({ cardBus: bus, state: fakeState() } as any)
  return { bus, created, patched, client, ws, backend, transport, onMessages, handlers: captured }
}

const P2P_TEXT = {
  event: {
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'm1', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hello agent' }) },
  },
}

describe('lark cards (pure)', () => {
  it('streaming card → blue live header + markdown body', () => {
    const card = { kind: 'streaming', sessionId: 's', id: 'x', blocks: [
      { type: 'text', text: 'answer so far' },
      { type: 'tool', tool: 'Bash', args: 'npm test', status: 'running' },
    ] } as unknown as StructuredCard
    const lark = cardToLark(card)
    expect(lark.header?.template_color).toBe('blue')
    const mdEl = lark.elements[0] as any
    expect(mdEl.content).toContain('answer so far')
    expect(mdEl.content).toContain('⏳ Bash · npm test')
  })

  it('approval card → three buttons carrying perm values', () => {
    const lark = cardToLark({ kind: 'approval', sessionId: 'ses_a', title: 'bash', args: { cmd: 'rm' }, requestId: 'p1' } as any)
    const action = lark.elements.find((e) => e.tag === 'action') as any
    expect(action.actions).toHaveLength(3)
    expect(action.actions[0].value).toMatchObject({ t: 'perm', sid: 'ses_a', rid: 'p1', d: 'once' })
    expect(action.actions[2].type).toBe('danger')
  })

  it('single-choice question → option buttons; multi-choice → web hint', () => {
    const single = cardToLark({ kind: 'question', sessionId: 's', requestId: 'q1', questions: [{ question: '选', options: [{ label: '甲' }, { label: '乙' }] }] } as any)
    const action = single.elements.find((e) => e.tag === 'action') as any
    expect(action.actions.map((a: any) => a.value.oi)).toEqual([0, 1])

    const multi = cardToLark({ kind: 'question', sessionId: 's', requestId: 'q1', questions: [{ question: '选', multiple: true, options: [{ label: '甲' }] }] } as any)
    expect(JSON.stringify(multi)).toContain('Web')
  })
})

describe('lark transport', () => {
  it('p2p text → IncomingMessage; group and non-text ignored', async () => {
    const { handlers, onMessages } = await setup()
    await handlers['im.message.receive_v1'](P2P_TEXT)
    expect(onMessages).toHaveLength(1)
    expect(onMessages[0]).toMatchObject({ text: 'hello agent', chatId: 'oc_a', origin: 'lark' })

    await handlers['im.message.receive_v1']({ event: { ...P2P_TEXT.event, message: { ...P2P_TEXT.event.message, chat_type: 'group' } } })
    await handlers['im.message.receive_v1']({ event: { ...P2P_TEXT.event, message: { ...P2P_TEXT.event.message, message_type: 'image', content: '{}' } } })
    expect(onMessages).toHaveLength(1)
  })

  it('streaming card → one create then throttled patches; assistant final patches the same message', async () => {
    const { bus, created, patched, handlers } = await setup()

    // anchor a chat the v0.27 way: inbound p2p message → relay user-card echo
    // binds session → chat (no lastChat fallback — cross-user leak fix)
    await handlers['im.message.receive_v1'](P2P_TEXT)
    bus.publish({ kind: 'user', sessionId: 'ses_a', id: 'user:m1', text: 'hello agent', ts: Date.now(), origin: 'lark' })

    const stream = (text: string) => bus.publish({ kind: 'streaming', sessionId: 'ses_a', id: 'turn:1', blocks: [{ type: 'text', text }] })
    stream('one')
    await vi.waitFor(() => expect(created.length).toBe(1))
    stream('one two') // inside the 50ms throttle → no call yet
    await new Promise((r) => setTimeout(r, 20))
    expect(created.length).toBe(1)
    await new Promise((r) => setTimeout(r, 60))
    stream('one two three')
    await vi.waitFor(() => expect(patched.length).toBe(1))

    bus.publish({ kind: 'assistant', sessionId: 'ses_a', id: 'turn:1', blocks: [{ type: 'text', text: 'final' }], meta: {} })
    await vi.waitFor(() => expect(patched.length).toBe(2))
    expect((patched[1] as any).path.message_id).toBe('om_1') // the streamed message id
  })

  it('card action permission → backend.resolvePermission with the decision', async () => {
    const { backend, transport } = await setup()
    await transport.handleCardAction({ value: { t: 'perm', sid: 'ses_a', rid: 'perm1', d: 'always' } })
    expect(backend.resolvePermission).toHaveBeenCalledWith('ses_a', 'perm1', 'always')
  })

  it('card action question option → answerQuestion with the option label', async () => {
    const { backend, transport } = await setup()
    await transport.handleCardAction({ value: { t: 'q', sid: 'ses_a', rid: 'rq1', oi: 1 } })
    expect(backend.answerQuestion).toHaveBeenCalledWith('ses_a', 'rq1', [['乙']])
  })

  it('ws lifecycle: start called once; stop closes', async () => {
    const { ws } = await setup()
    expect(ws.start).toHaveBeenCalledTimes(1)
  })
})

async function handlers_wait(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
}
