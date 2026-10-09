// N11-2 插件面读侧契约：plugin 数组 → listPlugins/getPluginsOverview；
// mutation 如实拒绝；reference catalog 诚实空。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcPluginsManagementService } from '../pluginsManagementService.js'

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

const CONFIG_RAW = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  plugin: ['@zcode/plugin-demo', 'github.com/user/repo', './local-plugin'],
})

function stubConfig(raw = CONFIG_RAW) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/settings/opencode-config')) return { ok: true, json: async () => ({ raw }) }
    return { ok: true, json: async () => ({}) }
  }))
}

describe('N11-2 listPlugins（读侧映射）', () => {
  it('plugin 数组每条 → 一行已安装插件，名称取路径尾段，enabled 默认 true', async () => {
    stubConfig()
    const svc = createOcrcPluginsManagementService()
    const { plugins, diagnostics } = await svc.listPlugins({ workspace: { workspacePath: '/w' } })
    expect(diagnostics).toEqual([])
    expect(plugins.map((p: any) => p.name)).toEqual(['plugin-demo', 'repo', 'local-plugin'])
    expect(plugins.every((p: any) => p.enabled === true)).toBe(true)
    expect(plugins[0].marketplace).toBe('opencode.json')
    expect(plugins[0].id).toMatch(/^ocrc-plugin-0-/)
  })
  it('对象条目尊重 enabled:false；配置读取失败回空列表', async () => {
    stubConfig(JSON.stringify({ plugin: [{ name: 'off-plug', enabled: false }] }))
    const svc = createOcrcPluginsManagementService()
    const { plugins } = await svc.listPlugins({})
    expect(plugins[0].enabled).toBe(false)
    stubConfig('{broken json')
    const empty = await svc.listPlugins({})
    expect(empty.plugins).toEqual([])
  })
})

describe('N11-2 getPluginsOverview', () => {
  it('installedPlugins 同源；capability.supported=true 并注明真相源', async () => {
    stubConfig()
    const svc = createOcrcPluginsManagementService()
    const overview = await svc.getPluginsOverview({ workspace: { workspacePath: '/w' } })
    expect(overview.marketplaces).toEqual([])
    expect(overview.installedPlugins).toHaveLength(3)
    expect(overview.installedPlugins[0]).toMatchObject({ name: 'plugin-demo', scope: 'user', enabled: true })
    expect(overview.capability.supported).toBe(true)
    expect(overview.capability.reason).toContain('opencode.json')
  })
})

describe('N11-2 mutation 拒绝与 catalog', () => {
  it('installPlugin 等写方法 reject 且文案指向 opencode.json', async () => {
    stubConfig()
    const svc = createOcrcPluginsManagementService()
    await expect(svc.installPlugin({} as any)).rejects.toThrow(/opencode\.json/)
    await expect(svc.uninstallPlugin({} as any)).rejects.toThrow(/ocrc 裁决不做插件市场|尚未接入/)
  })
  it('getPluginReferenceCatalog 返回诚实空 catalog', async () => {
    stubConfig()
    const svc = createOcrcPluginsManagementService()
    const cat = await svc.getPluginReferenceCatalog({ workspace: { workspacePath: '/w' } })
    expect(cat.entries).toEqual([])
    const resolved = await svc.resolveSuggestedPluginReference({ suggestion: 'demo' })
    expect(resolved.resolved).toBe(false)
  })
})
