// zcode-services/hostConnection.ts — P5: host 连接状态机（检测层）。
// 唯一事实源 = ocrc live WS：断开 → degraded（重连中 N/M）→ 重试封顶 → down（确认死亡）；
// ws 重连成功 / REST 佐证成功 → up（自愈）。REST 层（client.ts）只做佐证：
// 连续失败达到阈值 = true，由 zcodeAgentService 强制 ws 重验（半开连接探测），
// 不直接改变 phase——网络层是否真断，一律由 ws 梯子裁决。
// 展示层（composer 横幅 / 重连条 / 整页错误面板）消费 zcodeAgentService 发出的
// control patch 与 runtime lifecycle 事件；本模块只管状态机与订阅，零 DOM、零 fetch。

export type HostPhase = 'up' | 'degraded' | 'down'

export interface HostConnState {
  phase: HostPhase
  /** 已发生的重连失败次数（degraded 期就是「重新连接中 N/M」的 N）。 */
  attempt: number
  maxAttempts: number
}

/** ws 重连间隔（与原 liveWsEnsure 的 3s 一致）。 */
export const HOST_RECONNECT_MS = 3000
/** 重连失败封顶：达到即 down（确认死亡），走 vendor 恢复阶梯（整页面板）。 */
export const HOST_MAX_RECONNECT_ATTEMPTS = 10
/** REST 层连续失败次数达到该值 → 强制 ws 重验（半开探测）。 */
export const REST_FAILURE_STREAK_FOR_WS_RECHECK = 3

export function createHostConnection() {
  let phase: HostPhase = 'up'
  let attempt = 0
  let restStreak = 0
  let forceRecheck: (() => void) | null = null
  const listeners = new Set<(s: HostConnState) => void>()
  const emit = () => {
    const s = snapshot()
    for (const l of [...listeners]) {
      try { l(s) } catch { /* 监听器自负 */ }
    }
  }
  const snapshot = (): HostConnState => ({ phase, attempt, maxAttempts: HOST_MAX_RECONNECT_ATTEMPTS })
  return {
    snapshot,
    subscribe(l: (s: HostConnState) => void): () => void {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    phase: (): HostPhase => phase,
    attempt: (): number => attempt,
    restStreak: (): number => restStreak,
    /** REST 佐证的「强制 ws 重验」钩子：zcodeAgentService 注册（关掉现连，走重连梯子）。 */
    setForceRecheck(cb: () => void): void { forceRecheck = cb },
    /** ws 打开（或等效的「host 确认可达」）：收敛回 up。返回是否发生了一次回归。 */
    wsUp(): boolean {
      restStreak = 0
      if (phase === 'up' && attempt === 0) return false
      phase = 'up'
      attempt = 0
      emit()
      return true
    },
    /** ws 断开且仍有受管会话（无受管会话时调用方不必上报）。 */
    wsDown(): void {
      attempt += 1
      phase = attempt >= HOST_MAX_RECONNECT_ATTEMPTS ? 'down' : 'degraded'
      emit()
    },
    /** REST 成功（host 可达的硬事实）：佐证复位。不改 phase——ws 是否恢复由 ws 自己说。 */
    restOk(): void { restStreak = 0 },
    /** REST 失败。连续达到阈值 → 触发强制重验并复位连击。返回是否触发。 */
    restFail(): boolean {
      restStreak += 1
      if (restStreak >= REST_FAILURE_STREAK_FOR_WS_RECHECK) {
        restStreak = 0
        forceRecheck?.()
        return true
      }
      return false
    },
  }
}

export type HostConnection = ReturnType<typeof createHostConnection>

// 进程内单例：client.ts（REST 面）与 zcodeAgentService（ws 面 / 探测 / patch）共享同一台状态机。
export const hostConn = createHostConnection()
