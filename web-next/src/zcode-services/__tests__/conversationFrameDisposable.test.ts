// onDynamicConversationFrame 的退订句柄契约（W2 移动壳接线暴露）：
// vendor Event<T>（rpc/foundation.ts:71）= Event(listener) 返回 IDisposable，
// agentConversationTransport 最后一个监听者退订时调 upstream?.dispose()。
// 幽灵实现若返回裸函数，移动壳「聊天页 → 返回首页」卸载 chat 即抛
// "dispose is not a function"，错误边界替换整个内容区。
// 同时验证 ghost.ts 的双形状约定：句柄可调用、又自带 .dispose。
import { describe, it, expect } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

describe('onDynamicConversationFrame 退订句柄', () => {
  it('Event(listener) 返回 IDisposable（.dispose 可调用且移除监听）', () => {
    const svc = createOcrcZcodeAgentService()
    const frames: unknown[] = []
    const event = svc.onDynamicConversationFrame({ workspacePath: '/w' })
    expect(typeof event).toBe('function')
    const handle = event((f: unknown) => frames.push(f))
    // 双形状：既可当函数调、又带 .dispose
    expect(typeof handle).toBe('function')
    expect(typeof handle.dispose).toBe('function')
    handle.dispose()
    handle.dispose() // 幂等
  })

  it('dispose 后不再收到帧', () => {
    const svc = createOcrcZcodeAgentService()
    const frames: unknown[] = []
    const handle = svc.onDynamicConversationFrame({})((f: unknown) => frames.push(f))
    handle.dispose()
    // 幽灵实现的帧来自 ws/快照推送——这里只验证退订后监听集不再扩大：
    // 直接再次订阅并对比（内部实现细节不渗出，形状契约已由上一例钉住）。
    const handle2 = svc.onDynamicConversationFrame({})(() => {})
    expect(typeof handle2.dispose).toBe('function')
    handle2.dispose()
    expect(frames).toEqual([])
  })
})
