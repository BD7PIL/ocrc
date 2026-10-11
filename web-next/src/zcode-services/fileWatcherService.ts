// zcode-services/fileWatcherService.ts — U4：ocrc-backed IFileWatcherService。
//
// 通道：/ws 的 `file-watch` 帧（host 侧 fs.watch + 300ms 防抖 + 目录上限；见
// src/core/file-watcher.ts）。watch/unwatch 是注册帧，事件按 id 广播回全部客户端。
// ws 断线重连后自动重登记全部活跃 watcher（host 重启后 id 已失效——重 watch 拿新 id，
// 事件订阅按 id 键随新事件恢复）。
import type { Event } from '@zcode/rpc'
import type { IFileWatcherService } from '@zcode/services'
import type { FileWatchEvent } from '@zcode/shared'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`
}

const RECONNECT_MS = 3000

interface PendingWatch {
  path: string
  recursive: boolean
  /** Resolved once the host confirms (watched frame) — id may differ from the
   *  requested key after a host restart (fresh ids). */
  resolve: (id: string) => void
  reject: (err: Error) => void
}

export function createOcrcFileWatcherService(): IFileWatcherService {
  const listeners = new Map<string, Set<(event: FileWatchEvent) => void>>()
  /** requested path key → confirmed host watcher id. */
  const activeByPath = new Map<string, string>()
  const pending = new Map<string, PendingWatch>()
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reqSeq = 0

  const send = (msg: Record<string, unknown>): boolean => {
    if (ws?.readyState !== WebSocket.OPEN) return false
    try { ws.send(JSON.stringify(msg)); return true } catch { return false }
  }

  const connect = (): void => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      // Re-register everything. Pending watches that never got confirmed keep
      // waiting — their promise resolves when the watched frame arrives.
      for (const [key, p] of pending) {
        send({ type: 'file-watch', op: 'watch', path: p.path, recursive: p.recursive, requestId: key })
      }
      for (const [path, oldId] of activeByPath) {
        // Old id is dead after a host restart; re-watch the path for a fresh id.
        send({ type: 'file-watch', op: 'unwatch', id: oldId })
        send({ type: 'file-watch', op: 'watch', path, recursive: true, requestId: `re-${path}` })
      }
    }
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.type !== 'file-watch') return
      if (msg.op === 'watched' && typeof msg.id === 'string') {
        const key = String(msg.requestId ?? '')
        const p = pending.get(key)
        if (p) {
          pending.delete(key)
          activeByPath.set(p.path, msg.id)
          p.resolve(msg.id)
        } else if (typeof key === 'string' && key.startsWith('re-')) {
          activeByPath.set(key.slice(3), msg.id)
        }
        return
      }
      if (msg.op === 'error') {
        const key = String(msg.requestId ?? '')
        const p = pending.get(key)
        if (p) {
          pending.delete(key)
          p.reject(new Error(String(msg.error ?? 'file-watch failed')))
        }
        return
      }
      // Event frame: {id, dirPath, changedPath?}.
      if (typeof msg.id === 'string' && typeof msg.dirPath === 'string') {
        const subs = listeners.get(msg.id)
        if (subs) {
          const event: FileWatchEvent = { dirPath: msg.dirPath, ...(typeof msg.changedPath === 'string' ? { changedPath: msg.changedPath } : {}) }
          for (const fn of [...subs]) {
            try { fn(event) } catch { /* listener errors never kill the pump */ }
          }
        }
      }
    }
    ws.onclose = () => {
      ws = null
      // Confirmed ids are stale now; drop them so reconnect re-watches.
      activeByPath.clear()
      scheduleReconnect()
    }
    ws.onerror = () => { /* onclose follows */ }
  }

  const scheduleReconnect = (): void => {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (pending.size || activeByPath.size || listeners.size) connect()
    }, RECONNECT_MS)
  }

  return {
    watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const key = `w${++reqSeq}`
      const promise = new Promise<{ id: string }>((resolve, reject) => {
        pending.set(key, {
      path: params.path,
      recursive: params.recursive === true,
      resolve: () => resolve({ id: activeByPath.get(params.path)! }),
      reject,
    })
      })
      connect()
      // If the socket is already open, onopen won't fire again — send directly.
      if (ws?.readyState === WebSocket.OPEN) {
        send({ type: 'file-watch', op: 'watch', path: params.path, recursive: params.recursive === true, requestId: key })
      }
      return promise
    },

    async unwatch(params: { id: string }): Promise<void> {
      for (const [path, id] of [...activeByPath]) {
        if (id === params.id) activeByPath.delete(path)
      }
      send({ type: 'file-watch', op: 'unwatch', id: params.id })
    },

    disposeAll(): void {
      for (const id of activeByPath.values()) send({ type: 'file-watch', op: 'unwatch', id })
      activeByPath.clear()
      listeners.clear()
    },

    onDynamicChange(id: string): Event<FileWatchEvent> {
      return (listener) => {
        let subs = listeners.get(id)
        if (!subs) { subs = new Set(); listeners.set(id, subs) }
        subs.add(listener)
        const dispose = () => { subs!.delete(listener) }
        // vendor Event<T> 契约：dispose 句柄（双形状兼容，见 conversationFrameDisposable）。
        ;(dispose as any).dispose = dispose
        return dispose as any
      }
    },
  }
}
