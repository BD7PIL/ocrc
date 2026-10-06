// state/sessions.ts — light session-list store (M1). The full sessions store
// (feeds / cards / sdelta / epoch resync) lands in M2 as the zustand port of
// the Svelte shell's sessions.ts; M1 only needs the list + live busy status,
// both served by the WS hello/session.status frames (no per-session
// subscription required — ws-hub broadcasts status to every client).
import { create } from 'zustand'
import type { SessionSummary } from '$lib/api/types.js'

export type SessionBusy = 'busy' | 'idle'

interface SessionsState {
  list: SessionSummary[]
  loaded: boolean
  /** sessionId → live busy flag from engine session.status (ws-hub). */
  busy: Record<string, boolean>
  setList: (list: SessionSummary[]) => void
  markLoaded: () => void
  setBusy: (sessionId: string, busy: boolean) => void
}

export const useSessions = create<SessionsState>((set) => ({
  list: [],
  loaded: false,
  busy: {},
  setList: (list) => set({ list, loaded: true }),
  markLoaded: () => set({ loaded: true }),
  setBusy: (sessionId, busy) => set((s) => ({ busy: { ...s.busy, [sessionId]: busy } })),
}))

export function sessionStatus(s: SessionSummary, busy: Record<string, boolean>): 'busy' | 'idle' {
  return busy[s.id] ? 'busy' : 'idle'
}
