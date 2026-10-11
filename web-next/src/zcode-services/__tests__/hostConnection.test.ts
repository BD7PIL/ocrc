// hostConnection 状态机纯单测（P5）：
// up → degraded（重连计数）→ down（封顶确认死亡）→ up（自愈清零），
// 以及 REST 佐证连击阈值（强制 ws 重验）与 401 等成功信号的复位语义。
import { describe, expect, it, vi } from 'vitest'
import {
  createHostConnection,
  HOST_MAX_RECONNECT_ATTEMPTS,
  REST_FAILURE_STREAK_FOR_WS_RECHECK,
} from '../hostConnection.js'

describe('hostConnection state machine', () => {
  it('starts up and wsUp on a fresh machine is a no-op', () => {
    const c = createHostConnection()
    expect(c.phase()).toBe('up')
    expect(c.wsUp()).toBe(false)
  })

  it('wsDown counts attempts: degraded until the cap, then down', () => {
    const c = createHostConnection()
    for (let i = 1; i < HOST_MAX_RECONNECT_ATTEMPTS; i++) {
      c.wsDown()
      expect(c.phase()).toBe('degraded')
      expect(c.attempt()).toBe(i)
    }
    c.wsDown()
    expect(c.phase()).toBe('down')
    // 封顶后继续失败：attempt 继续涨但相位钉死在 down。
    c.wsDown()
    expect(c.phase()).toBe('down')
  })

  it('wsUp after degradation resets attempt and notifies subscribers of the transition', () => {
    const c = createHostConnection()
    const seen: Array<{ phase: string; attempt: number }> = []
    c.subscribe((s) => seen.push({ phase: s.phase, attempt: s.attempt }))
    c.wsDown()
    c.wsDown()
    expect(c.wsUp()).toBe(true)
    expect(c.phase()).toBe('up')
    expect(c.attempt()).toBe(0)
    // 两次 wsDown + 一次 wsUp 回归 = 3 次通知；up→up 的空回归不再通知。
    expect(seen).toEqual([
      { phase: 'degraded', attempt: 1 },
      { phase: 'degraded', attempt: 2 },
      { phase: 'up', attempt: 0 },
    ])
  })

  it('restOk resets the REST failure streak; streak threshold fires forceRecheck once', () => {
    const c = createHostConnection()
    const forceRecheck = vi.fn()
    c.setForceRecheck(forceRecheck)
    c.restFail()
    c.restFail()
    c.restOk()
    expect(c.restStreak()).toBe(0)
    expect(forceRecheck).not.toHaveBeenCalled()
    for (let i = 1; i < REST_FAILURE_STREAK_FOR_WS_RECHECK; i++) c.restFail()
    expect(forceRecheck).not.toHaveBeenCalled()
    c.restFail()
    expect(forceRecheck).toHaveBeenCalledTimes(1)
    // 触发后连击复位：下一轮从零数起。
    expect(c.restStreak()).toBe(0)
  })

  it('subscribe returns an unsubscribe that stops notifications', () => {
    const c = createHostConnection()
    const seen: string[] = []
    const off = c.subscribe((s) => seen.push(s.phase))
    off()
    c.wsDown()
    expect(seen).toEqual([])
  })
})
