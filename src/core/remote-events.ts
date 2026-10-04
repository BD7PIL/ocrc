import { createLogger } from '../utils/logger.js'

const log = createLogger('remote-events')

/**
 * 0.26.0 remote event source: every enabled remote opencode instance gets its
 * own `/global/event` SSE consumer (ocFetch-shaped, with that remote's Basic
 * auth), frames forwarded into the SAME dispatchEvent the local plugin hook
 * feeds — streaming, sdelta, push notifications, permissions all flow through
 * the existing pipeline untouched. Remote session ids are distinct UUIDs, so
 * no cross-host collision is possible.
 */

export interface RemoteEventsHandle {
  stop(): void
}

export function startRemoteEvents(opts: {
  name: string
  url: string
  headers: Record<string, string>
  dispatch: (ev: { type?: string; properties?: unknown }) => Promise<void>
  reconnectMs?: number
}): RemoteEventsHandle {
  const controller = new AbortController()
  const reconnectMs = opts.reconnectMs ?? 3000

  const consume = async () => {
    let buf = ''
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(opts.url, { signal: controller.signal, headers: opts.headers })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const decoder = new TextDecoder()
        const reader = res.body.getReader()
        buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trimEnd()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            try {
              // Wire envelope: {directory, project, payload:{type, properties}}
              const frame = JSON.parse(payload) as { payload?: { type?: string; properties?: unknown } }
              if (!frame?.payload?.type) continue
              await opts.dispatch(frame.payload)
            } catch { /* malformed frame — keep the stream */ }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        log.debug(`[${opts.name}] event SSE dropped, reconnecting`, (err as Error).message)
      }
      if (!controller.signal.aborted) await new Promise((r) => setTimeout(r, reconnectMs))
    }
  }
  void consume()

  return { stop: () => controller.abort() }
}
