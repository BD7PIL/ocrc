import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import type { BackendRegistry } from '../../core/agent/registry.js'
import type { SessionState } from '../../core/state.js'
import type { CardBus } from '../../core/card-bus.js'
import type { GoalManager } from '../../core/goal.js'
import type { IncomingMessage } from '../../core/types.js'
import type { AuthStrategy } from '../../connectivity/auth/index.js'
import { createLogger } from '../../utils/logger.js'
import { hostname } from 'node:os'

const log = createLogger('web')

declare module 'hono' {
  interface ContextVariableMap {
    user: { email: string; sub: string }
  }
}
import { registerSessions } from './routes/sessions.js'
import { registerSession } from './routes/session.js'
import { registerMessage } from './routes/message.js'
import { registerAbort } from './routes/abort.js'
import { registerVcs, registerRevert, registerFork } from './routes/vcs.js'
import { registerTodo } from './routes/todo.js'
import { registerControls } from './routes/controls.js'
import { registerTaskGroups } from './routes/task-groups.js'
import { registerFiles } from './routes/files.js'
import { registerContext } from './routes/context.js'
import { registerApproval } from './routes/approval.js'
import { registerQuestion } from './routes/question.js'
import { registerVersion } from './routes/version.js'
import { registerLogs } from './routes/logs.js'
import { registerMcp } from './routes/mcp.js'
import { registerCatalog } from './routes/catalog.js'
import { registerOverrides } from './routes/overrides.js'
import { registerOffPeak } from './routes/offpeak.js'
import { registerGoal } from './routes/goal.js'
import { registerWorkspaces } from './routes/workspaces.js'
import { registerCreateSession } from './routes/create-session.js'
import { registerCommands } from './routes/commands.js'
import { registerRename } from './routes/rename.js'
import { registerPolicy } from './routes/policy.js'
import { registerSettings } from './routes/settings.js'
import { registerSettingsProject } from './routes/settings-project.js'
import { globalConfigPath } from '../../core/settings-service.js'
import { registerSharePublic, registerShareAuthed } from './routes/share.js'
import { registerBrowser } from './routes/browser.js'
import type { Scheduler } from '../../core/scheduler.js'
import { registerSuggestions } from './routes/suggestions.js'
import { registerSchedules } from './routes/schedules.js'
import { registerChannels } from './routes/channels.js'
import { registerRemotes } from './routes/remotes.js'
import { registerSubagents } from './routes/subagents.js'
import { registerM8 } from './routes/m8.js'
import { registerPairExchange, registerPairQr, registerPairOnboarding, registerPairReset } from './routes/pairing.js'
import { registerAttach } from './routes/attach.js'
import { registerWorkflow } from './routes/workflow.js'
import type { PairingStore } from '../../connectivity/pairing.js'

export interface BuildServerOpts {
  auth: AuthStrategy
  offpeak?: import('../../core/offpeak.js').OffPeakManager
  offpeakWindow?: import('../../core/offpeak.js').OffPeakWindow
  /** N12 session goals (optional; the goal UI degrades without it). */
  goalManager?: GoalManager
  registry: BackendRegistry
  state: SessionState
  cardBus: CardBus
  onMessage?: (msg: IncomingMessage) => Promise<void>
  /** P2b-M7 cross-channel scheduled prompts (optional; web panel hidden w/o it). */
  scheduler?: Scheduler
  /** M9 bot-channel settings store + live TG status. */
  channels?: import('../../core/channels.js').ChannelsStore
  telegramStatus?: () => { connected: boolean; username?: string } | null
  /** Boot facts for the channels panel (0.27): whether an env token exists
   *  (the panel token overrides it at boot) and the allowlist size. */
  telegramMeta?: { hasEnvToken: boolean; allowUsers: number; envTokenHint?: string }
  /** M11 pending-token pairing store (optional; QR falls back to legacy URL). */
  pairing?: PairingStore
  /** 0.26.0 SSH remote hosts: store + lifecycle manager (optional). */
  remotes?: import('../../core/remotes.js').RemotesStore
  remoteManager?: import('../../core/remote-host.js').RemoteHostManager
  /** 0.27: runtime remote registration (see WebTransportConfig). */
  onRemoteEnabled?: (r: import('../../core/remotes.js').RemoteHost) => void
  /** M5 设置域: dir containing the opencode global config (defaults inside
   *  the settings service to ~/.config/opencode). */
  settingsConfigDir?: string
  /** M5-2: presets/state dir (defaults inside the route). */
  statePath?: string
  /** M6 分享: snapshot store (public GET + authed create). */
  shares?: import('../../core/shares.js').SharesStore
  /** P0-3: port the host listens on (reported back to an ATTACHED plugin). */
  port?: number
  /** P0-3: expose the attach echo probe (OCRC_WF_PROBE=1; P0 gate only). */
  attachProbe?: boolean
  /** P2 workflow surface (runs + saved). Absent = the endpoints do not exist. */
  workflow?: import('../../core/workflow/manager.js').WorkflowManager
  workflowArtifacts?: import('../../core/workflow/artifacts.js').ArtifactStore
  workflowSaved?: import('../../core/workflow/saved.js').SavedWorkflowsStore
  /** P3: the world.run approval gate. */
  workflowApproval?: import('../../core/workflow/approval.js').WorkflowApproval
  /** P4-1a: the escalation registry (the run projection's pending questions). */
  workflowEscalations?: import('../../core/workflow/escalations.js').EscalationRegistry
}

