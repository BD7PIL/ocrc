import { describe, it, expect, vi } from 'vitest'
import { createDingTalkTransport } from '../../src/transport/dingtalk/index'
import { createCardBus } from '../../src/core/card-bus'

function fakeState() {
  return { getPinnedSessionId: () => undefined, normalizeSessionId: (x: string) => x } as any
}

async function setup() {
  const bus = createCardBus()
  const sent: any[] = []
  const listeners: Record<string, (data: any) => Promise<any>> = {}
  const stream = {
    registerCallbackListener(topic: string, cb: (data: any) => Promise<any>) { listeners[topic] = cb },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
  }
  const rest = {
    getAccessToken: vi.fn(async () => 'token-1'),
    oToMessages: vi.fn(async (_token: string, body: any) => { sent.push(body) }),
  }
  const transport = createDingTalkTransport({
    clientId: 'app-key', clientSecret: 'sec', stream, rest,
  })
  const onMessages: any[] = []
  transport.onMessage(async (m) => { onMessages.push(m) })
  await await_start(transport, bus)
  return { bus, sent, listeners, rest, transport, onMessages }
}

// registerCallbackListener is sync inside an async start — give the
// (non-awaitable) connect a tick, then publish.
function await_start(t: any, bus: any) {
  return Promise.resolve(t.start({ cardBus: bus, state: fakeState() } as any))
}

describe('dingtalk transport (v1 — Stream Mode, markdown replies)', () => {
  it('robot message → IncomingMessage', async () => {
    const { listeners, onMessages } = await setup()
    await listeners['/v1.0/im/bot/messages/get']({
      data: JSON.stringify({ msgId: 'mid1', senderStaffId: 'u1', conversationType: '1', text: { content: ' build me a tests' } }),
    })
    expect(onMessages).toHaveLength(1)
    expect(onMessages[0]).toMatchObject({ text: 'build me a tests', userId: 'u1', origin: 'dingtalk' })
  })

  it('user-card echo binds session→sender; assistant final lands as markdown to that sender', async () => {
    const { bus, sent, listeners } = await setup()
    await listeners['/v1.0/im/bot/messages/get']({
      data: JSON.stringify({ msgId: 'mid1', senderStaffId: 'u9', conversationType: '1', text: { content: 'hi' } }),
    })
    // relay echo: user card with id user:${messageId} under the RESOLVED session
    bus.publish({ kind: 'user', sessionId: 'ses_resolved', id: 'user:mid1', text: 'hi', ts: Date.now(), origin: 'dingtalk' })
    bus.publish({ kind: 'streaming', sessionId: 'ses_resolved', id: 't1', blocks: [] }) // v1 skips streaming
    bus.publish({ kind: 'assistant', sessionId: 'ses_resolved', id: 't2', blocks: [{ type: 'text', text: 'done' }], meta: { cost: 0.02 } })
    await new Promise((r) => setTimeout(r, 30))

    expect(sent).toHaveLength(1)
    expect(sent[0].userIds).toEqual(['u9'])
    expect(sent[0].robotCode).toBe('app-key')
    const param = JSON.parse(sent[0].msgParam)
    expect(param.content).toContain('done')
    expect(param.content).toContain('$0.020')
  })

  it('assistant without a prior inbound never sends (no route to a user)', async () => {
    const { bus, sent } = await setup()
    bus.publish({ kind: 'assistant', sessionId: 'ses_x', id: 't1', blocks: [{ type: 'text', text: 'x' }], meta: {} })
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('start retries are skipped for injected stream (fail fast in tests)', async () => {
    const bus = createCardBus()
    const stream = {
      registerCallbackListener() {},
      connect: vi.fn(async () => { throw new Error('no net') }),
      disconnect: vi.fn(),
    }
    const transport = createDingTalkTransport({ clientId: 'a', clientSecret: 'b', stream, rest: { getAccessToken: async () => 't', oToMessages: async () => {} } })
    await expect(transport.start({ cardBus: bus, state: fakeState() } as any)).rejects.toThrow('no net')
  })
})
