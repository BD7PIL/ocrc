import { createHash } from 'node:crypto'
import { Bot, InlineKeyboard, type Context } from 'grammy'
import { inlineKeyboard, btn, type TgBtn } from './ui.js'
import type { Scheduler } from '../../core/scheduler.js'
import type { ChannelBot, WorkspaceScope } from '../../core/channels.js'
import type { PairingStore } from '../../connectivity/pairing.js'
import type { AgentBackend, AgentInfo, ModelProvider, SkillInfo } from '../../core/agent/backend.js'
import type { SessionState } from '../../core/state.js'
import type { CardBus } from '../../core/card-bus.js'
import { createLogger } from '../../utils/logger.js'
import { getVersionInfo } from '../../utils/version.js'
import { registerInfoCommands } from './handlers/info-commands.js'
import { esc } from './esc.js'

const log = createLogger('handlers')

export interface HandlersDeps {
  bot: Bot
  scheduler?: Scheduler
  backend: AgentBackend
  state: SessionState
  isGenerating: () => boolean
  /** Abort the local generation; returns the single resolved target session id (normalized pinned ?? last), if any. */
  abortGeneration: () => string | undefined
  /** opencode server base URL (in-process plugin server). */
  baseUrl?: string
  /** Shared pending-approval map. */
  pendingApprovals: Map<string, PendingApproval>
  /** Short token → permissionId map for approval callback_data (64-byte limit). */
  approvalTokens: Map<string, string>
  /** CardBus — optional, available after transport start. */
  cardBus?: CardBus
  /** Project directory where opencode.json lives, used as `directory` query param for /config endpoints. */
  opencodeProject?: string
  /** M9 bot-channel settings — gates reply granularity and workspace scope. */
  channels?: () => ChannelBot | undefined
  /** M11 pending-token pairing store — /pair issues a short-lived token. */
  pairing?: PairingStore
}

/** M9 工作区访问范围: filter the workspace list per the tg-default bot scope. */
function scopeWorkspaces<W extends { directory: string }>(deps: { channels?: () => ChannelBot | undefined }, ws: W[]): W[] {
  const scope: WorkspaceScope | undefined = deps.channels?.()?.workspaces
  if (!scope || scope.mode === 'all') return ws
  const allowed = new Set(scope.dirs)
  return ws.filter((w) => allowed.has(w.directory))
}

/** M9: is the given workspace allowed for the tg-default bot? */
function workspaceAllowed(deps: { channels?: () => ChannelBot | undefined }, dir: string): boolean {
  const scope: WorkspaceScope | undefined = deps.channels?.()?.workspaces
  if (!scope || scope.mode === 'all') return true
  return scope.dirs.includes(dir)
}

/**
 * Parse a "providerID/modelID" string into the shape expected by state/relay.
 * Returns undefined if the string lacks a slash. Preserves slashes inside modelID.
 */
function parseAgentModel(modelStr: string): { providerID: string; modelID: string } | undefined {
  const idx = modelStr.indexOf('/')
  if (idx <= 0 || idx === modelStr.length - 1) return undefined
  return {
    providerID: modelStr.slice(0, idx),
    modelID: modelStr.slice(idx + 1),
  }
}


function shortPath(p: string): string {
  const cwd = process.cwd()
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
  if (p.startsWith('/')) {
    const parts = p.split('/')
    if (parts.length > 3) return '…/' + parts.slice(-3).join('/')
  }
  return p
}

interface StatusCard {
  lines: string[]
  buttons: TgBtn[]
}

async function buildStatusCard(deps: HandlersDeps): Promise<StatusCard> {
  const healthy = await deps.backend.ping()
  let busyCount = 0
  let totalSessions = 0
  let totalCost = 0
  try {
    const data = (await deps.backend.getSessionsStatus()) as Record<string, { type: string }>
    totalSessions = Object.keys(data).length
    busyCount = Object.values(data).filter((s) => s.type === 'busy').length
    for (const sid of Object.keys(data)) {
      const c = deps.state.getSessionCost(sid)
      if (c !== undefined) totalCost += c
    }
  } catch {
    try {
      totalSessions = (await deps.backend.listSessions()).length
    } catch {}
  }
  const pinnedSession = deps.state.getPinnedSessionId()
  const lastSession = deps.state.getLastSessionId()
  const tuiSession = deps.state.getTuiSelectedSession()
  const effectiveSession = pinnedSession ?? lastSession
  const currentAgent = deps.state.getCurrentAgent()
  const nextAgent = deps.state.getNextAgent()
  const nextModel = deps.state.getNextModel()

  const row = (label: string, value: string) =>
    `  <b>${label}</b>   ${value}`

  const sessionLabel = pinnedSession ? 'Bot 📌' : 'Bot'
  const lines = [
    `${healthy ? '🟢' : '🔴'}  <b>opencode</b>  ·  ${healthy ? 'healthy' : 'unreachable'}`,
    '',
    row('Sessions', `${totalSessions}  ·  ${busyCount} busy`),
    ...(totalCost > 0 ? [row('Cost', `$${totalCost.toFixed(2)} today`)] : []),
    ...(effectiveSession
      ? [row(sessionLabel, `<code>…${effectiveSession.slice(-8)}</code>${currentAgent ? `  ·  ${currentAgent}` : ''}`)]
      : []),
    ...(tuiSession && tuiSession !== effectiveSession
      ? [row('TUI', `<code>…${tuiSession.slice(-8)}</code>`)]
      : []),
    ...((nextAgent || nextModel)
      ? ['',
         `  Next ›  ${nextAgent ? `<b>${nextAgent}</b>` : '—'}  ·  ${nextModel ? `<code>${nextModel.modelID}</code>` : '—'}`]
      : []),
  ]
  const buttons: TgBtn[] = [
    btn('🔄 Refresh', 'status:refresh'),
  ]
  if (deps.isGenerating()) {
    buttons.push(btn('⏹ Stop', 'status:abort'))
  }
  return { lines, buttons }
}

