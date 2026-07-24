import { describe, it, expect, vi } from 'vitest'
import { registerHandlers, type PendingApproval } from '../../../src/transport/telegram/handlers'

/** A Telegraf stand-in that records action(regex/string, handler) registrations. */
function captureBot() {
  const actions: Array<{ trigger: any; handler: (ctx: any) => any }> = []
  return {
    actions,
    command: vi.fn(),
    action: vi.fn((trigger: any, handler: (ctx: any) => any) => { actions.push({ trigger, handler }) }),
    telegram: {
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      deleteMyCommands: vi.fn().mockResolvedValue(undefined),
    },
  }
}

function findApprove(bot: ReturnType<typeof captureBot>) {
  const entry = bot.actions.find((a) => a.trigger instanceof RegExp && a.trigger.test('approve:once:perm_1'))
  if (!entry) throw new Error('approve action not registered')
  return entry
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const pendingApprovals = new Map<string, PendingApproval>()
  const approvalTokens = new Map<string, string>()
  const bot = captureBot()
  const backend = { resolvePermission: vi.fn().mockResolvedValue(undefined) }
  const deps: any = {
    bot,
    backend,
    state: {} as any,
    isGenerating: () => false,
    abortGeneration: vi.fn(),
    baseUrl: '',
    pendingApprovals,
    approvalTokens,
    ...overrides,
  }
  registerHandlers(deps)
  return { bot, backend, pendingApprovals, approvalTokens, deps }
}

describe('command scope setup on init', () => {
  it('sets the same command list for default, all_private_chats and all_group_chats scopes', () => {
    const { bot } = makeDeps()
    expect(bot.telegram.setMyCommands).toHaveBeenCalledTimes(3)
    const calls = bot.telegram.setMyCommands.mock.calls as any[]
    const commands = calls[0][0]
    expect(calls.some((c) => c[1] === undefined)).toBe(true)                          // default scope
    expect(calls.some((c) => c[1]?.scope?.type === 'all_private_chats')).toBe(true)
    expect(calls.some((c) => c[1]?.scope?.type === 'all_group_chats')).toBe(true)
    expect(commands).toEqual(expect.arrayContaining([{ command: 'start', description: expect.any(String) }]))
  })
})

describe('approve: button callback', () => {
  it('replies the decision to opencode and clears the pending approval', async () => {
    const { bot, backend, pendingApprovals } = makeDeps()
    pendingApprovals.set('perm_1', { sessionId: 'ses_a', permissionId: 'perm_1', messageId: 42, title: 'Edit foo.ts', createdAt: Date.now() })

    const { trigger, handler } = findApprove(bot)
    const ctx = {
      match: 'approve:always:perm_1'.match(trigger),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await handler(ctx)

    expect(backend.resolvePermission).toHaveBeenCalledWith('ses_a', 'perm_1', 'always')
    expect(pendingApprovals.has('perm_1')).toBe(false)
    expect(ctx.editMessageText).toHaveBeenCalled()
    expect(ctx.answerCbQuery).toHaveBeenCalled()
  })

  it('resolves a short callback token back to the full permission id', async () => {
    const { bot, backend, pendingApprovals, approvalTokens } = makeDeps()
    const longPermId = 'per_' + 'x'.repeat(80) // would exceed the 64-byte callback_data limit raw
    approvalTokens.set('tok_abc123', longPermId)
    pendingApprovals.set(longPermId, { sessionId: 'ses_a', permissionId: longPermId, messageId: 42, title: 'Edit foo.ts', createdAt: Date.now() })

    const { trigger, handler } = findApprove(bot)
    const ctx = {
      match: 'approve:once:tok_abc123'.match(trigger),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await handler(ctx)

    expect(backend.resolvePermission).toHaveBeenCalledWith('ses_a', longPermId, 'once')
    expect(pendingApprovals.has(longPermId)).toBe(false)
  })

  it('a fast double-click resolves only once (entry deleted before resolve)', async () => {
    const { bot, backend, pendingApprovals } = makeDeps()
    let release!: () => void
    backend.resolvePermission.mockImplementation(() => new Promise<void>((r) => { release = r }))
    pendingApprovals.set('perm_1', { sessionId: 'ses_a', permissionId: 'perm_1', messageId: 42, title: 'Edit foo.ts', createdAt: Date.now() })

    const { trigger, handler } = findApprove(bot)
    const mkCtx = () => ({
      match: 'approve:once:perm_1'.match(trigger),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    })
    const first = mkCtx()
    const second = mkCtx()
    const p1 = handler(first)          // still awaiting resolvePermission…
    await handler(second)              // …when the second tap arrives

    expect(backend.resolvePermission).toHaveBeenCalledTimes(1)
    expect(second.answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/already been handled/i))
    release()
    await p1
  })

  it('drops the pending entry even when resolvePermission fails', async () => {
    const { bot, backend, pendingApprovals } = makeDeps()
    backend.resolvePermission.mockRejectedValue(new Error('expired'))
    pendingApprovals.set('perm_1', { sessionId: 'ses_a', permissionId: 'perm_1', messageId: 42, title: 'Edit foo.ts', createdAt: Date.now() })

    const { trigger, handler } = findApprove(bot)
    const ctx = {
      match: 'approve:reject:perm_1'.match(trigger),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await handler(ctx)

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/failed to reply/i))
    expect(pendingApprovals.has('perm_1')).toBe(false)
  })

  it('escapes HTML in the approval title when editing the card', async () => {
    const { bot, pendingApprovals } = makeDeps()
    pendingApprovals.set('perm_1', { sessionId: 'ses_a', permissionId: 'perm_1', messageId: 42, title: 'Edit <b>foo</b> & bar', createdAt: Date.now() })

    const { trigger, handler } = findApprove(bot)
    const ctx = {
      match: 'approve:once:perm_1'.match(trigger),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await handler(ctx)

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Edit &lt;b&gt;foo&lt;/b&gt; &amp; bar'),
      expect.anything(),
    )
  })

  it('answers "already handled" when the approval is unknown', async () => {
    const { bot, backend } = makeDeps()
    const { trigger, handler } = findApprove(bot)
    const ctx = {
      match: 'approve:reject:gone'.match(trigger),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    }
    await handler(ctx)

    expect(backend.resolvePermission).not.toHaveBeenCalled()
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/already been handled/i))
  })
})
