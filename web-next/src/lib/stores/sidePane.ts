// $lib/stores/sidePane.ts — zustand port of the Svelte shell's sidePane
// store (ZCode workspaceSidePane register): nothing is permanently resident;
// every tab is closable and addressed by an idempotent id. Semantics and the
// persistence key (ocrc.sidePane.v1) match the old shell.
import { create } from 'zustand'

export type HomeId = 'tasks' | 'files' | 'subs' | 'skills' | 'schedules' | 'mcp' | 'browser'

export type PaneTab =
  | { id: string; kind: 'home'; title: string; homeId: HomeId }
  | { id: string; kind: 'subagent'; title: string; childId: string }
  | { id: string; kind: 'file'; title: string; path: string; directory: string }
  | { id: string; kind: 'tool'; title: string; sessionId: string; messageId: string; partId: string }
  | { id: string; kind: 'git'; title: string }
  | { id: string; kind: 'sidechat'; title: string; childId: string }

export const HOMES: Array<{ homeId: HomeId; title: string }> = [
  { homeId: 'tasks', title: '任务' },
  { homeId: 'files', title: '文件' },
  { homeId: 'subs', title: '子代理' },
  { homeId: 'skills', title: 'Skills' },
  { homeId: 'schedules', title: '定时任务' },
  { homeId: 'mcp', title: 'MCP' },
  { homeId: 'browser', title: '浏览器' },
]
const HOME_IDS = new Set(HOMES.map((h) => h.homeId))
/** Pre-0.26.11 the schedules panel hid under a 'config' home — migrate. */
const HOME_MIGRATE: Record<string, HomeId> = { config: 'schedules' }
const KEY = 'ocrc.sidePane.v1'
const MAX_TABS = 12

function validTab(t: unknown): t is PaneTab {
  if (!t || typeof t !== 'object') return false
  const x = t as Record<string, unknown>
  if (typeof x.id !== 'string' || typeof x.title !== 'string') return false
  switch (x.kind) {
    case 'home': return typeof x.homeId === 'string' && HOME_IDS.has(x.homeId as HomeId)
    case 'subagent': return typeof x.childId === 'string'
    case 'file': return typeof x.path === 'string' && typeof x.directory === 'string'
    case 'tool': return typeof x.sessionId === 'string' && typeof x.messageId === 'string' && typeof x.partId === 'string'
    case 'git': return true
    case 'sidechat': return typeof x.childId === 'string'
    default: return false
  }
}

/** Parse + validate + migrate persisted state (exported for tests). */
export function loadState(raw: unknown): PaneState {
  try {
    const r = raw as Partial<PaneState>
    let tabs = (Array.isArray(r.tabs) ? r.tabs : [])
      .map((t) => {
        const x = t as Record<string, unknown>
        if (x?.kind === 'home' && x.homeId === 'config') {
          return { ...(t as PaneTab), homeId: 'schedules' as HomeId, title: '定时任务', id: 'schedules' }
        }
        return t
      })
      .filter(validTab)
    let activeId = typeof r.activeId === 'string' ? r.activeId : ''
    if (HOME_MIGRATE[activeId]) activeId = HOME_MIGRATE[activeId]
    if (activeId && HOME_IDS.has(activeId as HomeId) && !tabs.some((t) => t.id === activeId)) {
      const home = HOMES.find((h) => h.homeId === activeId)!
      tabs = [...tabs, { id: home.homeId, kind: 'home', title: home.title, homeId: home.homeId }]
    }
    if (!tabs.some((t) => t.id === activeId)) activeId = ''
    return { tabs: tabs.slice(-MAX_TABS), activeId }
  } catch {
    return { tabs: [], activeId: '' }
  }
}

function load(): PaneState {
  try { return loadState(JSON.parse(localStorage.getItem(KEY) ?? '{}')) } catch { return loadState({}) }
}
function persist(state: PaneState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private mode */ }
}

export interface PaneState { tabs: PaneTab[]; activeId: string }

export const useSidePane = create<PaneState>(() => load())

// subscribe → persist
useSidePane.subscribe((s) => persist(s))

export function openPaneTab(tab: PaneTab): void {
  useSidePane.setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === tab.id)
    const tabs = idx === -1 ? [...s.tabs, tab].slice(-MAX_TABS) : s.tabs.map((t) => (t.id === tab.id ? tab : t))
    return { tabs, activeId: tab.id }
  })
}

export function openHome(homeId: HomeId): void {
  const home = HOMES.find((h) => h.homeId === homeId)!
  openPaneTab({ id: home.homeId, kind: 'home', title: home.title, homeId })
}

export function closePaneTab(id: string): void {
  useSidePane.setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return s
    const tabs = s.tabs.filter((t) => t.id !== id)
    let activeId = s.activeId
    if (activeId === id) activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? ''
    return { tabs, activeId }
  })
}

/** Drag reorder: move tab at `from` index to `to`. */
export function reorderPaneTab(from: number, to: number): void {
  if (from === to || from < 0 || to < 0) return
  useSidePane.setState((s) => {
    if (from >= s.tabs.length || to >= s.tabs.length) return s
    const tabs = [...s.tabs]
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved!)
    return { tabs }
  })
}

export function activatePane(id: string): void {
  useSidePane.setState({ activeId: id })
}

export function resetPane(): void {
  useSidePane.setState({ tabs: [], activeId: '' })
}

/** Current snapshot (for event handlers outside React). */
export function paneSnapshot(): PaneState {
  return useSidePane.getState()
}
