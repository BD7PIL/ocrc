import { describe, expect, it } from 'vitest'
import { ALLOWED_PATH_PREFIX, callOcrcHost, isAllowedPath, resolveOp, type Op } from './ocrc-host.js'

/**
 * 面板 → ocrc host 的窄口：这里量的是**边界**，不是 happy path。
 * 少了这几条，一个扩展就能把 ocrc host 的任意面（会话、设置、workflow）暴露给
 * guest 沙箱——那比"功能少"严重得多。
 */

describe('路径白名单', () => {
  it('只放行 /api/remote-instance 族', () => {
    expect(isAllowedPath('/api/remote-instance')).toBe(true)
    expect(isAllowedPath('/api/remote-instance/x/status')).toBe(true)
    expect(isAllowedPath('/api/remote-instance?x=1')).toBe(true)
    // 同前缀但不同族：不许（前缀匹配要带边界）
    expect(isAllowedPath('/api/remote-instancesecret')).toBe(false)
    expect(isAllowedPath('/api/session')).toBe(false)
    expect(isAllowedPath('/api/remotes')).toBe(false)
    expect(isAllowedPath('/api/remote-instance/../../session')).toBe(false)
    expect(isAllowedPath('//evil')).toBe(false)
    expect(isAllowedPath('http://evil/')).toBe(false)
  })

  it('前缀常量本身是这一族（改错了会被这条拦住）', () => {
    expect(ALLOWED_PATH_PREFIX).toBe('/api/remote-instance')
  })
})

describe('op → 路径/方法（枚举出来的动作，不是"什么路径都行"）', () => {
  it('每个 op 都有确定映射，id 会编码', () => {
    expect(resolveOp({ op: 'list' })).toEqual({ path: '/api/remote-instance', method: 'GET' })
    expect(resolveOp({ op: 'add', payload: { host: 'h' } })).toEqual({ path: '/api/remote-instance', method: 'POST', body: { host: 'h' } })
    expect(resolveOp({ op: 'plan', id: 'demo@10.0.0.1' })).toEqual({ path: '/api/remote-instance/demo%4010.0.0.1/plan', method: 'POST' })
    expect(resolveOp({ op: 'apply', id: 'x' })).toEqual({ path: '/api/remote-instance/x/apply', method: 'POST', body: { confirm: true } })
    expect(resolveOp({ op: 'up', id: 'x' }).path).toBe('/api/remote-instance/x/up')
    expect(resolveOp({ op: 'down', id: 'x' }).method).toBe('POST')
    expect(resolveOp({ op: 'status', id: 'x' }).method).toBe('GET')
    expect(resolveOp({ op: 'logs', id: 'x', tail: 20 }).path).toBe('/api/remote-instance/x/logs?tail=20')
    expect(resolveOp({ op: 'url', id: 'x' }).method).toBe('GET')
    expect(resolveOp({ op: 'delete', id: 'x' }).path).toBe('/api/remote-instance/x/delete')
  })

  it('apply 默认带 confirm:true（本扩展只做"确认过的"装机）', () => {
    const r = resolveOp({ op: 'apply', id: 'x' } as Op)
    expect(r.body).toEqual({ confirm: true })
  })

  it('每个 op 生成的路径都过白名单（新 op 忘了边界会被这条拦住）', () => {
    const ops: Op[] = [
      { op: 'list' }, { op: 'add', payload: {} }, { op: 'patch', id: 'a', payload: {} },
      { op: 'plan', id: 'a' }, { op: 'apply', id: 'a' }, { op: 'up', id: 'a' }, { op: 'down', id: 'a' },
      { op: 'status', id: 'a' }, { op: 'logs', id: 'a' }, { op: 'url', id: 'a' }, { op: 'delete', id: 'a' },
    ]
    for (const o of ops) expect({ op: o.op, allowed: isAllowedPath(resolveOp(o).path) }).toEqual({ op: o.op, allowed: true })
  })
})

describe('转发本身', () => {
  it('拼对 URL/方法/体，并把状态与原文回传（状态码是上层要用的）', async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = []
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response('{"instances":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const reply = await callOcrcHost({ op: 'up', id: 'demo@h' }, { baseUrl: 'http://127.0.0.1:4099/', fetchImpl: fake })
    expect(reply).toEqual({ status: 200, body: '{"instances":[]}' })
    expect(seen[0]).toEqual({ url: 'http://127.0.0.1:4099/api/remote-instance/demo%40h/up', method: 'POST', body: undefined })

    await callOcrcHost({ op: 'add', payload: { host: 'h' } }, { baseUrl: 'http://127.0.0.1:4099', fetchImpl: fake })
    expect(seen[1]).toEqual({ url: 'http://127.0.0.1:4099/api/remote-instance', method: 'POST', body: { host: 'h' } })
  })

  it('非 2xx 不抛：状态与响应原文原样交给上层（面板要显示 ocrc 的原话）', async () => {
    const fake = (async () => new Response('{"error":"引擎不满足 v2 门禁"}', { status: 502 })) as unknown as typeof fetch
    const reply = await callOcrcHost({ op: 'up', id: 'x' }, { baseUrl: 'http://h', fetchImpl: fake })
    expect(reply.status).toBe(502)
    expect(reply.body).toContain('v2 门禁')
  })

  it('连不上时抛错（上层转成"ocrc host 不可达"的 502，而不是哑巴 500）', async () => {
    const fake = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(callOcrcHost({ op: 'list' }, { baseUrl: 'http://h', fetchImpl: fake })).rejects.toThrow('ECONNREFUSED')
  })
})