export function buildServer(opts: BuildServerOpts): Hono {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    const t0 = Date.now()
    await next()
    log.info(`${c.req.method} ${c.req.path} → ${c.res.status} ${Date.now() - t0}ms`)
  })
  // Pairing exchange + first-run onboarding sit BEFORE the auth guard: a
  // device holding a pending token has no real token yet. The onboarding page
  // (owner decision) shows a live pending QR + channel STATUS pre-auth; the
  // pending token is the credential (5 min, single-use) and the payload never
  // includes channel credentials.
  registerPairExchange(app, opts.pairing)
  if (opts.shares) registerSharePublic(app, opts.shares)
  registerPairOnboarding(app, { pairing: opts.pairing, channels: opts.channels, telegramStatus: opts.telegramStatus })
  app.use('/api/*', opts.auth.httpMiddleware())
  app.get('/api/me', (c) => {
    const user = c.get('user') as { email: string } | undefined
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ email: user.email })
  })
  const reg = opts.registry
  // Backwards-compatible single-backend shape: the ACTIVE backend (the one new
  // sessions use). The frontend reads /api/backends for the full set + per-session
  // capabilities (each session row carries its backendId).
  app.get('/api/capabilities', (c) => {
    const active = reg.get(reg.activeId())!
    return c.json({ id: active.id, capabilities: active.capabilities })
  })
  // Multi-backend ("agents"): the full set + display name + connection status + which
  // one new sessions go to. status comes from a bounded ping per backend.
  app.get('/api/backends', async (c) => {
    const backends = await Promise.all(reg.all().map(async ({ id, backend }) => {
      let online = false
      try {
        online = await Promise.race([
          backend.ping(),
          new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
        ])
      } catch { online = false }
      return {
        id,
        name: id.startsWith('acp:') ? id.slice(4) : id,
        host: backend.host ?? hostname(),
        status: online ? 'online' : 'offline',
        capabilities: backend.capabilities,
      }
    }))
    return c.json({ backends, activeId: reg.activeId() })
  })
  app.post('/api/backends/active', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { backendId?: string }
    if (!body.backendId || !reg.has(body.backendId)) return c.json({ error: 'unknown backendId' }, 400)
    opts.state.setActiveBackend(body.backendId)
    return c.json({ ok: true, activeId: reg.activeId() })
  })
  registerSessions(app, reg, opts.state)
  registerSession(app, reg, opts.cardBus, opts.state)
  if (opts.onMessage) registerMessage(app, opts.onMessage, reg)
  registerAbort(app, reg, opts.state)
  registerVcs(app, reg)
  registerRevert(app, reg)
  registerFork(app, reg)
  registerTodo(app, reg, opts.state)
  registerControls(app, reg, opts.state)
  registerTaskGroups(app, opts.state)
  registerFiles(app, reg, opts.state)
  registerContext(app, reg, opts.state)
  registerApproval(app, reg, opts.state)
  registerQuestion(app, reg, opts.state)
  registerVersion(app)
  registerLogs(app)
  // P2: workflow runs + saved workflows. Registered only when the host wired a
  // manager — the routes are pure translations of its API.
  if (opts.workflow && opts.workflowArtifacts && opts.workflowSaved) {
    registerWorkflow(app, {
      manager: opts.workflow,
      artifacts: opts.workflowArtifacts,
      saved: opts.workflowSaved,
      registry: opts.registry,
      ...(opts.workflowApproval ? { approval: opts.workflowApproval } : {}),
      ...(opts.workflowEscalations ? { escalations: opts.workflowEscalations } : {}),
    })
  }
  // P0-3: the ATTACHED-plugin channel (status / notify / echo probe). Registered
  // for both host and plugin modes — the host is the only process that serves it.
  registerAttach(app, {
    cardBus: opts.cardBus,
    telegramStatus: opts.telegramStatus,
    webPort: opts.port ?? 0,
    probe: opts.attachProbe === true || process.env.OCRC_WF_PROBE === '1',
  })
  registerMcp(app, reg)
  registerCatalog(app, reg)
  registerOverrides(app, opts.state)
  if (opts.offpeak) registerOffPeak(app, opts.offpeak, opts.offpeakWindow ?? { start: '00:00', end: '08:00' })
  if (opts.goalManager) registerGoal(app, opts.goalManager)
  registerWorkspaces(app, reg)
  registerCreateSession(app, reg)
  registerCommands(app, reg, opts.state)
  registerRename(app, reg, opts.state)
  registerPolicy(app, opts.state)
  registerSettings(app, opts.settingsConfigDir)
  if (opts.shares) registerShareAuthed(app, opts.shares, reg)
  registerBrowser(app)
  // globalConfigRaw 是三参——此前漏传，导致 /api/settings/model-presets 的 current 恒为 {}。
  // 用 getter（每次读取时取盘），避免把启动瞬间的配置快照固化。
  registerSettingsProject(
    app,
    dirname(opts.statePath ?? join(process.env.HOME ?? '', '.ocrc', 'state.json')),
    () => {
      try {
        return readFileSync(globalConfigPath(opts.settingsConfigDir), 'utf-8')
      } catch {
        return undefined
      }
    },
  )
  if (opts.shares) registerShareAuthed(app, opts.shares, reg)
  registerBrowser(app)
  registerSuggestions(app, opts.state)
  registerSchedules(app, opts.scheduler)
  registerChannels(app, opts.channels, opts.telegramStatus, opts.telegramMeta)
  registerRemotes(app, opts.remotes, opts.remoteManager, opts.onRemoteEnabled)
  registerSubagents(app, reg, opts.state)
  registerM8(app, reg, opts.state)
  registerPairQr(app, opts.pairing)
  registerPairReset(app, { auth: opts.auth })
  return app
}
