import { create } from 'zustand'

export type ConnectionStatus = 'offline' | 'connected' | 'reconnecting'

interface ConnectionState {
  status: ConnectionStatus
  /** Last measured WS round-trip latency in milliseconds (0 if not yet measured). */
  latencyMs: number
  setStatus: (status: ConnectionStatus) => void
  setLatency: (latencyMs: number) => void
}

/**
 * Connection health, mirrored from the WS client. Zustand port of the Svelte
 * shell's connection.ts — same semantics, react consumers use
 * `useConnectionStore((s) => s.status)`.
 */
export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'offline',
  latencyMs: 0,
  setStatus: (status) => set({ status }),
  setLatency: (latencyMs) => set({ latencyMs }),
}))
