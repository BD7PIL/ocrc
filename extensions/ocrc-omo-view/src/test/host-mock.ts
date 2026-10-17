import type {
  GuestItem, GuestProject, GuestSessionsSnapshot, GuestWorkspaceQuery,
  GuestDirectoryCoverage, HostClient, HostReadyContext, HostTheme,
} from '@openchamber/sdk'

export const THEME: HostTheme = {
  mode: 'light',
  tokens: {
    background: '#fdfdfd', elevated: '#ffffff', foreground: '#262626', muted: '#6b6b70',
    subtle: '#efeff1', border: '#d6d6d9', hover: '#f2f2f4', selection: '#fbe6d6',
    focus: '#e4580f', primary: '#e4580f', mutedSurface: '#f6f6f7', elevatedForeground: '#262626',
    active: '#e9e9ec', selectionForeground: '#8a3200', primaryForeground: '#ffffff',
    primaryText: '#e4580f', successText: '#1f7a3d', warningText: '#9a6b00', errorText: '#c2372c',
    infoText: '#2456a6', success: '#1f7a3d', warning: '#9a6b00', error: '#c2372c', info: '#2456a6',
    font: 'system-ui, sans-serif', mono: 'ui-monospace, monospace', radius: '9px',
  },
}

export interface FakeHost {
  client: HostClient
  opened: string[]
  subscriptions: GuestWorkspaceQuery[]
  emitReady: (override?: Partial<HostReadyContext>) => void
  emitDirectory: (directory: string | null) => void
  emitItem: (item: GuestItem | null) => void
  /** Sessions changed under the subscription the host opened last. */
  pushSessions: (snapshot: GuestSessionsSnapshot) => void
}

export interface FakeHostOptions {
  projects: GuestProject[]
  /** Sessions per project id. */
  sessions: Record<string, GuestSessionsSnapshot['sessions']>
  directory?: string | null
}

export function makeHost(options: FakeHostOptions): FakeHost {
  const opened: string[] = []
  const subscriptions: GuestWorkspaceQuery[] = []
  const readyListeners = new Set<(ctx: HostReadyContext) => void>()
  const directoryListeners = new Set<(d: string | null) => void>()
  const itemListeners = new Set<(i: GuestItem | null) => void>()
  let sessionListener: ((snapshot: GuestSessionsSnapshot) => void) | null = null

  const base: HostReadyContext = {
    theme: THEME,
    locale: 'zh-CN',
    directory: options.directory === undefined ? options.projects[0]?.directory ?? null : options.directory,
    session: null,
    surface: 'panel',
    connection: { connected: true, account: 'me' },
    settings: {},
    item: null,
  }

  const snapshotOf = (projectId: string, state: 'ready' | 'loading' = 'ready'): GuestSessionsSnapshot => ({
    kind: 'sessions',
    projectId,
    state,
    coverage: [] as GuestDirectoryCoverage[],
    sessions: options.sessions[projectId] ?? [],
  })

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
    listProjects: async () => ({ kind: 'projects', state: 'ready', projects: options.projects }),
    listSessions: async (projectId: string) => snapshotOf(projectId),
    onSessions: async (projectId: string, listener: (snapshot: GuestSessionsSnapshot) => void) => {
      subscriptions.push({ kind: 'sessions', projectId })
      sessionListener = listener
      return () => { sessionListener = null }
    },
    openSession: async (sessionId: string) => { opened.push(sessionId) },
  }

  return {
    client: client as unknown as HostClient,
    opened, subscriptions,
    emitReady: (override) => { for (const l of readyListeners) l({ ...base, ...override }) },
    emitDirectory: (d) => { for (const l of directoryListeners) l(d) },
    emitItem: (i) => { for (const l of itemListeners) l(i) },
    pushSessions: (snapshot) => { sessionListener?.(snapshot) },
  }
}
