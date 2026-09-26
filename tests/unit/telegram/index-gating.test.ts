import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Bot } from 'grammy'
import { createTelegramTransport } from '../../../src/transport/telegram/index'

/**
 * createTelegramTransport wires two bot.use() middlewares in order:
 *   [0] whitelist, [1] text-message relay gate.
 * We capture them by spying on Bot.prototype.use. callApi is stubbed so
 * the setMyCommands registration during registerHandlers never hits network.
 */
function makeState(over: Record<string, unknown> = {}) {
  return {
    getPinnedSessionId: () => undefined,
    getLastSessionId: () => undefined,
    normalizeSessionId: (s: string) => s,
    hasActiveGeneration: vi.fn((_sid?: string) => false),
    getActiveAbort: () => undefined,
    ...over,
  } as any
}

function makeTransport(state: any) {
  // Recording bot injected through the factory's DI seam — no prototype
  // spying (grammY's Api has none), no network.
  const uses: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = []
  const fakeBot = {
    use: vi.fn((mw: any) => { uses.push(mw) }),
    command: vi.fn(),
    hears: vi.fn(),
    callbackQuery: vi.fn(),
    catch: vi.fn(),
    api: {
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageText: vi.fn().mockResolvedValue({}),
      deleteMessage: vi.fn().mockResolvedValue({}),
      raw: { getUpdates: vi.fn().mockResolvedValue([]) },
    } as unknown as Api,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as Bot
  const transport = createTelegramTransport(
    { token: '123:abc', allowedUserIds: [1], backend: {} as any, state },
    { bot: fakeBot },
  )
  const middlewares = uses.slice(0, 2)
  return { transport, middlewares, fakeBot }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('whitelist middleware', () => {
  it('silently drops strangers (no reply, no next)', async () => {
    const { middlewares } = makeTransport(makeState())
    const ctx = { from: { id: 999 }, reply: vi.fn().mockResolvedValue({}) }
    const next = vi.fn().mockResolvedValue(undefined)
    await middlewares[0](ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('passes allowed users through', async () => {
    const { middlewares } = makeTransport(makeState())
    const ctx = { from: { id: 1 }, reply: vi.fn() }
    const next = vi.fn().mockResolvedValue(undefined)
    await middlewares[0](ctx, next)
    expect(next).toHaveBeenCalled()
  })
})

describe('per-session generation gate', () => {
  const textCtx = () => ({
    from: { id: 1 },
    chat: { id: 1 },
    message: { text: 'hello', message_id: 5 },
    reply: vi.fn().mockResolvedValue({}),
  })

  it('queues a prompt sent mid-generation (ack reply, relay still called)', async () => {
    const state = makeState({
      getPinnedSessionId: () => 'ses_target',
      hasActiveGeneration: vi.fn((sid?: string) => sid === 'ses_target'),
    })
    const { transport, middlewares } = makeTransport(state)
    const onMsg = vi.fn()
    transport.onMessage(onMsg)

    const ctx = textCtx()
    await middlewares[1](ctx, vi.fn())

    expect(state.hasActiveGeneration).toHaveBeenCalledWith('ses_target')
    // Queued, not dropped: the relay serializes the turn, the user gets an ack.
    expect(ctx.reply).toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0][0])).toMatch(/已排队/)
    expect(onMsg).toHaveBeenCalledTimes(1)
    expect(onMsg.mock.calls[0][0]).toMatchObject({ text: 'hello', origin: 'telegram' })
  })

  it('lets input through when only an unrelated session is generating', async () => {
    const state = makeState({
      getPinnedSessionId: () => 'ses_target',
      hasActiveGeneration: (sid?: string) => sid === 'ses_busy', // target is idle
    })
    const { transport, middlewares } = makeTransport(state)
    const onMsg = vi.fn()
    transport.onMessage(onMsg)

    const ctx = textCtx()
    await middlewares[1](ctx, vi.fn())

    expect(onMsg).toHaveBeenCalledTimes(1)
    expect(onMsg.mock.calls[0][0]).toMatchObject({ text: 'hello', origin: 'telegram' })
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('normalizes a short pinned id before gating', async () => {
    const state = makeState({
      getPinnedSessionId: () => 'abc12345',
      normalizeSessionId: (s: string) => (s === 'abc12345' ? 'ses_full_abc12345' : s),
      hasActiveGeneration: vi.fn((sid?: string) => sid === 'ses_full_abc12345'),
    })
    const { transport, middlewares } = makeTransport(state)
    const onMsg = vi.fn()
    transport.onMessage(onMsg)

    const ctx = textCtx()
    await middlewares[1](ctx, vi.fn())

    expect(state.hasActiveGeneration).toHaveBeenCalledWith('ses_full_abc12345')
    expect(onMsg).toHaveBeenCalledTimes(1)
  })
})

describe('photo intake + caption routing', () => {
  function photoCtx(over: Record<string, unknown> = {}) {
    return {
      from: { id: 1 },
      chat: { id: 1 },
      message: {
        photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 1280, height: 960 }],
        caption: 'what is this?',
        message_id: 7,
      },
      api: { getFile: vi.fn().mockResolvedValue({ file_path: 'photos/big.jpg' }) },
      reply: vi.fn().mockResolvedValue({}),
      ...over,
    }
  }

  function stubFetch(bytes = new Uint8Array([1, 2, 3])) {
    return vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) })
  }

  it('downloads the largest size and submits caption + image', async () => {
    const state = makeState()
    const { transport, middlewares } = makeTransport(state)
    const onMsg = vi.fn()
    transport.onMessage(onMsg)
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)

    const ctx = photoCtx()
    await middlewares[1](ctx, vi.fn())

    expect(ctx.api.getFile).toHaveBeenCalledWith('big')
    expect(fetchMock.mock.calls[0][0]).toContain('/file/bot123:abc/photos/big.jpg')
    expect(onMsg).toHaveBeenCalledTimes(1)
    const msg = onMsg.mock.calls[0][0]
    expect(msg.text).toBe('what is this?')
    expect(msg.images).toEqual([{ data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/jpeg' }])
  })

  it('replies with a failure notice and drops the turn when the download fails', async () => {
    const { transport, middlewares } = makeTransport(makeState())
    const onMsg = vi.fn()
    transport.onMessage(onMsg)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    const ctx = photoCtx()
    await middlewares[1](ctx, vi.fn())

    expect(onMsg).not.toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0][0])).toMatch(/图片接收失败/)
  })

  it('never routes a caption into a reply-keyboard button', async () => {
    const { transport, middlewares } = makeTransport(makeState())
    const onMsg = vi.fn()
    transport.onMessage(onMsg)
    vi.stubGlobal('fetch', stubFetch())

    const ctx = photoCtx({ message: { photo: [{ file_id: 'big', width: 10, height: 10 }], caption: 'AGENT 🤖', message_id: 8 } })
    await middlewares[1](ctx, vi.fn())

    expect(onMsg).toHaveBeenCalledTimes(1)
    expect(onMsg.mock.calls[0][0].text).toBe('AGENT 🤖')
  })
})
