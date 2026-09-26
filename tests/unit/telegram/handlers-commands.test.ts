import { describe, it, expect, vi } from 'vitest'
import { registerHandlers, type PendingApproval } from '../../../src/transport/telegram/handlers'

/** A grammY stand-in that records command/callbackQuery registrations. */
function captureBot() {
  const commands = new Map<string, (ctx: any) => any>()
  const actions: Array<{ trigger: any; handler: (ctx: any) => any }> = []
  return {
    commands,
    actions,
    command: vi.fn((name: string, handler: (ctx: any) => any) => { commands.set(name, handler) }),
    callbackQuery: vi.fn((trigger: any, handler: (ctx: any) => any) => { actions.push({ trigger, handler }) }),
    api: {
      setMyCommands: vi.fn().mockResolvedValue(undefined),
    },
  }
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const bot = captureBot()
  const deps: any = {
    bot,
    backend: { abort: vi.fn().mockResolvedValue(undefined) },
    state: {
      getPinnedSessionId: () => undefined,
      getLastSessionId: () => undefined,
      normalizeSessionId: (s: string) => s,
      setPinnedSessionId: vi.fn(),
    },
    isGenerating: () => false,
    abortGeneration: vi.fn(() => undefined),
    baseUrl: '',
    pendingApprovals: new Map<string, PendingApproval>(),
    approvalTokens: new Map<string, string>(),
    ...overrides,
  }
  registerHandlers(deps)
  return { bot, deps }
}

describe('/session <id> command', () => {
  it('normalizes a short display id before pinning', async () => {
    const state = {
      getPinnedSessionId: () => undefined,
      getLastSessionId: () => undefined,
      normalizeSessionId: (s: string) => (s === 'abc12345' ? 'ses_full_abc12345' : s),
      setPinnedSessionId: vi.fn(),
    }
    const { bot } = makeDeps({ state })
    const handler = bot.commands.get('session')!
    const ctx = {
      message: { text: '/session abc12345' },
      reply: vi.fn().mockResolvedValue(undefined),
    }
    await handler(ctx)

    expect(state.setPinnedSessionId).toHaveBeenCalledWith('ses_full_abc12345')
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('ses_full_abc12345'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    )
  })
})

describe('abort target consistency', () => {
  it('/abort sends backend.abort to the same session abortGeneration resolved', async () => {
    const backend = { abort: vi.fn().mockResolvedValue(undefined) }
    const abortGeneration = vi.fn(() => 'ses_pinned_full')
    const { bot } = makeDeps({ backend, abortGeneration })
    const ctx = { reply: vi.fn().mockResolvedValue(undefined) }
    await bot.commands.get('abort')!(ctx)

    expect(abortGeneration).toHaveBeenCalled()
    expect(backend.abort).toHaveBeenCalledWith('ses_pinned_full')
  })

  it('/abort replies "No session to abort." when there is no target', async () => {
    const backend = { abort: vi.fn().mockResolvedValue(undefined) }
    const { bot } = makeDeps({ backend, abortGeneration: vi.fn(() => undefined) })
    const ctx = { reply: vi.fn().mockResolvedValue(undefined) }
    await bot.commands.get('abort')!(ctx)

    expect(backend.abort).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith('No session to abort.', expect.anything())
  })

  it('status:abort sends backend.abort to the same session abortGeneration resolved', async () => {
    const backend = { abort: vi.fn().mockResolvedValue(undefined) }
    const abortGeneration = vi.fn(() => 'ses_pinned_full')
    const { bot } = makeDeps({ backend, abortGeneration })
    const entry = bot.actions.find((a) => a.trigger === 'status:abort')!
    const ctx = {
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await entry.handler(ctx)

    expect(abortGeneration).toHaveBeenCalled()
    expect(backend.abort).toHaveBeenCalledWith('ses_pinned_full')
  })
})

describe('HTML escaping', () => {
  it('/rename escapes user input in the confirmation echo', async () => {
    const backend = { renameSession: vi.fn().mockResolvedValue(undefined) }
    const state = {
      getPinnedSessionId: () => 'ses_x',
      getLastSessionId: () => undefined,
      normalizeSessionId: (s: string) => s,
    }
    const { bot } = makeDeps({ backend, state })
    const ctx = {
      message: { text: '/rename a <b> & c' },
      reply: vi.fn().mockResolvedValue(undefined),
    }
    await bot.commands.get('rename')!(ctx)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('a &lt;b&gt; &amp; c'),
      expect.anything(),
    )
  })

  it('/sessions escapes session titles', async () => {
    const backend = {
      listSessionSummaries: vi.fn().mockResolvedValue([
        { id: 'ses_1', title: 'hack <script> & co', lastActiveAt: undefined },
      ]),
    }
    const { bot } = makeDeps({ backend })
    const ctx = { reply: vi.fn().mockResolvedValue(undefined) }
    await bot.commands.get('sessions')!(ctx)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('hack &lt;script&gt; &amp; co'),
      expect.anything(),
    )
  })

  it('/todo escapes todo content', async () => {
    const backend = {
      getTodos: vi.fn().mockResolvedValue([
        { content: 'fix <b> & friends', status: 'pending' },
      ]),
    }
    const state = {
      getPinnedSessionId: () => undefined,
      getLastSessionId: () => 'ses_t',
      normalizeSessionId: (s: string) => s,
    }
    const { bot } = makeDeps({ backend, state })
    const ctx = { reply: vi.fn().mockResolvedValue(undefined) }
    await bot.commands.get('todo')!(ctx)

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('fix &lt;b&gt; &amp; friends'),
      expect.anything(),
    )
  })
})

describe('model callback_data token map (64-byte limit)', () => {
  function findAction(bot: ReturnType<typeof captureBot>, data: string) {
    const entry = bot.actions.find((a) => a.trigger instanceof RegExp && a.trigger.test(data))
    if (!entry) throw new Error(`action for ${data} not registered`)
    return entry
  }

  it('emits ≤64-byte callback_data for long provider/model ids and resolves them back', async () => {
    const providerID = 'openrouter'
    const modelID = 'anthropic/claude-3.5-sonnet-with-a-very-long-vendor-slug'
    const backend = {
      getModels: vi.fn().mockResolvedValue([
        { id: providerID, name: 'OpenRouter', models: [{ id: modelID, name: 'Claude' }] },
      ]),
    }
    const state = {
      getNextModel: () => undefined,
      setNextModel: vi.fn(),
    }
    const { bot } = makeDeps({ backend, state })

    // Open the provider's model list (model:pick)
    const pick = findAction(bot, `model:pick:${providerID}`)
    const pickCtx = {
      match: `model:pick:${providerID}`.match(pick.trigger),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    }
    await pick.handler(pickCtx)

    const kb = pickCtx.editMessageText.mock.calls[0][1].reply_markup.inline_keyboard
    const data: string = kb[0][0].callback_data
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    expect(data).not.toContain(modelID)

    // Click the button — the token must resolve back to the full ids
    const set = findAction(bot, data)
    const setCtx = {
      match: data.match(set.trigger),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await set.handler(setCtx)

    expect(state.setNextModel).toHaveBeenCalledWith({ providerID, modelID })
  })

  it('answers "Stale" for an unknown model token instead of setting garbage', async () => {
    const state = { setNextModel: vi.fn() }
    const { bot } = makeDeps({ state })
    const set = findAction(bot, 'model:set:nosuchtoken')
    const ctx = {
      match: 'model:set:nosuchtoken'.match(set.trigger),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await set.handler(ctx)

    expect(state.setNextModel).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.stringMatching(/stale/i))
  })
})
