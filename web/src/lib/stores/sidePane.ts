// src/lib/stores/sidePane.ts — the right pane's dynamic tab system.
//
// Modeled on ZCode's workspaceSidePane (zai-org/ZCode packages/ui): content
// tabs OPEN on demand instead of living as fixed categories. A tab is
// addressed by a structured, idempotent id (`sub:<sessionId>`,
// `file:<encoded path>`) — opening the same subagent/file twice activates the
// existing tab rather than duplicating it. State is { tabs, activeId },
// persisted; closing activates the neighbor. Pinned tabs (任务/文件/子代理/
// Skills/配置) are NOT in tabs[] — they are constants rendered by the
// Inspector and share the same activeId namespace.

import { writable, get } from 'svelte/store'

export type PaneTab =
  | { id: string; kind: 'subagent'; title: string; childId: string }
  | { id: string; kind: 'file'; title: string; path: string; directory: string }

export interface PaneState {
  tabs: PaneTab[]
  activeId: string
}

const KEY = 'ocrc.sidePane.v1'
const MAX_TABS = 12

/** Pinned tab ids — share the activeId namespace with dynamic tabs. */
export const PINNED_IDS = ['tasks', 'files', 'subs', 'skills', 'config'] as const
export type PinnedId = (typeof PINNED_IDS)[number]

function validTab(t: unknown): t is PaneTab {
  if (!t || typeof t !== 'object') return false
  const x = t as Record<string, unknown>
  if (typeof x.id !== 'string' || typeof x.title !== 'string') return false
  if (x.kind === 'subagent') return typeof x.childId === 'string'
  if (x.kind === 'file') return typeof x.path === 'string' && typeof x.directory === 'string'
  return false
}

function load(): PaneState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PaneState>
    const tabs = Array.isArray(raw.tabs) ? raw.tabs.filter(validTab) : []
    const activeId = typeof raw.activeId === 'string' ? raw.activeId : 'tasks'
    return { tabs: tabs.slice(-MAX_TABS), activeId }
  } catch {
    return { tabs: [], activeId: 'tasks' }
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

export function closePaneTab(id: string): void {
  store.update((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return s
    const tabs = s.tabs.filter((t) => t.id !== id)
    // Closing the active tab activates the neighbor (prev, else next, else a
    // pinned default) — never a dead activeId.
    let activeId = s.activeId
    if (activeId === id) {
      activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? 'tasks'
    }
    return { tabs, activeId }
  })
}

export function activatePane(id: string): void {
  store.update((s) => ({ ...s, activeId: id }))
}

/** Activate a pinned tab (e.g. PlanHud's 打开任务面板). */
export function activatePinned(id: PinnedId): void {
  activatePane(id)
}

/** Test/SSR helper. */
export function resetPane(): void {
  store.set({ tabs: [], activeId: 'tasks' })
}

export const sidePane = { subscribe: store.subscribe, openPaneTab, closePaneTab, activatePane, activatePinned, resetPane }

/** Current snapshot (the store is reactive; this is for event handlers). */
export function paneSnapshot(): PaneState {
  return get(store)
}
