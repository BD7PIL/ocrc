// zcode-services/broadcastService.ts — ocrc-backed IBroadcastService（N6 批次 2C）。
//
// ZCode 靠 host→main 的多窗广播做跨窗口状态同步（主题/语言/凭证失效）。web 端
// 有原生对应物：BroadcastChannel —— 同源多标签页互通，语义等价且零后端成本。
// claim 系列是「同一时刻只允许一个窗口做某事」的租约（如刷新凭证），用 localStorage
// 的 token + 过期时间实现（跨标签页可见、刷新不丢）。
function channel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel('ocrc-zcode-broadcast')
  } catch {
    return null
  }
}

interface ClaimRecord { token: string; expiresAt: number }

const CLAIM_PREFIX = 'ocrc.claim.'
const CLAIM_TTL_MS = 30_000

function readClaim(key: string): ClaimRecord | null {
  try {
    const raw = localStorage.getItem(`${CLAIM_PREFIX}${key}`)
    if (!raw) return null
    const rec = JSON.parse(raw) as ClaimRecord
    if (!rec?.token || typeof rec.expiresAt !== 'number') return null
    if (rec.expiresAt < Date.now()) return null
    return rec
  } catch {
    return null
  }
}

export function createOcrcBroadcastService(): Record<string, any> {
  const listeners = new Set<(message: { channel: string; payload: unknown; sourceWindowId?: number }) => void>()
  const windowId = Math.floor(Math.random() * 1e9)
  let bc: BroadcastChannel | null = null

  function ensure(): BroadcastChannel | null {
    if (bc) return bc
    bc = channel()
    if (bc) {
      bc.onmessage = (ev) => {
        const msg = ev.data as { channel?: string; payload?: unknown; sourceWindowId?: number }
        if (!msg?.channel) return
        for (const l of listeners) {
          try { l({ channel: msg.channel, payload: msg.payload, sourceWindowId: msg.sourceWindowId }) } catch { /* 单个监听器异常不影响其他窗口 */ }
        }
      }
    }
    return bc
  }

  return {
    send: async (message: { channel: string; payload: unknown }) => {
      ensure()?.postMessage({ channel: message?.channel, payload: message?.payload, sourceWindowId: windowId })
    },
    onMessage: (listener: (message: { channel: string; payload: unknown; sourceWindowId?: number }) => void) => {
      ensure()
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    /** 拿到租约即可执行；过期自动失效（窗口崩溃不会永久占着锁）。 */
    acquireClaim: async (key: string) => {
      const existing = readClaim(key)
      if (existing) return { status: 'busy' as const, retryAfterMs: Math.max(500, existing.expiresAt - Date.now()) }
      const token = `${windowId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      try {
        localStorage.setItem(`${CLAIM_PREFIX}${key}`, JSON.stringify({ token, expiresAt: Date.now() + CLAIM_TTL_MS }))
      } catch {
        return { status: 'unavailable' as const }
      }
      // 复核：并发窗口可能同时写入（last-write-wins），赢家才拿得到租约
      const after = readClaim(key)
      if (!after || after.token !== token) return { status: 'busy' as const, retryAfterMs: 1000 }
      return { status: 'acquired' as const, lease: { key, token } }
    },
    commitClaim: async (lease: { key: string; token: string }) => {
      const cur = readClaim(lease?.key ?? '')
      if (cur?.token === lease?.token) {
        try { localStorage.removeItem(`${CLAIM_PREFIX}${lease.key}`) } catch { /* ignore */ }
      }
      return { status: 'committed' as const }
    },
    releaseClaim: async (lease: { key: string; token: string }) => {
      const cur = readClaim(lease?.key ?? '')
      if (cur?.token === lease?.token) {
        try { localStorage.removeItem(`${CLAIM_PREFIX}${lease.key}`) } catch { /* ignore */ }
      }
    },
    tryClaim: async (key: string) => {
      const existing = readClaim(key)
      return !existing
    },
  }
}
