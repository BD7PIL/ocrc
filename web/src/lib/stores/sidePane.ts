// src/lib/stores/sidePane.ts — the right pane's dynamic tab system.
//
// Modeled on ZCode's workspaceSidePane (zai-org/ZCode packages/ui): NOTHING
// is permanently resident. Every tab — including the five "homes" (任务/文件/
// 子代理/Skills/配置) — is a closable dynamic tab addressed by a structured,
// idempotent id. Context entries open tabs from where the work happens:
// PlanHud rows open subagent pages, transcript tool rows open output/file
// pages, and the tab strip's "+" menu lists the five homes. State is
// { tabs, activeId }, persisted; closing activates the neighbor.

import { writable, get } from 'svelte/store'

export type HomeId = 'tasks' | 'files' | 'subs' | 'skills' | 'config'

export type PaneTab =
  | { id: string; kind: 'home'; title: string; homeId: HomeId }
  | { id: string; kind: 'subagent'; title: string; childId: string }
  | { id: string; kind: 'file'; title: string; path: string; directory: string }
  | { id: string; kind: 'tool'; title: string; sessionId: string; messageId: string; partId: string }
  | { id: string; kind: 'git'; title: string }
  | { id: string; kind: 'sidechat'; title: string; childId: string }

export interface PaneState {
  tabs: PaneTab[]
  activeId: string
}

const KEY = 'ocrc.sidePane.v1'
const MAX_TABS = 12

export const HOMES: Array<{ homeId: HomeId; title: string }> = [
  { homeId: 'tasks', title: '任务' },
  { homeId: 'files', title: '文件' },
  { homeId: 'subs', title: '子代理' },
  { homeId: 'skills', title: 'Skills' },
  { homeId: 'config', title: '配置' },
]
const HOME_IDS = new Set(HOMES.map((h) => h.homeId))

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

function load(): PaneState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PaneState>
    let tabs = Array.isArray(raw.tabs) ? raw.tabs.filter(validTab) : []
    let activeId = typeof raw.activeId === 'string' ? raw.activeId : ''
    // Migration from the pinned era: an activeId pointing at a well-known
    // home that has no tab yet reopens that home tab (the user's current
    // view survives the upgrade). Otherwise an unknown activeId → empty.
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

function persist(state: PaneState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private mode */ }
}

const store = writable<PaneState>(load())
store.subscribe(persist)

/** Idempotent open (ZCode activateSidePaneTab semantics): same id → REPLACE
    in place (fresh title/meta) and activate; new → append (dropping the oldest
    beyond MAX_TABS) and activate. */
export function openPaneTab(tab: PaneTab): void {
  store.update((s) => {
    const idx = s.tabs.findIndex((t) => t.id === tab.id)
    const tabs =
      idx === -1
        ? [...s.tabs, tab].slice(-MAX_TABS)
        : s.tabs.map((t) => (t.id === tab.id ? tab : t))
    return { tabs, activeId: tab.id }
  })
}

/** Open (or focus) one of the five well-known home tabs. */
export function openHome(homeId: HomeId): void {
  const home = HOMES.find((h) => h.homeId === homeId)!
  openPaneTab({ id: home.homeId, kind: 'home', title: home.title, homeId })
}

export function closePaneTab(id: string): void {
  store.update((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return s
    const tabs = s.tabs.filter((t) => t.id !== id)
    // Closing the active tab activates the neighbor (prev, else next, else
    // nothing — the empty pane is an honest state).
    let activeId = s.activeId
    if (activeId === id) {
      activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? ''
    }
    return { tabs, activeId }
  })
}

/** Drag reorder: move tab at `from` index to `to`. */
export function reorderPaneTab(from: number, to: number): void {
  if (from === to || from < 0 || to < 0) return
  store.update((s) => {
    if (from >= s.tabs.length || to >= s.tabs.length) return s
    const tabs = [...s.tabs]
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved)
    return { ...s, tabs }
  })
}

export function activatePane(id: string): void {
  store.update((s) => ({ ...s, activeId: id }))
}

/** Test/SSR helper. */
export function resetPane(): void {
  store.set({ tabs: [], activeId: '' })
}

export const sidePane = { subscribe: store.subscribe, openPaneTab, openHome, closePaneTab, reorderPaneTab, activatePane, resetPane }

/** Current snapshot (the store is reactive; this is for event handlers). */
export function paneSnapshot(): PaneState {
  return get(store)
}
