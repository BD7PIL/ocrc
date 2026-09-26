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

  it('blocks input when the target session (pinned) is generating', async () => {
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
    expect(ctx.reply).toHaveBeenCalled()
    expect(String(ctx.reply.mock.calls[0][0])).toMatch(/already generating/i)
    expect(onMsg).not.toHaveBeenCalled()
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
    expect(onMsg).not.toHaveBeenCalled()
  })
})
