/**
 * V2AgentBackend — the opencode V2 host implementation of AgentBackend.
 *
 * Talks to the host through the V2 plugin context domains (session/permission)
 * instead of the V1 SDK client. Capabilities are declared honestly: everything
 * the V2 ctx does not yet expose (diff/todos/catalog/mcp/commands/workspaces/
 * TUI navigation) is flagged off so the UI degrades gracefully — matching the
 * plan's "只做展示+回批" boundary and the regression rule that any capability
 * change must be re-verified on BOTH hosts.
 */
import type {
  AgentBackend, AgentInfo, BackendCapabilities, CommandInfo,
  DiffEntry, McpServer, ModelProvider, PromptInput, SessionContext,
  SessionMeta, SessionRef, SessionSummary, Workspace,
} from './backend.js'
import type { ContentBlock, StructuredCard } from '../structured-card.js'
import type { V2Context, V2SessionInfo } from '../../plugin/v2/types.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('v2-backend')

const CAPABILITIES: BackendCapabilities = {
  liveMirror: true,      // in-process: the host IS the local session runner
  tuiSelect: false,      // no TUI navigation in V2 ctx
  workspaces: false,     // P2a: directory routing
  freeformWorkspace: false,
  diff: false,
  todos: false,
  catalog: false,        // ctx has no models/agents enumeration slice (yet)
  mcp: false,
  commands: false,
  sessionControls: false,
  imageInput: false,
}

function msTime(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : undefined }
  return undefined
}

function mapSessionInfo(info: V2SessionInfo): { agent?: string; model?: string; cost?: number; tokens?: { input: number; output: number } } {
  const model = typeof info.model === 'string' ? info.model : info.model ? [info.model.providerID, info.model.modelID].filter(Boolean).join('/') : undefined
  const tokens = info.tokens && (info.tokens.input !== undefined || info.tokens.output !== undefined)
    ? { input: Number(info.tokens.input ?? 0), output: Number(info.tokens.output ?? 0) }
    : undefined
  return {
    agent: typeof info.agent === 'string' ? info.agent : undefined,
    model: model || undefined,
    cost: typeof info.cost === 'number' ? info.cost : undefined,
    tokens,
  }
}

export function createV2Backend(ctx: V2Context): { backend: AgentBackend; observeSessionEvent(ev: { type?: string; sessionID?: string; title?: string }): void } {
  /** Sessions seen on the event stream — V2 ctx has no session.list. Seeded by
   *  create/get calls and kept fresh by the control-plane's event feed. */
  const seen = new Map<string, { id: string; title?: string; updatedAt: number; agent?: string }>()

  const remember = (info: V2SessionInfo | undefined) => {
    const id = info?.id
    if (typeof id !== 'string' || !id) return
    seen.set(id, {
      id,
      title: typeof info.title === 'string' ? info.title : seen.get(id)?.title,
      updatedAt: Date.now(),
      agent: typeof info.agent === 'string' ? info.agent : seen.get(id)?.agent,
    })
  }

  const backend: AgentBackend = {
    id: 'opencode',
    capabilities: CAPABILITIES,

    async prompt(sessionId: string, input: PromptInput): Promise<void> {
      await ctx.session.prompt({ sessionID: sessionId, id: { text: input.text } })
    },

    async abort(id: string): Promise<void> {
      await ctx.session.interrupt({ sessionID: id })
    },

    async hasSession(id: string): Promise<boolean> {
      if (seen.has(id)) return true
      try {
        remember(await ctx.session.get({ sessionID: id }))
        return true
      } catch {
        return false
      }
    },

    async listSessions(): Promise<SessionRef[]> {
      return [...seen.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }))
    },

    async listSessionSummaries(): Promise<SessionSummary[]> {
      return [...seen.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({ id: s.id, title: s.title, agent: s.agent, lastActiveAt: s.updatedAt, unread: false }))
    },

    async createSession(opts: { directory: string; title?: string }): Promise<{ id: string }> {
      const info = (await ctx.session.create({
        id: { title: opts.title },
        ...(opts.directory ? { location: { directory: opts.directory } } : {}),
      })) as V2SessionInfo
      remember(info)
      return { id: String(info?.id ?? '') }
    },

    async deleteSession(_id: string): Promise<void> {
      // V2 ctx does not expose session removal (yet).
      throw new Error('session deletion is not supported on opencode V2 hosts yet')
    },

    async renameSession(id: string, title: string): Promise<void> {
      await ctx.session.rename({ sessionID: id, id: { title } })
      const s = seen.get(id)
      if (s) s.title = title
    },

    async getSessionMeta(id: string): Promise<SessionMeta> {
      remember(await ctx.session.get({ sessionID: id }))
      return mapSessionInfo(await ctx.session.get({ sessionID: id }))
    },

    async getContext(id: string): Promise<SessionContext> {
      const info = await ctx.session.get({ sessionID: id })
      remember(info)
      return { ...mapSessionInfo(info), directory: info.directory }
    },

    // ── reads not exposed by the V2 ctx — honest empties (capability-gated) ──
    async getHistory(_id: string, _limit?: number): Promise<StructuredCard[]> {
      return []
    },
    async getMessageBlocks(_sessionId: string, _messageId: string): Promise<ContentBlock[]> {
      return []
    },
    async getDiff(_id: string): Promise<DiffEntry[]> {
      return []
    },
    async getTodos(_id: string): Promise<unknown[]> {
      return []
    },
    async getSessionsStatus(): Promise<unknown> {
      const all = [...seen.values()]
      return { sessions: all.length, busy: 0, backend: 'opencode-v2' }
    },
    async ping(): Promise<boolean> {
      // In-process: the host is alive iff we are.
      return true
    },

    // ── catalog / commands ──
    async getAgents(_directory?: string): Promise<AgentInfo[]> {
      return []
    },
    async getModels(_directory?: string): Promise<ModelProvider[]> {
      return []
    },
    async getMcp(_directory?: string): Promise<McpServer[]> {
      return []
    },
    async listWorkspaces(): Promise<Workspace[]> {
      return []
    },
    async listCommands(): Promise<CommandInfo[]> {
      return []
    },
    async runCommand(_id: string, _command: string, _args?: string): Promise<void> {
      throw new Error('slash-commands are not supported on opencode V2 hosts yet')
    },

    // ── permissions ──
    async resolvePermission(id: string, requestId: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
      // V2 PermissionReply is exactly "once" | "always" | "reject" — same
      // semantics as V1/OCRC, zero mapping (docs/v2-api-notes.md §3).
      await ctx.permission.reply({ sessionID: id, requestID: requestId, reply: decision })
    },
  }

  /** Session-registry maintenance, fed by the control plane's event loop. */
  function observeSessionEvent(ev: { type?: string; sessionID?: string; title?: string }): void {
    if (!ev.sessionID) return
    if (ev.type === 'session.deleted') {
      seen.delete(ev.sessionID)
      return
    }
    if (ev.type === 'session.created' || ev.type === 'session.updated' || ev.type === 'session.renamed') {
      const prev = seen.get(ev.sessionID)
      seen.set(ev.sessionID, {
        id: ev.sessionID,
        title: ev.title ?? prev?.title,
        agent: (ev as any).agent ?? prev?.agent,
        updatedAt: Date.now(),
      })
    }
  }

  return { backend, observeSessionEvent }
}
