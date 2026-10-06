// $lib/ws/boot.ts — REST boot + WS connection for the shell. Mirrors the
// Svelte layout's bootConnection() (REST sessions + WS hello/status), minus
// the per-session feed wiring that arrives with M2's sessions store port.
import { api } from '$lib/api/client.js'
import { createWsClient, type WsClient } from './client.js'
import { useSessions } from '$lib/stores/sessions.js'

let client: WsClient | null = null
let booted = false

export function bootConnection(): void {
  if (booted) return
  booted = true

  // REST first — first paint must not wait for the WS handshake.
  void api.sessions().then((list) => useSessions.getState().setList(list)).catch(() => {})

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  client = createWsClient({
    url: `${proto}://${location.host}/ws`,
    onMessage: (msg) => {
      if (msg.type === 'hello' && Array.isArray(msg.sessions)) {
        useSessions.getState().setList(msg.sessions)
      } else if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
        useSessions.getState().setList(msg.sessions)
      } else if (msg.type === 'session.status' && typeof msg.sessionId === 'string') {
        useSessions.getState().setBusy(msg.sessionId, !!msg.busy)
      }
    },
  })
}

export function forceReconnect(): void {
  client?.forceReconnect()
}
