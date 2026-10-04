// archive.ts — archived-session set (UI semantic only).
//
// opencode v1 has no session-archive API, so archiving is an ocrc-side
// judgment: the id joins a persisted set, the row leaves the default views,
// the archived section can restore it. Nothing on the server is touched —
// honest and reversible (ZCode's three-bucket model, ocrc-side state).

import { writable } from 'svelte/store'

const KEY = 'ocrc.archived.v1'

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function persist(ids: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* storage unavailable */ }
}

const store = writable<Set<string>>(new Set(load()))

export const archivedSessions = {
  subscribe: store.subscribe,
  has: (ids: Set<string>, id: string): boolean => ids.has(id),
  toggle(id: string): void {
    store.update((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      persist([...next])
      return next
    })
  },
}
