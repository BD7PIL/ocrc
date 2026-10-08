// zcode-services/shareService.ts — ocrc-backed IConversationShareService（N7-2）。
//
// ocrc 的分享语义：`POST /api/share` 给整个会话打快照 → 公开落地页 `/share/<code>`。
// ZCode 的分享是「选 product turns 发布」——ocrc 没有 product turn 概念，selection
// 被有意忽略（整份转录），access_mode 固定 public_readonly（ocrc 分享即「链接可读」），
// 无过期时间（expires_at 给远期值，语义=不自动失效）。
// 导入/续聊/预览依赖 ZCode 自己的分享服务端，ocrc 没有——如实拒绝。
import { CONVERSATION_SHARE_SCHEMA_VERSION } from '@zcode/shared'
import { withGhosts } from './ghost.js'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }
}

/** ocrc 分享不自动失效：给一个远期时间戳（2100 年），语义即「链接长期有效」。 */
const NO_EXPIRY = Math.floor(new Date('2100-01-01T00:00:00Z').getTime())

export function createOcrcShareService(): Record<string, any> {
  const publishListeners = new Set<(progress: any) => void>()

  return withGhosts('conversationShareService', {
    /** 能力发现：ocrc 支持纯文本转录、链接只读、单条不拆轮次。 */
    getCapabilities: async () => ({
      ttl_ms: 365 * 24 * 60 * 60 * 1000,
      max_rows: 500,
      max_payload_bytes: 5 * 1024 * 1024,
      max_artifact_count: 0,
      max_artifact_bytes: 1,
      max_total_artifact_bytes: 1,
      schema_version: CONVERSATION_SHARE_SCHEMA_VERSION,
      access_modes: ['public_readonly'],
      allowed_artifacts: [],
    }),

    /** 轮次预检：dock 从行里枚举出「可选轮次」，但选择动作要靠这里的 productTurnId 落地
     *  ——此前返回空数组 → 复选框点了没反应、「下一步」永远灰（隔离栈实测）。turnId 必须
     *  与行映射的 `turn-N` 对齐（buildRows 的顺序编号）。 */
    preflight: async (input: { sessionId?: string }) => {
      const turns: Array<{ productTurnId: string; blockingIssues: never[]; skippableWarnings: never[]; deferredIssues: never[] }> = []
      if (input?.sessionId) {
        const res = await fetch(`/api/session/${input.sessionId}?limit=200`, { headers: auth() }).catch(() => null)
        if (res?.ok) {
          const body = (await res.json()) as { cards?: Array<{ kind?: string }> }
          let turn = 0
          for (const c of body.cards ?? []) {
            if (c?.kind !== 'user') continue
            turn += 1
            turns.push({ productTurnId: `turn-${turn}`, blockingIssues: [], skippableWarnings: [], deferredIssues: [] })
          }
        }
      }
      return {
        revision: 1,
        logEpoch: 'ocrc-1',
        capabilitiesFingerprint: 'ocrc-share-v1',
        blockingIssues: [],
        skippableWarnings: [],
        deferredIssues: [],
        supportedArtifactTypes: [],
        turnResults: turns,
      }
    },

    publish: async (input: { sessionId: string; title: string }) => {
      for (const l of publishListeners) {
        try { l({ operationId: '', phase: 'collecting', completedArtifacts: 0, totalArtifacts: 1 }) } catch { /* 忽略监听器异常 */ }
      }
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ sessionId: input.sessionId, title: input.title || undefined }),
      }).catch((e) => { throw new Error(`分享请求失败：${(e as Error).message}`) })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(detail.error ?? `POST /api/share ${res.status}`)
      }
      const body = (await res.json()) as { code: string; url: string; count: number }
      for (const l of publishListeners) {
        try { l({ operationId: '', phase: 'complete', completedArtifacts: 1, totalArtifacts: 1 }) } catch { /* 忽略 */ }
      }
      return {
        share_code: body.code,
        share_url: body.url,
        access_mode: 'public_readonly',
        expires_at: NO_EXPIRY,
      }
    },

    onDynamicPublishProgress: (listener: (progress: any) => void) => {
      publishListeners.add(listener)
      return { dispose: () => { publishListeners.delete(listener) } }
    },

    // 导入/续聊/预览是 ZCode 分享服务端的能力（对端拉取快照），ocrc 没有对端。
    importShare: async () => { throw new Error('[ocrc-fork] 导入他人分享需要 ZCode 分享服务端，ocrc 未提供') },
    getImportedConversation: async () => null,
    getPreview: async () => { throw new Error('[ocrc-fork] 预览他人分享需要 ZCode 分享服务端，ocrc 未提供') },
    getContinuation: async () => { throw new Error('[ocrc-fork] 续聊他人分享需要 ZCode 分享服务端，ocrc 未提供') },
  })
}
