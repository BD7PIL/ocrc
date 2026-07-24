import { describe, it, expect, vi, afterEach } from 'vitest'
import { Telegraf, Telegram } from 'telegraf'
import { createTelegramTransport } from '../../../src/transport/telegram/index'

/**
 * createTelegramTransport wires two bot.use() middlewares in order:
 *   [0] whitelist, [1] text-message relay gate.
 * We capture them by spying on Telegraf.prototype.use. callApi is stubbed so
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
  vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue(true as any)
  const useSpy = vi.spyOn(Telegraf.prototype, 'use')
  const transport = createTelegramTransport({
    token: '123:abc',
    allowedUserIds: [1],
    backend: {} as any,
    state,
  })
  const middlewares = useSpy.mock.calls
    .slice(0, 2)
    .map((c) => c[0] as (ctx: any, next: () => Promise<void>) => Promise<void>)
  return { transport, middlewares }
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
