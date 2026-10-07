// zcode-services/zcodeSessionService.ts — ocrc-backed IZCodeSessionService (N2).
// 主会话时间线的数据入口：readSession/readSessionMessages 把 ocrc 历史 cards
// 映射成 ZCode 会话状态快照（ZCodeSessionStateSnapshot 族）。形状深（zod strict
// 嵌套），构造时以「UI 实际读取的字段」为准逐个填充；未接方法走兜底代理。

interface OcrcSessionSummary {
  id: string
  title: string
  lastActiveAt: number
  directory?: string
  model?: string
  unread?: boolean
  error?: boolean
}

interface OcrcBlock { type: string; text?: string; tool?: string; args?: string; status?: string }
interface OcrcCard { kind: string; text?: string; ts?: number; blocks?: OcrcBlock[]; meta?: { model?: string } }

const SUBSCRIBE_RE = /^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function ocrcSessions(): Promise<OcrcSessionSummary[]> {
  const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) return []
  return (await res.json()) as OcrcSessionSummary[]
}

async function ocrcHistory(taskId: string): Promise<OcrcCard[]> {
  const res = await fetch(`/api/session/${taskId}?limit=200`, {
    headers: { Authorization: `Bearer ${token()}` },
  })
  if (!res.ok) return []
  return ((await res.json()) as { cards: OcrcCard[] }).cards ?? []
}

function findSession(taskId: string, sessions: OcrcSessionSummary[]): OcrcSessionSummary | undefined {
  return sessions.find((x) => x.id === taskId)
}

function workspaceOf(s: OcrcSessionSummary | undefined) {
  const workspacePath = s?.directory ?? '/home/demo/develop/opencode-plugin/ocrc'
  return { workspacePath, workspaceKey: workspacePath }
}

function cardsToMessages(sessionId: string, cards: OcrcCard[]): any[] {
  let n = 0
  const out: any[] = []
  for (const c of cards) {
    const messageId = c.kind === 'user' ? `msg-user-${n++}` : `msg-assistant-${n++}`
    const time = { created: c.ts ?? Date.now(), completed: c.ts ?? Date.now() }
    if (c.kind === 'user') {
      out.push({
        info: {
          messageId, sessionId, role: 'user', time,
          agent: 'ocrc',
        },
        parts: [{ partId: `${messageId}-p0`, sessionId, messageId, type: 'text', text: c.text ?? '' }],
      })
    } else if (c.kind === 'assistant' && c.blocks) {
      const parts: any[] = []
      let toolIdx = 0
      for (const b of c.blocks) {
        const pid = `${messageId}-p${parts.length}`
        if (b.type === 'text') {
          parts.push({ partId: pid, sessionId, messageId, type: 'text', text: b.text ?? '' })
        } else if (b.type === 'reasoning') {
          parts.push({ partId: pid, sessionId, messageId, type: 'reasoning', text: b.text ?? '' })
        } else if (b.type === 'tool') {
          const failed = b.status === 'error'
          parts.push({
            partId: pid, sessionId, messageId, type: 'tool',
            callId: `${messageId}-t${toolIdx++}`,
            tool: b.tool ?? 'tool',
            state: failed
              ? { status: 'error', input: safeJson(b.args), error: b.args?.slice(0, 300) ?? '', title: b.tool ?? '' }
              : { status: 'completed', input: safeJson(b.args), output: typeof b.args === 'string' ? b.args : JSON.stringify(b.args ?? ''), title: b.tool ?? '', metadata: {} },
          })
        }
      }
      if (parts.length === 0) continue
      out.push({
        info: {
          messageId, sessionId, role: 'assistant', time,
          parentMessageId: messageId,
          agent: 'ocrc',
          path: { cwd: sessionId, root: sessionId },
          cost: 0,
          tokens: {},
        },
        parts,
      })
    }
  }
  return out
}

function safeJson(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === 'object') return v as Record<string, unknown>
  try { return JSON.parse(v as string) as Record<string, unknown> } catch { return { raw: String(v) } }
}

export function createOcrcZcodeSessionService(): any {
  const impl: Record<string, unknown> = {
    initializeWorkspace: async (params: { workspacePath?: string }) => ({
      workspacePath: params?.workspacePath ?? '/home/demo/develop/opencode-plugin/ocrc',
      available: true,
    }),
    getWorkspaceRuntimeIdentity: async (params: { workspacePath?: string }) => ({
      workspacePath: params?.workspacePath ?? '',
      identity: undefined,
    }),
    readWorkspacePresentation: async () => ({ workspaces: [], recentProjects: [] }),
    listSessions: async () => {
      const sessions = await ocrcSessions()
      return sessions.map((s) => ({
        sessionId: s.id,
        title: s.title || '(未命名)',
        status: 'idle',
        updatedAt: s.lastActiveAt,
      }))
    },
    readSession: async (params: { sessionId: string; workspacePath?: string }) => {
      const [cards, sessions] = await Promise.all([ocrcHistory(params.sessionId), ocrcSessions()])
      const s = findSession(params.sessionId, sessions)
      const ws = workspaceOf(s)
      const messages = cardsToMessages(params.sessionId, cards)
      const last = cards[cards.length - 1]
      return {
        protocol: { name: 'zcode', version: 4 },
        session: {
          sessionId: params.sessionId,
          workspace: ws,
          sessionKind: 'task',
          title: s?.title || '(未命名)',
          mode: 'build',
          status: 'idle',
          createdAt: s?.lastActiveAt ?? Date.now(),
          updatedAt: s?.lastActiveAt ?? Date.now(),
        },
        settings: {
          model: { current: undefined, available: [], lastUsed: undefined },
          thoughtLevel: { enabled: false, available: [] },
          mode: { current: 'build' },
        },
        projection: {
          sessionId: params.sessionId,
          status: 'idle',
          mode: 'build',
          turnCount: messages.filter((m) => m.info.role === 'user').length,
          totalTokenCount: 0,
          contextUsed: 0,
          contextWindow: 0,
          pendingPermissions: [],
          activeToolCalls: [],
          backgroundJobs: [],
        },
        runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
        messages,
        eventId: `ocrc-${params.sessionId}`,
        sessionId: params.sessionId,
        seq: 0,
        timestamp: last?.ts ?? Date.now(),
      }
    },
    readSessionMessages: async (params: { sessionId: string }) => {
      const cards = await ocrcHistory(params.sessionId)
      return cardsToMessages(params.sessionId, cards)
    },
    readSessionEvents: async () => [],
    resumeSession: async (params: { sessionId?: string; workspacePath?: string }) => {
      const sessions = await ocrcSessions()
      const s = findSession(params.sessionId ?? '', sessions)
      const snapshot = await (impl.readSession as any)({ sessionId: params.sessionId ?? '', workspacePath: params.workspacePath })
      void s
      return snapshot
    },
    createSession: async (params: { workspacePath?: string }) => {
      const created = await fetch('/api/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ directory: params.workspacePath }),
      }).then((r) => r.json()).catch(() => ({ id: '' }))
      return { sessionId: created.id, title: '', mode: 'build', status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
    },
    closeSession: async () => {},
    closeDeferredDraftSession: async () => false,
    promoteDeferredDraftSession: async () => {},
    setModel: async () => ({}),
    setThoughtLevel: async () => ({}),
    setMode: async () => ({}),
  }
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const name = String(prop)
      if (SUBSCRIBE_RE.test(name)) {
        return (_listener?: unknown) => {
          const un: any = () => {}
          un.dispose = () => {}
          return un
        }
      }
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`[ocrc-fork] zcodeSessionService.${name} 尚未接入 ocrc`))
    },
  })
}
