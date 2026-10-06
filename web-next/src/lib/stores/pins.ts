// state/pins.ts — pinned & archived sessions (zustand port of the Svelte
// shell's stores/pins.ts + stores/archive.ts; localStorage keys unchanged:
// ocrc.pins.v1 / ocrc.archive.v1).
import { create } from 'zustand'

function readIds(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function writeIds(key: string, ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids)) } catch { /* ignore */ }
}

interface PinsState {
  pins: string[]
  archived: string[]
  togglePin: (id: string) => void
  isPinned: (id: string) => boolean
  setArchived: (id: string, archived: boolean) => void
}

export const usePins = create<PinsState>((set, get) => ({
  pins: readIds('ocrc.pins.v1'),
  archived: readIds('ocrc.archive.v1'),
  togglePin: (id) => {
    const pins = get().pins.includes(id) ? get().pins.filter((x) => x !== id) : [...get().pins, id]
    writeIds('ocrc.pins.v1', pins)
    set({ pins })
  },
  isPinned: (id) => get().pins.includes(id),
  setArchived: (id, archived) => {
    const set_ = new Set(get().archived)
    if (archived) set_.add(id)
    else set_.delete(id)
    const list = [...set_]
    writeIds('ocrc.archive.v1', list)
    set({ archived: list })
  },
}))
