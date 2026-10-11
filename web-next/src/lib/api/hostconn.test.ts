// P5 分流铁律回归：REST 层的 401 走 onUnauthorized 认证分流、绝不触碰连接状态机；
// 只有网络层失败计入 restFail 连击（阈值触发强制 ws 重验并复位）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from './client.js'
import { onUnauthorized } from '../auth.js'
import { hostConn, REST_FAILURE_STREAK_FOR_WS_RECHECK } from '../../zcode-services/hostConnection.js'

vi.mock('../auth.js', () => ({ onUnauthorized: vi.fn() }))
vi.mock('../auth-reload.js', () => ({ clearAuthReloadFlag: vi.fn() }))

beforeEach(() => {
  vi.mocked(onUnauthorized).mockClear()
})

describe('client.ts REST liveness signals (P5)', () => {
  it('401 diverts to onUnauthorized and never touches the connection machine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    await expect(api.sessions()).rejects.toThrow('401')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(hostConn.restStreak()).toBe(0)
    vi.unstubAllGlobals()
  })

  it('network failures feed the streak; threshold fires forceRecheck once and resets', async () => {
    const forceRecheck = vi.fn()
    hostConn.setForceRecheck(forceRecheck)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    for (let i = 1; i <= REST_FAILURE_STREAK_FOR_WS_RECHECK; i++) {
      await expect(api.sessions()).rejects.toThrow('fetch failed')
    }
    expect(forceRecheck).toHaveBeenCalledTimes(1)
    expect(hostConn.restStreak()).toBe(0)
    vi.unstubAllGlobals()
  })

  it('a success between failures keeps the streak from crossing the threshold', async () => {
    const forceRecheck = vi.fn()
    hostConn.setForceRecheck(forceRecheck)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/version')) throw new TypeError('fetch failed')
      return { ok: true, status: 200, json: async () => [] }
    }))
    await expect(api.version()).rejects.toThrow()
    await expect(api.sessions()).resolves.toEqual([])
    await expect(api.version()).rejects.toThrow()
    await expect(api.sessions()).resolves.toEqual([])
    expect(forceRecheck).not.toHaveBeenCalled()
    expect(hostConn.restStreak()).toBe(0)
    vi.unstubAllGlobals()
  })
})
