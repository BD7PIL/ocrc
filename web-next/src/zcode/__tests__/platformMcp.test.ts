// MCP 写入契约测试（N8-3）。本地 workspace（无 workspaceIdentity）时 mcpStore 的
// 保存落到 platform.saveMcpToUserDirectory —— 此前是"桌面专属"桩返回失败、又被
// store 的 .catch(logger.warn) 吞掉，界面表现为「表单关闭、假装保存成功」。
// 这里钉住四条映射：user upsert / delete / set-enabled 走全局结构化 patch，
// projectPath 走项目配置路由；失败如实回 {success:false,error} 而不是抛。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWebPlatform } from '../../zcode/platform.js'
import { createOcrcMcpSyncService } from '../../zcode-services/mcpSyncService.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

function stubFetch(ok = true, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; body: any }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    return { ok, status: ok ? 200 : 400, json: async () => body }
  }))
  return calls
}

describe('platform.saveMcpToUserDirectory', () => {
  it('user 级 upsert → 全局结构化 patch', async () => {
    const calls = stubFetch()
    const out = await createWebPlatform().saveMcpToUserDirectory!({
      action: 'upsert', source: 'zcodeagentmcp', name: 'ctx7',
      config: { type: 'remote', url: 'https://mcp.example/sse' },
    } as any)
    expect(out).toEqual({ success: true })
    expect(calls[0].url).toBe('/api/settings/opencode-config/mcp')
    expect(calls[0].body).toEqual({ id: 'ctx7', entry: { type: 'remote', url: 'https://mcp.example/sse' } })
  })

  it('delete / set-enabled 用同一路由的不同载荷', async () => {
    const calls = stubFetch()
    const svc = createWebPlatform()
    await svc.saveMcpToUserDirectory!({ action: 'delete', source: 'zcodeagentmcp', name: 'ctx7' } as any)
    await svc.saveMcpToUserDirectory!({ action: 'set-enabled', source: 'zcodeagentmcp', name: 'ctx7', enabled: false } as any)
    expect(calls[0].body).toEqual({ id: 'ctx7', delete: true })
    expect(calls[1].body).toEqual({ id: 'ctx7', enabled: false })
  })

  it('projectPath 存在时走项目配置路由', async () => {
    const calls = stubFetch()
    await createWebPlatform().saveMcpToUserDirectory!({
      action: 'upsert', source: 'zcodeagentmcp', name: 'local-fs',
      config: { type: 'local', command: ['npx', '-y', 'fs-mcp'] },
      projectPath: '/w/proj',
    } as any)
    expect(calls[0].url).toBe('/api/settings/project/mcp')
    expect(calls[0].body).toEqual({
      dir: '/w/proj', id: 'local-fs', entry: { type: 'local', command: ['npx', '-y', 'fs-mcp'] },
    })
  })

  it('后端拒绝时如实回 error（不再假成功，也不抛）', async () => {
    stubFetch(false, { ok: false, error: "MCP 配置需要 type: 'local' | 'remote'" })
    const out = await createWebPlatform().saveMcpToUserDirectory!({
      action: 'upsert', source: 'zcodeagentmcp', name: 'bad', config: { command: ['x'] },
    } as any)
    expect(out.success).toBe(false)
    expect(out.error).toContain('type')
  })
})

describe('mcpSyncService 列表：并上「已写、引擎未重载」的全局条目', () => {
  it('引擎列表 + 全局配置条目（source=user，disabled 如实标注）+ 项目条目，去重', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/mcp')) return { ok: true, json: async () => ([{ name: 'engine-one', type: 'remote', status: 'configured' }]) }
      if (u.includes('/api/settings/opencode-config/mcp')) {
        return { ok: true, json: async () => ({ mcp: {
          'engine-one': { type: 'remote', url: 'https://dup.example' },   // 已在引擎列表 → 不重复
          'fresh-write': { type: 'remote', url: 'https://new.example' },  // 刚写、引擎未重载
          'turned-off': { type: 'local', command: ['x'], enabled: false },
        } }) }
      }
      if (u.includes('/api/settings/project/mcp')) {
        return { ok: true, json: async () => ({ mcp: { 'proj-one': { type: 'local', command: ['y'] } } }) }
      }
      return { ok: true, json: async () => ({}) }
    }))
    const out = await createOcrcMcpSyncService().listWorkspaceMcpServerStatuses({ workspacePath: '/w' })
    expect(out.servers.map((s: any) => [s.name, s.source, s.status])).toEqual([
      ['engine-one', 'engine', 'configured'],
      ['fresh-write', 'user', 'configured'],
      ['turned-off', 'user', 'disabled'],
      ['proj-one', 'project', 'configured'],
    ])
  })

  it('loadMcpFromUserDirectory 同样可见未重载条目', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/mcp')) return { ok: true, json: async () => ([]) }
      if (u.includes('/api/settings/opencode-config/mcp')) return { ok: true, json: async () => ({ mcp: { 'w1': { type: 'remote', url: 'https://w1' } } }) }
      return { ok: true, json: async () => ({}) }
    }))
    const out = await createOcrcMcpSyncService().loadMcpFromUserDirectory({})
    expect(out.servers.map((s: any) => s.name)).toEqual(['w1'])
  })
})
