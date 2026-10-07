// zcode-services/zcodeAgentService.ts — ocrc-backed zcodeAgentService v4 面 (N2).
// helloConversationV4 = v4 会话通道握手（ConversationTimeline 打开任务时的第一步）。
// 按上游 host 透传语义返回本地 hello；ocrc 的真实流增量由后续 WS 映射接入
// （onDynamicStreamEvent/onConversationEvent 族，N2 后半）。

const V4_WIRE_PROTOCOL_VERSION = 3 as const

function uuid(): string {
  // http 局域网非安全上下文里 crypto.randomUUID 不可用
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function createOcrcZcodeAgentService(): any {
  const impl: Record<string, unknown> = {
    // ── v4 conversation 订阅三件套：ACK-only 契约（初始 snapshot 走 post-
    //    response 通知通道；ocrc 的通知流在 N2 后半接 WS 映射）──
    async subscribeConversationV4(params: { topic?: string }) {
      return {
        ack: {
          subscriptionId: `ocrc-sub-${uuid()}`,
          mode: 'snapshot',
          logEpoch: 'ocrc-1',
          ...(params?.topic ? { topic: params.topic } : {}),
        },
      }
    },
    async resyncConversationV4() {
      return { ack: { subscriptionId: `ocrc-sub-${uuid()}`, mode: 'snapshot', logEpoch: 'ocrc-1' } }
    },
    async unsubscribeConversationV4() {
      return undefined
    },
    async helloConversationV4() {
      return {
        kind: 'hello' as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: `host-${uuid()}`,
        clientMode: 'desktop-continuous' as const,
        deliveryProfile: 'continuous' as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: false,
          binaryFrames: false,
          compression: 'none' as const,
          workspaceHookReview: true,
          independentPlanState: true,
          workflowRunDeltas: false,
        },
        auth: {},
      }
    },
    async initializeConversationV4(_rawClientHello: unknown) {
      // ocrc：无独立握手校验面，接受即完成
      return undefined
    },
    async setConnectionFlowStateV4(_params: unknown) {
      return undefined
    },
  }
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const name = String(prop)
      if (/^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/.test(name)) {
        return (_listener?: unknown) => {
          const un: any = () => {}
          un.dispose = () => {}
          return un
        }
      }
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`[ocrc-fork] zcodeAgentService.${name} 尚未接入 ocrc（N2）`))
    },
  })
}
