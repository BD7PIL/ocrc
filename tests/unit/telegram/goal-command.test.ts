// N12 G6 — Telegram /goal command surface. The loop itself is host-side, so the
// bot is just another command face over the same record; these tests pin the
// parsing, the state transitions, and the callback wiring.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHandlers, type PendingApproval } from '../../../src/transport/telegram/handlers'
import { createFileBackedState } from '../../../src/core/state'
import { createCardBus } from '../../../src/core/card-bus'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import { createGoalManager, type GoalManager } from '../../../src/core/goal'
import type { AgentBackend } from '../../../src/core/agent/backend'

function captureBot() {
  const commands = new Map<string, (ctx: any) => any>()
  const actions: Array<{ trigger: any; handler: (ctx: any) => any }> = []
  return {
    commands, actions,
    command: vi.fn((name: string, handler: (ctx: any) => any) => { commands.set(name, handler) }),
    callbackQuery: vi.fn((trigger: any, handler: (ctx: any) => any) => { actions.push({ trigger, handler }) }),
    api: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
  }
}

function fakeBackend(): AgentBackend {
  return {
    id: 'opencode', capabilities: {} as AgentBackend['capabilities'],
    prompt: async () => {}, abort: async () => {}, hasSession: async () => true,
    listSessions: async () => [], listSessionSummaries: async () => [],
    createSession: async () => ({ id: 'ses_x' }), deleteSession: async () => {}, renameSession: async () => {},
    getSessionMeta: async () => ({}), getContext: async () => ({}), getHistory: async () => [],
    getMessageBlocks: async () => [], getDiff: async () => [], getTodos: async () => [],
    getSessionsStatus: async () => ({}), ping: async () => true, getAgents: async () => [],
    getModels: async () => [], getMcp: async () => [], listWorkspaces: async () => [],
    listCommands: async () => [], runCommand: async () => {}, resolvePermission: async () => {},
  } as AgentBackend
}

function makeDeps(sessionId: string | undefined = 'ses_1', over: { isPlanMode?: () => boolean } = {}) {
  const bot = captureBot()
  const state = createFileBackedState(join(mkdtempSync(join(tmpdir(), 'goal-tg-')), 'state.json'))
  const manager: GoalManager = createGoalManager({
    state,
    registry: singleBackendRegistry(fakeBackend()),
    dispatch: async () => {},
    cardBus: createCardBus(),
    now: () => 1_000_000,
    isPlanMode: over.isPlanMode,
  })
  const deps: any = {
    bot,
    backend: fakeBackend(),
    state: {
      getPinnedSessionId: () => sessionId,
      getLastSessionId: () => undefined,
      normalizeSessionId: (s: string) => s,
      setPinnedSessionId: vi.fn(),
    },
    isGenerating: () => false,
    abortGeneration: vi.fn(() => undefined),
    baseUrl: '',
    pendingApprovals: new Map<string, PendingApproval>(),
    approvalTokens: new Map<string, string>(),
    goalManager: manager,
  }
  registerHandlers(deps)
  return { bot, deps, manager, state }
}

const ctxFor = (text: string) => ({
  match: text.replace(/^\/goal\s*/, ''),
  message: { text },
  reply: vi.fn().mockResolvedValue(undefined),
  answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
})

describe('/goal command (N12)', () => {
  it('bare /goal shows an empty-state prompt', async () => {
    const { bot } = makeDeps()
    const ctx = ctxFor('/goal')
    await bot.commands.get('goal')!(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('没有目标'), expect.anything())
  })

  it('/goal <objective> sets the goal and renders its status card', async () => {
    const { bot, manager } = makeDeps()
    const ctx = ctxFor('/goal 让测试全绿')
    await bot.commands.get('goal')!(ctx)
    expect(manager.status('ses_1')).toMatchObject({ objective: '让测试全绿', status: 'active' })
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('目标已设置'))
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('进行中'), expect.anything())
  })

  it('/goal set <objective> works too and keeps the whole objective', async () => {
    const { bot, manager } = makeDeps()
    await bot.commands.get('goal')!(ctxFor('/goal set 修好 A 和 B'))
    expect(manager.status('ses_1')!.objective).toBe('修好 A 和 B')
  })

  it('/goal pause → resume → clear walks the states', async () => {
    const { bot, manager } = makeDeps()
    const cmd = bot.commands.get('goal')!
    await cmd(ctxFor('/goal 目标'))
    await cmd(ctxFor('/goal pause'))
    expect(manager.status('ses_1')!.status).toBe('paused')
    await cmd(ctxFor('/goal resume'))
    expect(manager.status('ses_1')!.status).toBe('active')
    await cmd(ctxFor('/goal clear'))
    expect(manager.status('ses_1')).toBeUndefined()
  })

  it('/goal pause on a non-active goal reports the refusal', async () => {
    const { bot } = makeDeps()
    const cmd = bot.commands.get('goal')!
    await cmd(ctxFor('/goal 目标'))
    await cmd(ctxFor('/goal pause'))
    const ctx = ctxFor('/goal pause')
    await cmd(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('不在进行中'))
  })

  it('refuses to set a goal while the agent is in plan mode', async () => {
    const { bot, manager } = makeDeps('ses_1', { isPlanMode: () => true })
    const ctx = ctxFor('/goal 目标')
    await bot.commands.get('goal')!(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('计划模式'))
    expect(manager.status('ses_1')).toBeUndefined()
  })

  it('with no resolvable session it asks for one instead of guessing', async () => {
    const { bot } = makeDeps('') // empty string = no pinned/last session
    const ctx = ctxFor('/goal 目标')
    await bot.commands.get('goal')!(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('没有可用的会话'))
  })

  it('registers the goal callbacks and dispatches them to the right session', async () => {
    const { bot, manager } = makeDeps()
    await bot.commands.get('goal')!(ctxFor('/goal 目标'))
    const cb = bot.actions.find((a) => a.trigger instanceof RegExp && a.trigger.test('goal:pause:ses_1'))!
    expect(cb).toBeDefined()
    const ctx = { match: ['goal:pause:ses_1', 'pause', 'ses_1'], reply: vi.fn().mockResolvedValue(undefined), answerCallbackQuery: vi.fn().mockResolvedValue(undefined) }
    await cb.handler(ctx)
    expect(manager.status('ses_1')!.status).toBe('paused')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('已暂停')

    const resumeCb = bot.actions.find((a) => a.trigger instanceof RegExp && a.trigger.test('goal:resume:ses_1'))!
    const ctx2 = { match: ['goal:resume:ses_1', 'resume', 'ses_1'], reply: vi.fn().mockResolvedValue(undefined), answerCallbackQuery: vi.fn().mockResolvedValue(undefined) }
    await resumeCb.handler(ctx2)
    expect(manager.status('ses_1')!.status).toBe('active')
  })

  it('exposes /goal in the BotFather menu and /help', async () => {
    const { bot } = makeDeps()
    const setMyCommands = bot.api.setMyCommands as any
    const registered = setMyCommands.mock.calls[0][0] as Array<{ command: string }>
    expect(registered.some((c) => c.command === 'goal')).toBe(true)
    const help = ctxFor('/help')
    await bot.commands.get('help')!(help)
    expect(help.reply).toHaveBeenCalledWith(expect.stringContaining('/goal'), expect.anything())
  })
})
