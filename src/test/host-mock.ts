import type {
  AttachIssueRequest, ComposeRequest, GuestItem, GuestProject, GuestRequestResult,
  GuestStatusControl, GuestStatusControlEvent, HostClient, HostReadyContext, HostTheme,
  ResolveRequest, StartSessionRequest, StartSessionResult,
} from '@openchamber/sdk'

/** A full host theme. Every token must be present: `applyHostTheme` writes the
 *  whole table onto the root, so a partial one would not resemble a real host. */
export const THEME: HostTheme = {
  mode: 'dark',
  tokens: {
    background: '#0e0e10', elevated: '#1c1c1f', foreground: '#e8e8e8', muted: '#9a9aa0',
    subtle: '#2a2a2e', border: '#33333a', hover: '#26262b', selection: '#3a2a1c',
    focus: '#fb8b3c', primary: '#fb8b3c', mutedSurface: '#16161a', elevatedForeground: '#e8e8e8',
    active: '#2f2f35', selectionForeground: '#fb8b3c', primaryForeground: '#211307',
    primaryText: '#fb8b3c', successText: '#6ee7a0', warningText: '#ffd479', errorText: '#f97066',
    infoText: '#8ab4ff', success: '#6ee7a0', warning: '#ffd479', error: '#f97066', info: '#8ab4ff',
    font: 'system-ui, sans-serif', mono: 'ui-monospace, monospace', radius: '9px',
  },
}

export type RouteResult = { status?: number; body: unknown }

/** A `HostClient` stand-in: only the surface the panel actually touches, with
 *  every host-driven callback captured so a test can drive them by hand. */
export interface FakeHost {
  client: HostClient
  requests: Array<{ method: string; path: string; body?: unknown }>
  badges: Array<number | null>
  heights: number[]
  controls: GuestStatusControl[][]
  toasts: string[]
  storage: Map<string, unknown>
  /** 命令通道：注册的 onResolve 处理者存在吗 + 直接调它。 */
  hasResolver: () => boolean
  resolve: (request: ResolveRequest) => Promise<AttachIssueRequest | null>
  /** 交接通道：attach / compose / startSession 的调用记录与可配置返回值。 */
  attached: AttachIssueRequest[]
  composed: ComposeRequest[]
  started: StartSessionRequest[]
  projects: GuestProject[]
  startResult: StartSessionResult
  emitReady: (override?: Partial<HostReadyContext>) => void
  emitDirectory: (directory: string | null) => void
  emitItem: (item: GuestItem | null) => void
  emitStatusControl: (event: GuestStatusControlEvent) => void
}

export function makeHost(
  routes: Record<string, RouteResult> = {},
  options: { projects?: GuestProject[]; startResult?: StartSessionResult } = {},
): FakeHost {
  const requests: FakeHost['requests'] = []
  const badges: FakeHost['badges'] = []
  const heights: FakeHost['heights'] = []
  const controls: FakeHost['controls'] = []
  const toasts: FakeHost['toasts'] = []
  const storage = new Map<string, unknown>()
  const readyListeners = new Set<(ctx: HostReadyContext) => void>()
  const directoryListeners = new Set<(d: string | null) => void>()
  const itemListeners = new Set<(i: GuestItem | null) => void>()
  const statusListeners = new Set<(e: GuestStatusControlEvent) => void>()
  const attached: AttachIssueRequest[] = []
  const composed: ComposeRequest[] = []
  const started: StartSessionRequest[] = []
  let resolveHandler: ((request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) | null = null

  const projects: GuestProject[] = options.projects ?? []
  const startResult: StartSessionResult = options.startResult
    ?? { sessionId: 'ses-1', sent: 'sent', directory: '/srv/proj' }

  const base = {
    theme: THEME,
    locale: 'zh-CN',
    directory: '/srv/proj',
    session: null,
    surface: 'panel' as const,
    connection: { connected: true, account: 'me' },
    settings: {},
    item: null,
  }

  /**
   * Route lookup. `'POST /remote-instance#up'` matches only when the parsed body
   * carries `op: 'up'`: one endpoint multiplexing several ops (the instance ops
   * face) needs per-op answers, and a single route per path cannot express "the
   * list works but 启动 fails".
   */
  const answer = (key: string, lang: string, body?: unknown): GuestRequestResult => {
    const op = body && typeof body === 'object' ? (body as { op?: unknown }).op : undefined
    const route = (op === undefined ? undefined : routes[`${lang} ${key}#${String(op)}`])
      ?? routes[`${lang} ${key}`]
      ?? routes[key]
    if (!route) return { status: 404, body: JSON.stringify({ error: `no route: ${lang} ${key}` }) }
    return { status: route.status ?? 200, body: JSON.stringify(route.body) }
  }

  const client = {
    onReady: (listener: (ctx: HostReadyContext) => void) => {
      readyListeners.add(listener)
      listener({ ...base })
      return () => readyListeners.delete(listener)
    },
    onDirectory: (listener: (d: string | null) => void) => {
      directoryListeners.add(listener)
      return () => directoryListeners.delete(listener)
    },
    onItem: (listener: (i: GuestItem | null) => void) => {
      itemListeners.add(listener)
      return () => itemListeners.delete(listener)
    },
    onStatusControl: (listener: (e: GuestStatusControlEvent) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    onResolve: (handler: (request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) => {
      resolveHandler = handler
      return () => { if (resolveHandler === handler) resolveHandler = null }
    },
    listProjects: async () => ({ kind: 'projects', state: 'ready', projects }),
    attach: async (request: AttachIssueRequest) => { attached.push(request) },
    compose: async (request: ComposeRequest) => { composed.push(request) },
    startSession: async (request: StartSessionRequest) => { started.push(request); return startResult },
    serviceRequest: async (request: { method?: string; path: string; body?: string }) => {
      const method = request.method ?? 'GET'
      let body: unknown
      if (request.body !== undefined) body = JSON.parse(request.body)
      requests.push({ method, path: request.path, body })
      return answer(request.path, method, body)
    },
    storage: {
      get: async (key: string) => storage.get(key) as never,
      set: async (key: string, value: unknown) => { storage.set(key, value) },
      delete: async (key: string) => { storage.delete(key) },
      keys: async () => [...storage.keys()],
    },
    setBadge: async (count: number | null) => { badges.push(count) },
    setHeight: async (height: number) => { heights.push(height) },
    setStatusControls: async (next: GuestStatusControl[]) => { controls.push(next) },
    toast: async (request: { message: string }) => { toasts.push(request.message) },
    openSession: async () => { /* recorded by request-free tests only */ },
  }

  return {
    client: client as unknown as HostClient,
    requests, badges, heights, controls, toasts, storage,
    attached, composed, started, projects, startResult,
    hasResolver: () => resolveHandler !== null,
    resolve: async (request) => {
      if (!resolveHandler) throw new Error('no onResolve handler registered')
      return resolveHandler(request)
    },
    emitReady: (override) => { for (const l of readyListeners) l({ ...base, ...override }) },
    emitDirectory: (d) => { for (const l of directoryListeners) l(d) },
    emitItem: (i) => { for (const l of itemListeners) l(i) },
    emitStatusControl: (e) => { for (const l of statusListeners) l(e) },
  }
}
