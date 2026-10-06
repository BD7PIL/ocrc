// src/lib/ws/send.ts — a module-level handle on the app's WebSocket client.
//
// The layout owns the client (auth-gated boot), but right-pane live tabs
// (subagent transcripts) live outside it and need to subscribe their child
// sessions. They call wsSend(); the layout registers the real client here at
// boot. Sends before boot / while disconnected queue inside the client.

type Send = (msg: unknown) => void

let current: Send | null = null

export function setWsSend(fn: Send | null): void {
  current = fn
}

export function wsSend(msg: unknown): void {
  current?.(msg)
}
