// zcode-services/liveStream.ts — /z/ fork 的活流桥（Q3.1/Q3.2 裁决实现）。
// 复用 host card-bus WS（/ws 协议：hello/subscribe/card/sdelta/replayEnd），
// 把活动会话的卡片事件翻译成「重取 ocrc 历史 → online 快照帧重发」。
// 300ms 去抖；card-bus 自带 seq/replay 纪律，翻译层只传结果不复制机制。

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const watched = new Set<string>()
const frameListeners = new Set<(sessionId: string) => void>()
const pendingRefetch = new Map<string, ReturnType<typeof setTimeout>>()

export function onLiveCard(sessionId: string, cb: (sessionId: string) => void): () => void {
  watched.add(sessionId)
  frameListeners.add(cb)
  ensureConnection()
  if (ws && ws.readyState === WebSocket.OPEN) subscribe(sessionId)
  return () => {
    frameListeners.delete(cb)
    // 无人监听时才退订（多消费者场景保留连接）
    const stillNeeded = frameListeners.size > 0
    if (!stillNeeded && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', sessionId }))
    }
    watched.delete(sessionId)
  }
}

function scheduleRefetch(sessionId: string): void {
  const existing = pendingRefetch.get(sessionId)
  if (existing) return
  pendingRefetch.set(
    sessionId,
    setTimeout(() => {
      pendingRefetch.delete(sessionId)
      for (const cb of frameListeners) cb(sessionId)
    }, 300),
  )
}

function subscribe(sessionId: string): void {
  ws?.send(JSON.stringify({ type: 'subscribe', sessionId, sinceSeq: 0 }))
}

function ensureConnection(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // 浏览器无法在 WS 升级上带 Authorization 头——host 接受 /ws?token= 查询参数
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`)
  } catch {
    scheduleReconnect()
    return
  }
  ws.onopen = () => {
    try { ws?.send(JSON.stringify({ type: 'ping' })) } catch { /* noop */ }
    for (const sessionId of watched) subscribe(sessionId)
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as { type?: string; sessionId?: string; card?: { sessionId?: string } }
      const sid = msg.sessionId ?? msg.card?.sessionId
      if (!sid) return
      if (msg.type === 'card' || msg.type === 'sdelta' || msg.type === 'session.status') {
        if (watched.has(sid)) scheduleRefetch(sid)
      }
    } catch { /* 非 JSON 帧（pong）忽略 */ }
  }
  ws.onclose = () => {
    ws = null
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (watched.size > 0) ensureConnection()
  }, 3000)
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

export { token }
