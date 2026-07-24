import { connection, latency, type ConnectionStatus } from '../stores/connection.js'
import { getToken } from '../auth-token.js'

const BACKOFF = [2000, 4000, 8000, 16000, 30000]

// A browser WebSocket can't carry an Authorization header, so token-auth rides
// in the query string (the server reads `?token=` on upgrade). Read it fresh on
// every (re)connect so a token captured after construction still applies.
function withToken(url: string): string {
  const t = getToken()
  if (!t) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(t)}`
}

export interface WsClientOpts {
  url: string
  onMessage?: (msg: any) => void
  onStatus?: (status: ConnectionStatus) => void
  onReconnect?: () => void
}

export interface WsClient {
  send(msg: any): void
  close(): void
}

export function createWsClient(opts: WsClientOpts): WsClient {
  let ws: WebSocket | null = null
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setTimeout> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  let pingSentAt = 0
  let closed = false
  // True once a connection has succeeded — onReconnect fires only for real
  // reconnects, not the first connect (the initial subscribe rides the queue).
  let everConnected = false
  // Messages sent while the socket isn't OPEN yet, flushed on open.
  const pending: string[] = []

  function setStatus(s: ConnectionStatus) {
    connection.set(s)
    opts.onStatus?.(s)
  }

  function clearTimers() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
  }

  function schedulePing() {
    pingTimer = setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        pingSentAt = performance.now()
        ws.send(JSON.stringify({ type: 'ping' }))
        pongTimer = setTimeout(() => {
          ws?.close()
          reconnect()
        }, 45000)
      }
    }, 25000)
  }

  function connect() {
    if (closed) return
    setStatus('reconnecting')
    try {
      ws = new WebSocket(withToken(opts.url))
    } catch {
      reconnect()
      return
    }

    ws.onopen = () => {
      reconnectAttempt = 0
      setStatus('connected')
      for (const data of pending.splice(0)) ws?.send(data)
      if (everConnected) opts.onReconnect?.()
      everConnected = true
      schedulePing()
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'pong') {
          if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
          if (pingSentAt) { latency.set(Math.round(performance.now() - pingSentAt)) }
          schedulePing()
          return
        }
        opts.onMessage?.(msg)
      } catch {}
    }

    ws.onclose = () => {
      clearTimers()
      if (!closed) reconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  function reconnect() {
    clearTimers()
    if (closed) return
    setStatus('reconnecting')
    const delay = BACKOFF[Math.min(reconnectAttempt, BACKOFF.length - 1)]
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => void connect(), delay)
  }

  void connect()

  return {
    send(msg) {
      const data = JSON.stringify(msg)
      if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      else pending.push(data)
    },
    close() {
      closed = true
      clearTimers()
      pending.length = 0
      ws?.close()
      ws = null
      setStatus('offline')
    },
  }
}