export function registerHandlers(deps: HandlersDeps): void {
  // Maps a short token -> workspace directory, so callback_data stays under
  // Telegram's 64-byte limit. Stable per directory (sha1-derived).
  const wsTokens = new Map<string, string>()
  const wsToken = (dir: string) => {
    const t = createHash('sha1').update(dir).digest('base64url').slice(0, 16)
    wsTokens.set(t, dir)
    return t
  }

  // Same token-map pattern for model callbacks: a "providerID:modelID" pair
  // (e.g. openrouter's vendor/model slugs) easily exceeds Telegram's 64-byte
  // callback_data limit, which fails the whole keyboard with BUTTON_DATA_INVALID.
  const modelTokens = new Map<string, string>()
  const modelToken = (providerID: string, modelID: string) => {
    const t = createHash('sha1').update(`model:${providerID}/${modelID}`).digest('base64url').slice(0, 16)
    modelTokens.set(t, `${providerID}/${modelID}`)
    return t
  }

  // ── Commands ──

  deps.bot.command('start', async (ctx: Context) => {
    const healthy = await deps.backend.ping()
    const username = ctx.from?.first_name ?? 'there'
    const nextAgent = deps.state.getNextAgent()
    const nextModel = deps.state.getNextModel()
    const lines = [
      `👋  <b>Hi ${username}</b>`,
      '',
      `opencode  ${healthy ? '🟢 ready' : '🔴 unreachable'}`,
      'Send any message to relay it into opencode.',
      '',
      '<b>Commands</b>',
      '  /status    Health + current session',
      '  /sessions  List all sessions',
      '  /agent     Set next-message agent',
      '  /model     Set next-message model',
      '  /pair      Pair a new device',
      '  /files     Files touched this session',
      '  /diff      Pending git diff',
      '  /todo      Session todo list',
      '  /context   Tokens + cost + model',
      '  /abort     Stop generation',
      '  /workspaces List/switch workspaces',
      '  /new       New session in active workspace',
    ]
    if (nextAgent || nextModel) {
      lines.push('')
      if (nextAgent) lines.push(`<i>Next agent: ${nextAgent}</i>`)
      if (nextModel) lines.push(`<i>Next model: ${nextModel.modelID}</i>`)
    }
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      ...inlineKeyboard([
        [btn('🔄 Status', 'status:refresh')],
      ]),
    })
  })

  deps.bot.command('status', async (ctx: Context) => {
    const { lines, buttons } = await buildStatusCard(deps)
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      ...inlineKeyboard([buttons]),
    })
  })

  deps.bot.command('sessions', async (ctx: Context) => {
    try {
      const sessions = (await deps.backend.listSessionSummaries()).map(s => ({
        ...s,
        when: s.lastActiveAt
          ? new Date(s.lastActiveAt).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })
          : 'unknown',
      }))
      if (sessions.length === 0) {
        await ctx.reply('No sessions.', { parse_mode: 'HTML' })
        return
      }
      const pinned = deps.state.getLastSessionId()
      const lines: string[] = ['<b>📋 Sessions</b>', '']
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i]
        const pinEmoji = s.id === pinned ? '📌 ' : ''
        lines.push(`${i + 1}. ${pinEmoji}<code>…${s.id.slice(-8)}</code>`)
        lines.push(`   ${esc(s.title ?? 'Untitled')} · ${s.when}`)
        if (s.directory) lines.push(`   📂 ${esc(s.directory.split('/').pop() || s.directory)}`)
        lines.push('')
      }
      if (pinned) {
        lines.push(`<i>📌 Pinned: …${pinned.slice(-8)}</i>`)
      }
      const rows = sessions.map(s => [
        btn(`📌 Pin ${s.id.slice(-6)}`, `session:pin:${s.id}`),
      ])
      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        ...inlineKeyboard(rows),
      })
    } catch (err) {
      log.error('failed to list sessions', err as Error)
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('session', async (ctx: Context) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
    const args = text ? text.split(' ').slice(1)[0]?.trim() : undefined
    if (args && args.length > 0) {
      const sid = deps.state.normalizeSessionId(args)
      deps.state.setPinnedSessionId(sid)
      await ctx.reply(
        `<b>📌 Pinned</b>\n\n<code>${esc(sid)}</code>`,
        {
          parse_mode: 'HTML',
          ...inlineKeyboard([
            [btn('Unpin', 'session:unpin')],
          ]),
        },
      )
      return
    }
    const pinned = deps.state.getPinnedSessionId()
    if (!pinned) {
      await ctx.reply(
        'No session pinned. Use <code>/session &lt;id&gt;</code> or pick from /sessions.',
        { parse_mode: 'HTML' },
      )
      return
    }
    await ctx.reply(
      `<b>📌 Pinned session</b>\n\n<code>${pinned}</code>`,
      {
        parse_mode: 'HTML',
        ...inlineKeyboard([
          [btn('Unpin', 'session:unpin')],
        ]),
      },
    )
  })

  deps.bot.command('files', async (ctx: Context) => {
    const last = deps.state.getLastSessionId()
    if (!last) {
      await ctx.reply(
        '<b>📁 Files</b>\n\nNo session yet. Send a message first.',
        { parse_mode: 'HTML' },
      )
      return
    }

    try {
      const cards = await deps.backend.getHistory(last, 0)

      const fileEmoji: Record<string, string> = {
        read: '📖', write: '🆕', edit: '✏️',
      }
      const fileOps = new Map<string, string>()

      for (const card of cards) {
        if (card.kind !== 'assistant') continue
        for (const block of card.blocks) {
          if (block.type === 'tool' && fileEmoji[block.tool] && block.args) {
            fileOps.set(block.args, fileEmoji[block.tool])
          }
        }
      }

      const shortId = last.slice(-8)
      if (fileOps.size === 0) {
        await ctx.reply(
          `<b>📁 Files — …${shortId}</b>\n\nNo file operations recorded.`,
          { parse_mode: 'HTML' },
        )
        return
      }

      const MAX = 15
      const entries = [...fileOps.entries()]
      const shown = entries.slice(0, MAX)
      const lines = [
        `<b>📁 Files — …${shortId}</b>`,
        '',
        ...shown.map(([p, emoji]) => `${emoji}  <code>${shortPath(p)}</code>`),
      ]
      if (entries.length > MAX) {
        lines.push(`\n…and ${entries.length - MAX} more`)
      }
      lines.push('', `<i>${entries.length} file operation${entries.length > 1 ? 's' : ''}</i>`)

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      log.error('failed to fetch files', err as Error)
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('agent', async (ctx: Context) => {
    try {
      const agents = await deps.backend.getAgents(deps.opencodeProject)
      if (agents.length === 0) {
        await ctx.reply(
          '🤖  <b>Agent</b>\n\nNo agents configured. Add them in <code>opencode.jsonc</code>.',
          { parse_mode: 'HTML' },
        )
        return
      }
      const nextAgent = deps.state.getNextAgent()
      const lines = ['🤖  <b>Agent</b>', '']
      for (const a of agents) {
        const active = a.name === nextAgent
        const modelShort = a.model.split('/').pop() ?? a.model
        const marker = active ? '✓' : '  '
        const name = active ? `<b>${a.name}</b>` : a.name
        const desc = a.description ? `  <i>${a.description}</i>` : ''
        lines.push(`${marker}  ${name}  <code>${modelShort}</code>${desc}`)
      }
      if (nextAgent) lines.push('', `<i>Active override: ${nextAgent}</i>`)
      const rows = agents.map(a => [btn(a.name, `agent:set:${a.name}`)])
      rows.push([btn('✕ Clear override', 'agent:clear')])
      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        ...inlineKeyboard(rows),
      })
    } catch (err) {
      log.error('failed to list agents', err as Error)
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('model', async (ctx: Context) => {
    try {
      const providers = await deps.backend.getModels(deps.opencodeProject)
      if (providers.length === 0) {
        await ctx.reply('<b>⚙️ Model</b>\n\nNo models configured.', { parse_mode: 'HTML' })
        return
      }

      const nextModel = deps.state.getNextModel()
      const lines = ['<b>⚙️ Model — Select provider</b>', '']
      const rows: Array<Array<TgBtn>> = []

      for (const p of providers) {
        const count = (p.models ?? []).length
        const hasSelected = nextModel?.providerID === p.id
        const marker = hasSelected ? '●' : '▸'
        lines.push(`${marker} <b>${p.name}</b>  ·  ${count} model${count !== 1 ? 's' : ''}`)
        rows.push([btn(p.name, `model:pick:${p.id}`)])
      }

      if (nextModel) {
        lines.push('', `<i>Current override: ${nextModel.providerID}/${nextModel.modelID}</i>`)
      }
      rows.push([btn('✕ Clear', 'model:clear')])

      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        ...inlineKeyboard(rows),
      })
    } catch (err) {
      log.error('failed to list models', err as Error)
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('current', async (ctx: Context) => {
    const last = deps.state.getLastSessionId()
    if (!last) {
      await ctx.reply(
        '<b>📍 No session</b>\n\nSend a message to start one.',
        { parse_mode: 'HTML' },
      )
      return
    }
    await ctx.reply(
      `<b>📍 Current session</b>\n\n<code>${last}</code>`,
      {
        parse_mode: 'HTML',
        ...inlineKeyboard([
          [btn('Unpin', 'session:unpin')],
        ]),
      },
    )
  })

  deps.bot.command('abort', async (ctx: Context) => {
    const sid = deps.abortGeneration()
    if (!sid) {
      await ctx.reply('No session to abort.', { parse_mode: 'HTML' })
      return
    }
    try {
      await deps.backend.abort(sid)
      await ctx.reply(`<b>🛑 Aborted</b>\n\n<code>…${sid.slice(-8)}</code>`, { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ Abort failed: ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('version', async (ctx: Context) => {
    const { version, commit, uptime, node } = getVersionInfo()
    await ctx.reply(
      [
        `<b>opencode-remote-control</b>  v${version}`,
        `Commit: <code>${commit}</code>`,
        `Uptime: ${uptime}`,
        `Node: ${node}`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    )
  })

  deps.bot.command('pair', async (ctx) => {
    try {
      const { buildPairContext, buildPairUrl, buildPairUrlPending } = await import('../../connectivity/pairing.js')
      const { url } = await buildPairContext()
      if (deps.pairing) {
        // M11: short-lived single-use pending token — the chat log only ever
        // holds a credential that dies in 1 minute or on first use.
        const p = deps.pairing.issue()
        const pairUrl = buildPairUrlPending(url, p.token)
        await ctx.reply(
          `🔗 <b>Pair a device</b>\n\nOpen this link on the device within <b>1 minute</b> (single use — sending /pair again invalidates it):\n<code>${pairUrl}</code>`,
          { parse_mode: 'HTML' },
        )
      } else {
        const { token } = await buildPairContext()
        const pairUrl = buildPairUrl(url, token)
        // The token travels in the URL fragment. Sending it over Telegram is
        // acceptable: the user already trusts this bot channel for control.
        await ctx.reply(`🔗 <b>Pair a device</b>\n\nOpen this once on the device:\n<code>${pairUrl}</code>`, { parse_mode: 'HTML' })
      }
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('help', async (ctx: Context) => {
    await ctx.reply(
      [
        '<b>🤖 opencode-remote-control</b>',
        '',
        '<b>Commands:</b>',
        '  /start      Handshake + health',
        '  /status     Server health + session',
        '  /sessions   List all sessions',
        '  /session    Pin a session',
        '  /pair       Pair a device (URL + token)',
        '  /files      Files touched in last session',
        '  /diff       Pending git diff',
        '  /todo       Session todo list',
        '  /context    Tokens + cost + model',
        '  /agent      Set next agent',
        '  /model      Set next model',
        '  /current    Last session used',
        '  /abort      Stop generation',
        '  /version    Bot version + uptime',
        '  /workspaces List/switch workspaces',
        '  /new        New session in active workspace',
        '  /help       This message',
        '',
        'Send any text to relay it into opencode.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        ...inlineKeyboard([
          [btn('🔄 Check status', 'status:refresh')],
        ]),
      },
    )
  })

  const workspacesHandler = async (ctx: Context) => {
    try {
      const ws = scopeWorkspaces(deps, await deps.backend.listWorkspaces())
      if (ws.length === 0) { await ctx.reply('当前工作区范围设置下没有可用的工作区（M9 工作区访问范围）。', { parse_mode: 'HTML' }); return }
      const active = deps.state.getActiveWorkspace()
      const lines = ['<b>🗂 Workspaces</b>', '']
      for (const w of ws.slice(0, 20)) {
        const mark = w.directory === active ? '📍 ' : ''
        lines.push(`${mark}<b>${w.name}</b>  ·  ${w.sessionCount} session${w.sessionCount === 1 ? '' : 's'}`)
        lines.push(`   <code>${w.directory}</code>`)
      }
      const rows = ws.slice(0, 20).map((w) => [btn(`📂 ${w.name}`, `ws:set:${wsToken(w.directory)}`)])
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', ...inlineKeyboard(rows) })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  }

  deps.bot.command('workspaces', workspacesHandler)
  // grinev 命令名对齐：/projects = /workspaces
  deps.bot.command('projects', workspacesHandler)

  deps.bot.callbackQuery(/^ws:set:(.+)$/, async (ctx) => {
    const dir = wsTokens.get(ctx.match[1])
    if (!dir) { await ctx.answerCallbackQuery('Stale — re-run /workspaces'); return }
    deps.state.setActiveWorkspace(dir)
    await ctx.answerCallbackQuery(`Workspace → ${dir.split('/').pop()}`)
    try { await ctx.editMessageText(`📍 <b>Active workspace</b>\n\n<code>${dir}</code>\n\nUse /new to start a session here.`, { parse_mode: 'HTML' }) } catch { /* ignore */ }
  })

  deps.bot.command('workspaces', workspacesHandler)
  // grinev 命令名对齐：/projects = /workspaces
  deps.bot.command('projects', workspacesHandler)

  // grinev 对齐：/detach = 取消跟随当前会话（等价 unpin）
  deps.bot.command('detach', async (ctx: Context) => {
    const pinned = deps.state.getPinnedSessionId()
    deps.state.setPinnedSessionId(undefined)
    await ctx.reply(pinned ? `🔓 已取消跟随 …${pinned.slice(-8)}` : 'ℹ️ 当前没有跟随的会话')
  })

  // grinev 对齐：/commands = 列出 opencode 自定义命令
  deps.bot.command('commands', async (ctx: Context) => {
    try {
      const cmds = await deps.backend.listCommands()
      if (cmds.length === 0) { await ctx.reply('没有已配置的自定义命令。'); return }
      const lines = ['<b>⌘ 自定义命令</b>']
      for (const c of cmds.slice(0, 20)) lines.push(`• <b>/${esc(c.name)}</b> — ${esc(c.description ?? '')}`)
      if (cmds.length > 20) lines.push(`… 共 ${cmds.length} 条`)
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // grinev 对齐：/mcps = MCP 服务器状态
  deps.bot.command('mcps', async (ctx: Context) => {
    try {
      const mcps = await deps.backend.getMcp(deps.opencodeProject)
      if (mcps.length === 0) { await ctx.reply('未配置 MCP 服务器。'); return }
      const lines = ['<b>🔌 MCP</b>']
      for (const m of mcps) lines.push(`• <b>${esc(m.name)}</b> — ${m.status === 'configured' ? '✅ 已配置' : '⚪ 未启用'}`)
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // grinev 对齐：/messages = 当前会话最近消息
  deps.bot.command('messages', async (ctx: Context) => {    try {
      const sid = deps.state.getPinnedSessionId() ?? deps.state.getLastSessionId()
      if (!sid) { await ctx.reply('没有活动会话。'); return }
      const cards = await deps.backend.getHistory(sid, 6)
      const lines: string[] = ['<b>🕘 最近消息</b>']
      for (const c of cards) {
        if (c.kind === 'user') {
          lines.push(`🧑 ${esc((c as any).text?.slice(0, 80) ?? '')}`)
        } else if (c.kind === 'assistant') {
          for (const b of (c as any).blocks ?? []) {
            if (b.type === 'text' && b.text) { lines.push(`🤖 ${esc(b.text.slice(0, 80))}`); break }
          }
        }
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // ── P2c parity: subagent visibility (web plan-card C1) ──
  deps.bot.command('subs', async (ctx: Context) => {
    try {
      const sid = deps.state.getPinnedSessionId() ?? deps.state.getLastSessionId()
      if (!sid) { await ctx.reply('没有活动会话。'); return }
      const subs = await deps.backend.getSubagents?.(sid)
      if (!subs) { await ctx.reply('当前后端不支持子代理查询。'); return }
      if (subs.length === 0) { await ctx.reply('该会话没有子代理。'); return }
      const lines = [`<b>🧩 子代理 · ${subs.length}</b>`]
      const kb = new InlineKeyboard()
      for (const s of subs.slice(0, 8)) {
        const prog = s.total > 0 ? ` · ${s.done}/${s.total}` : ''
        lines.push(`• <b>${esc(s.title || '…' + s.id.slice(-6))}</b>${prog}`)
        try {
          const { buildPairContext, buildPairUrl } = await import('../../connectivity/pairing.js')
          const { token, url } = await buildPairContext()
          kb.url(`📤 打开 ${s.title.slice(0, 16) || '…' + s.id.slice(-6)}`, buildPairUrl(url, token).replace(/#.*$/, '') + `/${s.id}`).row()
        } catch { /* link build is best-effort */ }
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // ── P2c parity: session-level mode switch (web SessionControls C5) ──
  const modeTokens = new Map<number, { sid: string; modeId: string }>()
  let modeSeq = 0
  deps.bot.command('mode', async (ctx: Context) => {
    try {
      const sid = deps.state.getPinnedSessionId() ?? deps.state.getLastSessionId()
      if (!sid) { await ctx.reply('没有活动会话。'); return }
      const controls = await deps.backend.getControls?.(sid)
      const options = controls?.mode?.options ?? []
      if (options.length === 0) { await ctx.reply('当前后端没有可切换的 mode。'); return }
      const kb = new InlineKeyboard()
      for (const o of options) {
        const tok = ++modeSeq
        modeTokens.set(tok, { sid, modeId: o.id })
        kb.text(`${o.id === controls?.mode?.current ? '📍 ' : ''}${o.name || o.id}`, `tmode:${tok}`).row()
      }
      await ctx.reply('<b>🎚 会话模式</b>', { parse_mode: 'HTML', reply_markup: kb })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })
  deps.bot.callbackQuery(/^tmode:(\d+)$/, async (ctx) => {
    const t = modeTokens.get(Number(ctx.match[1]))
    if (!t) { await ctx.answerCallbackQuery('已过期 — 重新 /mode'); return }
    try {
      await deps.backend.setMode?.(t.sid, t.modeId)
      await ctx.answerCallbackQuery(`已切换 → ${t.modeId}`)
      try { await ctx.editMessageText(`🎚 已切换 → <b>${esc(t.modeId)}</b>`, { parse_mode: 'HTML' }) } catch { }
    } catch (err) {
      await ctx.answerCallbackQuery(`切换失败：${(err as Error).message.slice(0, 60)}`)
    }
  })

  // ── P2c parity: cleanup finished subagent sessions (web C4) ──
  deps.bot.command('cleanup', async (ctx: Context) => {
    try {
      const all = await deps.backend.listSessions()
      const children = all.filter((s) => s.parentID)
      let deleted = 0
      for (const c of children) {
        try { await deps.backend.deleteSession(c.id); deleted += 1 } catch { /* skip */ }
      }
      await ctx.reply(`🧹 已清理 ${deleted} 个子代理会话。`)
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // ── M9: /channels — channel status mirror (config UI lives on web) ──
  deps.bot.command('channels', async (ctx: Context) => {
    try {
      const ch = deps.channels?.()?.enabled
      const tgOn = ch === undefined ? true : ch
      const lines = [
        '<b>🤖 机器人 / 通道</b>',
        tgOn
          ? '• Telegram — ✅ 已启用（web 端「机器人」面板可配置）'
          : '• Telegram — ⛔ 已停用（channels.json）',
        '• 微信 — ⏳ 待接入（凭证到位后启用）',
        '• Lark — ⏳ 待接入',
      ]
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // ── M8: /skills /ls /open /worktree (web parity with the Skills/Files panels) ──
  const skillsCache: SkillInfo[] = []
  const lsDirs = new Map<number, string>()
  const lsFiles = new Map<number, string>()
  let lsSeq = 0
  const wtTokens = new Map<number, string>()
  let wtSeq = 0

  deps.bot.command('skills', async (ctx: Context) => {
    try {
      const list = await deps.backend.getSkills?.(deps.opencodeProject)
      if (!list || list.length === 0) { await ctx.reply('没有可用的技能。'); return }
      skillsCache.length = 0
      skillsCache.push(...list)
      const PAGE = 6
      const pages = Math.max(1, Math.ceil(skillsCache.length / PAGE))
      const p = 0
      const lines = [`<b>🧩 Skills</b> · ${p + 1}/${pages} 页 · 共 ${skillsCache.length}`]
      const kb = new InlineKeyboard()
      for (const s of skillsCache.slice(p * PAGE, p * PAGE + PAGE)) {
        lines.push(`• <b>${esc(s.name)}</b> — ${esc((s.description ?? '').slice(0, 90))}`)
      }
      if (pages > 1) {
        if (p > 0) kb.text('◀️', `sk:page:${p - 1}`)
        kb.text(`${p + 1}/${pages}`, 'menu:noop')
        if (p < pages - 1) kb.text('▶️', `sk:page:${p + 1}`)
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })
  deps.bot.callbackQuery(/^sk:page:(\d+)$/, async (ctx) => {
    const p = Math.max(0, Number(ctx.match[1]))
    const PAGE = 6
    const pages = Math.max(1, Math.ceil(skillsCache.length / PAGE))
    const pp = Math.min(p, pages - 1)
    const lines = [`<b>🧩 Skills</b> · ${pp + 1}/${pages} 页 · 共 ${skillsCache.length}`]
    const kb = new InlineKeyboard()
    for (const s of skillsCache.slice(pp * PAGE, pp * PAGE + PAGE)) {
      lines.push(`• <b>${esc(s.name)}</b> — ${esc((s.description ?? '').slice(0, 90))}`)
    }
    if (pages > 1) {
      if (pp > 0) kb.text('◀️', `sk:page:${pp - 1}`)
      kb.text(`${pp + 1}/${pages}`, 'menu:noop')
      if (pp < pages - 1) kb.text('▶️', `sk:page:${pp + 1}`)
    }
    await ctx.answerCallbackQuery()
    try { await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb }) } catch { }
  })

  deps.bot.command('ls', async (ctx: Context) => {
    try {
      const arg = (ctx.message?.text ?? '').replace(/^\/ls\s*/, '').trim()
      const path = arg || '.'
      const files = await deps.backend.listFiles?.(deps.opencodeProject, path)
      if (!files) { await ctx.reply('当前后端不支持文件浏览。'); return }
      if (files.length === 0) { await ctx.reply(`📂 ${path}：空目录。`); return }
      const lines = [`<b>📂 ${esc(path)}</b> · 共 ${files.length}`]
      const kb = new InlineKeyboard()
      if (path !== '.') {
        const upTok = ++lsSeq
        lsDirs.set(upTok, path)
        kb.text('↰ ..', `ls:up:${upTok}`)
      }
      for (const f of files.slice(0, 20)) {
        if (f.type === 'directory') {
          const tok = ++lsSeq
          lsDirs.set(tok, f.path)
          kb.text(`📁 ${f.name}`, `ls:dir:${tok}`).row()
        } else {
          const tok = ++lsSeq
          lsFiles.set(tok, f.path)
          kb.text(`📄 ${f.name}`, `ls:cat:${tok}`)
        }
      }
      if (files.length > 20) lines.push(`… 其余 ${files.length - 20} 项未显示`)
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })
  deps.bot.callbackQuery(/^ls:dir:(\d+)$/, async (ctx) => {
    const path = lsDirs.get(Number(ctx.match[1]))
    if (!path) { await ctx.answerCallbackQuery('已过期 — 重新 /ls'); return }
    await ctx.answerCallbackQuery()
    try {
      const files = (await deps.backend.listFiles?.(deps.opencodeProject, path)) ?? []
      const lines = [`<b>📂 ${esc(path)}</b> · 共 ${files.length}`]
      const kb = new InlineKeyboard()
      if (path !== '.') {
        const upTok = ++lsSeq
        lsDirs.set(upTok, path)
        kb.text('↰ ..', `ls:up:${upTok}`)
      }
      for (const f of files.slice(0, 20)) {
        if (f.type === 'directory') {
          const tok = ++lsSeq
          lsDirs.set(tok, f.path)
          kb.text(`📁 ${f.name}`, `ls:dir:${tok}`).row()
        } else {
          const tok = ++lsSeq
          lsFiles.set(tok, f.path)
          kb.text(`📄 ${f.name}`, `ls:cat:${tok}`)
        }
      }
      try { await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb }) } catch { }
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })
  // Directory navigation re-runs /ls logic via the registered command flow —
  // simplest correct path: synthesize the message through the same handler.
  deps.bot.callbackQuery(/^ls:cat:(\d+)$/, async (ctx) => {
    const path = lsFiles.get(Number(ctx.match[1]))
    if (!path) { await ctx.answerCallbackQuery('已过期 — 重新 /ls'); return }
    await ctx.answerCallbackQuery()
    try {
      const f = await deps.backend.readFile?.(deps.opencodeProject, path)
      if (!f) { await ctx.reply('读取失败。'); return }
      if (f.type !== 'text') { await ctx.reply(`🔒 ${esc(path)}：二进制文件，不预览。`); return }
      const body = f.content.length > 800 ? f.content.slice(0, 800) + '\n…' : f.content
      await ctx.reply(`<b>📄 ${esc(path)}</b>\n<pre>${esc(body)}</pre>`, { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })
  deps.bot.callbackQuery(/^ls:up:(\d+)$/, async (ctx) => {
    const cur = lsDirs.get(Number(ctx.match[1]))
    if (!cur) { await ctx.answerCallbackQuery('已过期'); return }
    const parent = cur.includes('/') ? cur.replace(/\/[^/]+\/?$/, '') || '.' : '.'
    await ctx.answerCallbackQuery()
    try {
      const files = (await deps.backend.listFiles?.(deps.opencodeProject, parent)) ?? []
      const lines = [`<b>📂 ${esc(parent)}</b> · 共 ${files.length}`]
      const kb = new InlineKeyboard()
      if (parent !== '.') {
        const upTok = ++lsSeq
        lsDirs.set(upTok, parent)
        kb.text('↰ ..', `ls:up:${upTok}`)
      }
      for (const f of files.slice(0, 20)) {
        if (f.type === 'directory') {
          const tok = ++lsSeq
          lsDirs.set(tok, f.path)
          kb.text(`📁 ${f.name}`, `ls:dir:${tok}`).row()
        } else {
          const tok = ++lsSeq
          lsFiles.set(tok, f.path)
          kb.text(`📄 ${f.name}`, `ls:cat:${tok}`)
        }
      }
      await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('open', async (ctx: Context) => {
    const arg = (ctx.message?.text ?? '').replace(/^\/open\s*/, '').trim()
    if (!arg) { await ctx.reply('用法：/open <文件路径>（相对当前工作区，如 src/index.ts）'); return }
    try {
      const f = await deps.backend.readFile?.(deps.opencodeProject, arg)
      if (!f) { await ctx.reply('读取失败。'); return }
      if (f.type !== 'text') { await ctx.reply(`🔒 ${esc(arg)}：二进制文件，不预览。`); return }
      const body = f.content.length > 800 ? f.content.slice(0, 800) + '\n…' : f.content
      await ctx.reply(`<b>📄 ${esc(arg)}</b>\n<pre>${esc(body)}</pre>`, { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('worktree', async (ctx: Context) => {
    try {
      const arg = (ctx.message?.text ?? '').replace(/^\/worktree\s*/, '').trim()
      if (arg.startsWith('=')) {
        const name = arg.slice(1).trim()
        if (!name) { await ctx.reply('用法：/worktree = <名称>'); return }
        const dir = deps.state.getActiveWorkspace() || deps.opencodeProject || ''
        const created = await deps.backend.createWorktreeSandboxes?.(dir, name)
        if (!created) { await ctx.reply('❌ 创建失败（experimental 接口）。'); return }
        await ctx.reply(`🌿 已创建 worktree：<b>${esc(created.name)}</b>`)
        return
      }
      if (arg.startsWith('rm ')) {
        const name = arg.slice(3).trim()
        if (!name) { await ctx.reply('用法：/worktree rm <名称>'); return }
        const tok = ++wtSeq
        wtTokens.set(tok, name)
        const kb = new InlineKeyboard()
          .text('🗑 确认删除', `wt:rm:${tok}`)
          .text('取消', 'menu:noop')
        await ctx.reply(`⚠️ 删除 worktree <b>${esc(name)}</b>？`, { parse_mode: 'HTML', reply_markup: kb })
        return
      }
      const list = await deps.backend.listWorktreeSandboxes?.(deps.opencodeProject)
      if (!list) { await ctx.reply('当前后端不支持 worktree 查询。'); return }
      if (list.length === 0) { await ctx.reply('🌿 暂无 worktree。新建：/worktree = <名称>（beta）'); return }
      const lines = ['<b>🌿 Worktrees</b> · beta']
      for (const w of list) lines.push(`• ${esc(w.name)}${w.directory ? ` — <code>${esc(w.directory)}</code>` : ''}`)
      lines.push('新建：/worktree = <名称> · 删除：/worktree rm <名称>')
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })
  deps.bot.callbackQuery(/^wt:rm:(\d+)$/, async (ctx) => {
    const name = wtTokens.get(Number(ctx.match[1]))
    if (!name) { await ctx.answerCallbackQuery('已过期 — 重新执行 /worktree rm'); return }
    const ok = (await deps.backend.removeWorktreeSandboxes?.(deps.state.getActiveWorkspace() || deps.opencodeProject || '', name)) ?? false
    await ctx.answerCallbackQuery(ok ? '🗑 已删除' : '删除失败')
    try { await ctx.editMessageText(ok ? `🗑 worktree <b>${esc(name)}</b> 已删除。` : '删除失败。', { parse_mode: 'HTML' }) } catch { }
  })

  deps.bot.command('new', async (ctx) => {
    const dir = deps.state.getActiveWorkspace()
    if (!dir) { await ctx.reply('No active workspace. Use /workspaces first.', { parse_mode: 'HTML' }); return }
    if (!workspaceAllowed(deps, dir)) { await ctx.reply('当前工作区不在机器人的访问范围内（M9 工作区访问范围）。', { parse_mode: 'HTML' }); return }
    try {
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1).join(' ').trim() : ''
      const { id } = await deps.backend.createSession({ directory: dir, ...(text ? { title: text.slice(0, 60) } : {}) })
      deps.state.setPinnedSessionId(id)
      await ctx.reply(`🆕 <b>New session</b> in <code>${dir.split('/').pop()}</code>\n<code>…${id.slice(-8)}</code> (pinned). Send a message to start.`, { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  deps.bot.command('rename', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1).join(' ').trim() : ''
    const sid = deps.state.getPinnedSessionId() ?? deps.state.getLastSessionId()
    if (!sid) { await ctx.reply('No active session. Pin one with /sessions first.', { parse_mode: 'HTML' }); return }
    if (!text) { await ctx.reply('Usage: <code>/rename New Title</code>', { parse_mode: 'HTML' }); return }
    try {
      await deps.backend.renameSession(sid, text.slice(0, 100))
      await ctx.reply(`✏️ Renamed <code>…${sid.slice(-8)}</code> → <b>${esc(text.slice(0, 100))}</b>`, { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' })
    }
  })

  // ── P2b-M7: scheduled tasks (cross-channel; engine lives in core) ──
  deps.bot.command('tasks', async (ctx: Context) => {
    if (!deps.scheduler) { await ctx.reply('⏰ 定时任务未启用'); return }
    await renderTasks(ctx)
  })
  // grinev 命令名对齐：/tasklist = /tasks
  deps.bot.command('tasklist', async (ctx: Context) => { await renderTasks(ctx) })

  deps.bot.command('task', async (ctx: Context) => {
    if (!deps.scheduler) { await ctx.reply('⏰ 定时任务未启用'); return }
    const sched = deps.scheduler
    const msgText = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ?? ''
    const body = msgText.trim().replace(/^\/task\s*/, '')
    // /task every <N> min <prompt>   |   /task daily HH:MM <prompt>
    const every = body.match(/^every\s+(\d+)\s*(?:m|min|分钟)?\s+([\s\S]+)$/i)
    const daily = body.match(/^daily\s+([01]\d|2[0-3]):[0-5]\d\s+([\s\S]+)$/i)
    if (every) {
      const s = sched.add({ prompt: every[2], spec: { kind: 'every', minutes: Number(every[1]) }, name: every[2].slice(0, 24) })
      await ctx.reply(s ? `⏰ 已创建：每 ${every[1]} 分钟\n<code>${esc(s.prompt.slice(0, 80))}</code>\nID: ${s.id}` : '创建失败', { parse_mode: 'HTML' })
      return
    }
    if (daily) {
      const time = body.match(/daily\s+([01]\d|2[0-3]):[0-5]\d/i)![1]
      const s = sched.add({ prompt: daily[2], spec: { kind: 'daily', time }, name: daily[2].slice(0, 24) })
      await ctx.reply(s ? `⏰ 已创建：每天 ${time}\n<code>${esc(s.prompt.slice(0, 80))}</code>\nID: ${s.id}` : '创建失败', { parse_mode: 'HTML' })
      return
    }
    await ctx.reply('用法：/task every 30m <提示词>\n      /task daily 09:00 <提示词>')
  })

  deps.bot.command('taskdel', async (ctx: Context) => {
    const sched = deps.scheduler
    if (!sched) { await ctx.reply('⏰ 定时任务未启用'); return }
    const id = (ctx.message && 'text' in ctx.message ? ctx.message.text ?? '' : '').replace(/^\/taskdel\s*/, '').trim()
    if (!id) { await ctx.reply('用法：/taskdel <ID>'); return }
    const ok = sched.remove(id)
    await ctx.reply(ok ? `🗑 已删除 ${id}` : `未找到 ${id}`)
  })

  const renderTasks = async (ctx: Context) => {
    const list = deps.scheduler!.list()
    if (list.length === 0) { await ctx.reply('⏰ 没有定时任务。用 /task 创建：\n/task every 30m <提示词>\n/task daily 09:00 <提示词>'); return }
    const lines = ['<b>⏰ 定时任务</b>']
    const rows: TgBtn[][] = []
    for (const s of list) {
      const spec = s.spec.kind === 'every' ? `每 ${s.spec.minutes} 分钟` : `每天 ${s.spec.time}`
      const on = s.enabled ? '🟢' : '⏸'
      lines.push(`${on} <b>${esc(s.name)}</b>\n   ${spec} · ${s.id}`)
      rows.push([
        btn(s.enabled ? '⏸' : '▶', `task:toggle:${s.id}`),
        btn('🗑', `task:del:${s.id}`),
      ])
    }
    await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML', ...inlineKeyboard(rows) })
  }

  deps.bot.callbackQuery(/^task:toggle:(.+)$/, async (ctx) => {
    if (!deps.scheduler) return
    const id = ctx.match![1]
    const s = deps.scheduler.list().find((x) => x.id === id)
    if (s) deps.scheduler.setEnabled(id, !s.enabled)
    await ctx.answerCallbackQuery(s?.enabled === false ? '▶ 已启用' : '⏸ 已停用')
    await renderTasks(ctx)
  })

  deps.bot.callbackQuery(/^task:del:(.+)$/, async (ctx) => {
    if (!deps.scheduler) return
    const id = ctx.match![1]
    deps.scheduler.remove(id)
    await ctx.answerCallbackQuery('已删除')
    await renderTasks(ctx)
  })

  const commands = [
    { command: 'start', description: 'Handshake and health' },
    { command: 'status', description: 'Server + last session' },
    { command: 'sessions', description: 'List all sessions' },
    { command: 'session', description: 'Pin a session' },
    { command: 'files', description: 'Files touched in last session' },
    { command: 'diff', description: 'Pending git diff' },
    { command: 'todo', description: 'Session todo list' },
    { command: 'context', description: 'Tokens + cost + model' },
    { command: 'agent', description: 'Set next agent' },
    { command: 'model', description: 'Set next model' },
    { command: 'current', description: 'Last session used' },
    { command: 'abort', description: 'Stop the current generation' },
    { command: 'tasks', description: 'Scheduled tasks (list)' },
    { command: 'task', description: 'Create a scheduled task' },
    { command: 'taskdel', description: 'Delete a scheduled task' },
    { command: 'projects', description: 'Switch project (workspace)' },
    { command: 'commands', description: 'List opencode custom commands' },
    { command: 'mcps', description: 'MCP server status' },
    { command: 'messages', description: 'Recent messages' },
    { command: 'detach', description: 'Unpin the followed session' },
    { command: 'version', description: 'Bot version + uptime' },
    { command: 'pair', description: 'Pair a device (URL + token)' },
    { command: 'workspaces', description: 'List/switch workspaces' },
    { command: 'new', description: 'New session in active workspace' },
    { command: 'rename', description: 'Rename the pinned/last session' },
    { command: 'channels', description: 'Bot channel status' },
    { command: 'subs', description: 'List subagents of the session' },
    { command: 'mode', description: 'Switch the session mode (build/plan…)' },
    { command: 'cleanup', description: 'Delete finished subagent sessions' },
    { command: 'help', description: 'Show help' },
  ]

  // Register the same command list for every scope so a stale or competing bot
  // instance cannot shadow the default menu with a narrower (e.g. private-chat)
  // scope that only exposes a subset of commands.
  const scopes: Array<{ type: 'default' } | { type: 'all_private_chats' } | { type: 'all_group_chats' }> = [
    { type: 'default' },
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
  ]
  for (const scope of scopes) {
    const label = scope.type === 'default' ? 'default' : scope.type
    const extra = scope.type === 'default' ? undefined : { scope }
    deps.bot.api
      .setMyCommands(commands, extra)
      .then(() => log.info(`setMyCommands OK [${label}]`))
      .catch((err) => log.warn(`setMyCommands [${label}] failed`, err))
  }

  // ── Callbacks ──

  deps.bot.callbackQuery(/^session:pin:(.+)$/, async (ctx) => {
    const id = ctx.match[1]
    deps.state.setPinnedSessionId(id)
    await ctx.answerCallbackQuery(`Pinned ${id.slice(-8)}`)
    try {
      await ctx.editMessageText(
        `<b>📌 Pinned</b>\n\n<code>${id}</code>`,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('session:pin edit failed', msg)
    }
  })

  deps.bot.callbackQuery('session:unpin', async (ctx) => {
    deps.state.setPinnedSessionId(undefined)
    await ctx.answerCallbackQuery('Unpinned')
    try {
      await ctx.editMessageText(
        '<b>📌 Session unpinned</b>\n\nMessages will use the most recently active session.',
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('session:unpin edit failed', msg)
    }
  })

  deps.bot.callbackQuery('status:refresh', async (ctx) => {
    const { lines, buttons } = await buildStatusCard(deps)
    try {
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        ...inlineKeyboard([buttons]),
      })
      await ctx.answerCallbackQuery('Refreshed')
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('message is not modified')) {
        await ctx.answerCallbackQuery('Status is unchanged')
      } else {
        log.warn('status:refresh edit failed', msg)
        await ctx.answerCallbackQuery('Failed to refresh')
      }
    }
  })

  deps.bot.callbackQuery('status:abort', async (ctx) => {
    const sid = deps.abortGeneration()
    if (sid) {
      try {
        await deps.backend.abort(sid)
      } catch {}
    }
    await ctx.answerCallbackQuery('Aborting…')
    try {
      await ctx.editMessageText('🛑 Generation aborted.', { parse_mode: 'HTML' })
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('status:abort edit failed', msg)
    }
  })

  deps.bot.callbackQuery(/^agent:set:(.+)$/, async (ctx) => {
    const name = ctx.match[1]
    log.info(`agent:set callback: ${name}`)
    deps.state.setNextAgent(name)
    // Sync model to whatever this agent is bound to in opencode.jsonc, so the
    // user doesn't end up running a new agent against a stale /model override.
    let modelSuffix = ''
    try {
      const agents = await deps.backend.getAgents(deps.opencodeProject)
      const a = agents.find((x) => x.name === name)
      const parsed = a ? parseAgentModel(a.model) : undefined
      if (parsed) {
        deps.state.setNextModel(parsed)
        modelSuffix = ` · <code>${parsed.modelID}</code>`
      }
    } catch (err) {
      log.warn(`agent:set model sync failed: ${(err as Error).message}`)
    }
    await ctx.answerCallbackQuery(`Agent → ${name}`)
    try {
      await ctx.editMessageText(
        `<b>🤖 Agent set</b>\n\nNext message will use <b>${name}</b>${modelSuffix}.`,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('agent:set edit failed', msg)
    }
  })

  deps.bot.callbackQuery('agent:clear', async (ctx) => {
    deps.state.setNextAgent(undefined)
    await ctx.answerCallbackQuery('Agent cleared')
    try {
      await ctx.editMessageText(
        '<b>🤖 Agent cleared</b>\n\nNext message will use the default agent.',
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('agent:clear edit failed', msg)
    }
  })

  deps.bot.callbackQuery(/^model:set:(.+)$/, async (ctx) => {
    const key = modelTokens.get(ctx.match[1])
    if (!key) {
      await ctx.answerCallbackQuery('Stale — re-run /model')
      return
    }
    const idx = key.indexOf('/')
    const providerID = key.slice(0, idx)
    const modelID = key.slice(idx + 1)
    log.info(`model:set callback: provider=${providerID} model=${modelID}`)
    const parsed = { providerID, modelID }
    deps.state.setNextModel(parsed)
    await ctx.answerCallbackQuery(`Model → ${modelID}`)
    try {
      await ctx.editMessageText(
        `<b>⚙️ Model set</b>\n\nNext message will use <code>${providerID}/${modelID}</code>.`,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('model:set edit failed', msg)
    }
  })

  deps.bot.callbackQuery('model:clear', async (ctx) => {
    deps.state.setNextModel(undefined)
    await ctx.answerCallbackQuery('Model cleared')
    try {
      await ctx.editMessageText(
        '<b>⚙️ Model cleared</b>\n\nNext message will use the default model.',
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('message is not modified')) log.warn('model:clear edit failed', msg)
    }
  })

  // Step 2: pick a specific model after selecting a provider
  deps.bot.callbackQuery(/^model:pick:(.+)$/, async (ctx) => {
    const providerID = ctx.match[1]
    try {
      const providers = await deps.backend.getModels(deps.opencodeProject)
      const provider = providers.find(p => p.id === providerID)
      if (!provider || (provider.models ?? []).length === 0) {
        await ctx.answerCallbackQuery('No models for this provider')
        return
      }

      const nextModel = deps.state.getNextModel()
      const lines = [
        `<b>⚙️ Model — ${provider.name}</b>`,
        '',
      ]
      const rows: Array<Array<TgBtn>> = []

      for (const m of (provider.models ?? [])) {
        const sel = nextModel?.providerID === providerID && nextModel?.modelID === m.id ? '●' : '○'
        lines.push(`${sel} ${m.name ?? m.id}`)
        rows.push([btn(m.name ?? m.id, `model:set:${modelToken(providerID, m.id)}`)])
      }

      rows.push([btn('◀ Back', 'model:back')])

      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        ...inlineKeyboard(rows),
      })
      await ctx.answerCallbackQuery()
    } catch (err) {
      log.error('model:pick failed', err as Error)
      await ctx.answerCallbackQuery('Failed to load models')
    }
  })

  // Back to provider list
  deps.bot.callbackQuery('model:back', async (ctx) => {
    try {
      const providers = await deps.backend.getModels(deps.opencodeProject)
      const nextModel = deps.state.getNextModel()
      const lines = ['<b>⚙️ Model — Select provider</b>', '']
      const rows: Array<Array<TgBtn>> = []

      for (const p of providers) {
        const count = (p.models ?? []).length
        const hasSelected = nextModel?.providerID === p.id
        const marker = hasSelected ? '●' : '▸'
        lines.push(`${marker} <b>${p.name}</b>  ·  ${count} model${count !== 1 ? 's' : ''}`)
        rows.push([btn(p.name, `model:pick:${p.id}`)])
      }

      if (nextModel) {
        lines.push('', `<i>Current override: ${nextModel.providerID}/${nextModel.modelID}</i>`)
      }
      rows.push([btn('✕ Clear', 'model:clear')])

      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        ...inlineKeyboard(rows),
      })
      await ctx.answerCallbackQuery()
    } catch (err) {
      log.error('model:back failed', err as Error)
      await ctx.answerCallbackQuery('Failed')
    }
  })

  deps.bot.callbackQuery('card:dismiss', async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.deleteMessage().catch(() => {})
  })

  // ── Info commands (split to separate file) ──
  registerInfoCommands({ bot: deps.bot, backend: deps.backend, state: deps.state, opencodeProject: deps.opencodeProject })

  // ── Approval callbacks — always registered so buttons work in both modes ──
  deps.bot.callbackQuery(/^approve:(once|always|reject):(.+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray
    const response = match[1] as ApprovalResponse
    // callback_data carries a short token (64-byte limit); resolve it back to
    // the permission id. Fall back to the raw value for pre-token cards.
    const permId = deps.approvalTokens.get(match[2]) ?? match[2]
    const p = deps.pendingApprovals.get(permId)

    if (!p) {
      await ctx.answerCallbackQuery('This request has already been handled.')
      return
    }

    // Delete BEFORE resolving: a fast double-click must see "already handled"
    // on the second tap instead of racing the resolvePermission call.
    deps.pendingApprovals.delete(permId)

    try {
      await deps.backend.resolvePermission(p.sessionId, p.permissionId, response)
    } catch (err) {
      log.error(`failed to reply permission ${permId}`, err as Error)
      await ctx.answerCallbackQuery('Failed to reply. The request may have expired.')
      return
    }

    const labels: Record<ApprovalResponse, string> = {
      once: 'Allowed (once)',
      always: 'Always Allowed',
      reject: 'Rejected',
    }
    const display = labels[response]
    await ctx.editMessageText(`${display}\n\n${esc(p.title)}`, { parse_mode: 'HTML' }).catch(() => {})
    await ctx.answerCallbackQuery(display)
  })
}

// ── Approval sub-module ──

export interface PendingApproval {
  sessionId: string
  permissionId: string
  messageId: number
  title: string
  /** Epoch ms when the approval card was sent — used by the TTL sweep. */
  createdAt: number
}

export type ApprovalResponse = 'once' | 'always' | 'reject'
