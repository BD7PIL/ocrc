// $lib/stores/ui.ts — shell UI state (zustand port of the Svelte shell's
// stores/ui.ts, shell-scoped slice). Persistence keys match the old shell
// (ocrc.railOpen / ocrc.railW) so the preference carries across shells.
import { create } from 'zustand'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
function writeBool(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ }
}
function readNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

interface UiState {
  leftPanelOpen: boolean
  leftWidth: number
  inspectorOpen: boolean
  paletteOpen: boolean
  newSessionOpen: boolean
  channelsOpen: boolean
  composerEmpty: boolean
  whiteboardOpen: boolean
  splitSessionId: string | null
  activeSessionId: string | null
  setLeftPanel: (open: boolean) => void
  toggleLeftPanel: () => void
  setLeftWidth: (w: number) => void
  toggleInspector: () => void
  setPalette: (open: boolean) => void
  setNewSessionOpen: (open: boolean) => void
  setChannelsOpen: (open: boolean) => void
  setComposerEmpty: (empty: boolean) => void
  setWhiteboardOpen: (open: boolean) => void
  setSplitSessionId: (id: string | null) => void
  setActiveSession: (id: string | null) => void
}

export const useUi = create<UiState>((set, get) => ({
  leftPanelOpen: readBool('ocrc.railOpen', true),
  leftWidth: Math.min(420, Math.max(200, readNum('ocrc.railW', 280))),
  inspectorOpen: false,
  paletteOpen: false,
  newSessionOpen: false,
  channelsOpen: false,
  composerEmpty: true,
  whiteboardOpen: false,
  splitSessionId: null,
  activeSessionId: null,
  setLeftPanel: (open) => { writeBool('ocrc.railOpen', open); set({ leftPanelOpen: open }) },
  toggleLeftPanel: () => get().setLeftPanel(!get().leftPanelOpen),
  setLeftWidth: (w) => {
    const clamped = Math.min(420, Math.max(200, w))
    try { localStorage.setItem('ocrc.railW', String(clamped)) } catch { /* ignore */ }
    set({ leftWidth: clamped })
  },
  toggleInspector: () => set({ inspectorOpen: !get().inspectorOpen }),
  setPalette: (open) => set({ paletteOpen: open }),
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),
  setChannelsOpen: (open) => set({ channelsOpen: open }),
  setComposerEmpty: (empty) => set({ composerEmpty: empty }),
  setWhiteboardOpen: (open) => set({ whiteboardOpen: open }),
  setSplitSessionId: (id) => set({ splitSessionId: id }),
  setActiveSession: (id) => set({ activeSessionId: id }),
}))
