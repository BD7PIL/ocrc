// providerSettingsService 契约测试（N6 批次 1）。
// 这个服务此前把 10 个写方法全部硬编码拒绝——「设置→模型设置」因此永远是只读
// 空壳（用户实测：添加供应商报「个人供应商配置格式无效」）。测试钉住三件事：
//   1. 编辑面读的是**配置文件**（新建的供应商必须立刻可见，不等引擎重载）；
//   2. 写走 host 既有的结构化 patch，key 只进不出（视图里只有 keyHint）；
//   3. 失败如实抛出——绝不静默假成功（曾出现 testModelConnectivity 恒回 ok）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcProviderSettingsService } from '../providerSettingsService.js'

const CONFIG = {
  path: '/home/u/.config/opencode/opencode.json',
  raw: '{}',
  parsed: true,
  providers: [
    { id: 'alpha', name: 'Alpha', baseURL: 'https://alpha.example/v1', hasKey: true, keyHint: 'sk-a…1234', models: [{ id: 'a-1', name: 'A1' }] },
    { id: 'beta', baseURL: 'https://beta.example/v1', hasKey: false, models: [] },
  ],
}

const RUNTIME = [
  { id: 'alpha', name: 'Alpha Runtime', models: [{ id: 'a-1', name: 'A1', variants: ['low', 'high'] }, { id: 'a-2', name: 'A2' }] },
  { id: 'beta', name: 'Beta', models: [{ id: 'b-1' }] },
]

/** Minimal fetch double: routes by URL, records every call. */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
    const key = Object.keys(overrides).find((k) => url.includes(k))
    const payload = key ? overrides[key] : (url.includes('/api/models') ? RUNTIME : CONFIG)
    if (payload instanceof Error) throw payload
    return { ok: true, status: 200, json: async () => payload }
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom always has it */ } })
afterEach(() => vi.unstubAllGlobals())

describe('getView', () => {
  it('maps the CONFIG FILE (not the runtime catalog) so a brand-new provider shows up immediately', async () => {
    stubFetch()
    const view = await createOcrcProviderSettingsService().getView()
    expect(view.providerOrder).toEqual(['alpha', 'beta'])
    const alpha = view.providers.find((p: any) => p.providerId === 'alpha')
    // 有白名单：只有 a-1 enabled；运行时目录里的 a-2 作为候选列出但未启用
    expect(alpha.models.map((m: any) => [m.modelId, m.enabled])).toEqual([['a-1', true], ['a-2', false]])
    expect(alpha.models[0].effectiveConfig.optionSpecs.reasoningLevel.values).toEqual(['low', 'high'])
    // 无白名单：该供应商目录全开
    const beta = view.providers.find((p: any) => p.providerId === 'beta')
    expect(beta.models.map((m: any) => [m.modelId, m.enabled])).toEqual([['b-1', true]])
  })

  it('tags providers as standard-personal — the settings page filters on this group key', async () => {
    stubFetch()
    const view = await createOcrcProviderSettingsService().getView()
    for (const p of view.providers) {
      expect(p.effectiveConfig.group).toBe('standard-personal')
      expect(p.personalConfig).toBeDefined()
    }
  })

  it('never leaks the API key — only the hint survives into the view', async () => {
    stubFetch()
    const view = await createOcrcProviderSettingsService().getView()
    const alpha = view.providers.find((p: any) => p.providerId === 'alpha')
    expect(alpha.effectiveConfig.access.apiKey).toBe('sk-a…1234')
    expect(JSON.stringify(view)).not.toContain('sk-alpha-real-key')
  })

  it('marks executable only for providers the runtime catalog actually knows', async () => {
    stubFetch({ '/api/settings/opencode-config': { ...CONFIG, providers: [...CONFIG.providers, { id: 'fresh', name: 'Fresh', hasKey: false, models: [] }] } })
    const view = await createOcrcProviderSettingsService().getView()
    expect(view.providers.find((p: any) => p.providerId === 'fresh').executable).toBe(false)
    expect(view.providers.find((p: any) => p.providerId === 'alpha').executable).toBe(true)
  })
})

describe('writes go to the host config API', () => {
  it('createPersonalProvider derives a unique id, writes name/baseURL/key, returns providerId + fresh view', async () => {
    const calls = stubFetch()
    const svc = createOcrcProviderSettingsService()
    const created = await svc.createPersonalProvider({ providerName: 'My Provider', initialConfig: { api: { baseUrl: 'https://mine.example/v1' }, access: { apiKey: 'sk-new' } } })
    expect(created.providerId).toBe('my-provider')
    const patch = calls.find((c) => c.url.includes('/provider'))
    expect(patch?.body).toMatchObject({ providerId: 'my-provider', name: 'My Provider', baseURL: 'https://mine.example/v1', apiKey: 'sk-new' })
    // npm 是硬要求：缺了它引擎的供应商注册表整体变空（有实测记录，见 CHECKLIST）
    expect(patch?.body.npm).toBe('@ai-sdk/openai-compatible')
    expect(created.view.providerOrder).toEqual(['alpha', 'beta'])
  })

  it('avoids id collisions with existing providers', async () => {
    stubFetch()
    const svc = createOcrcProviderSettingsService()
    const created = await svc.createPersonalProvider({ providerName: 'alpha' })
    expect(created.providerId).toBe('alpha-2')
  })

  it('setPersonalModelEnabled(false) writes the reduced whitelist', async () => {
    const calls = stubFetch()
    await createOcrcProviderSettingsService().setPersonalModelEnabled('alpha', 'a-1', false)
    expect(calls.find((c) => c.url.includes('/provider'))?.body).toEqual({ providerId: 'alpha', models: [] })
  })

  it('setPersonalModelEnabled(true) appends to the whitelist', async () => {
    const calls = stubFetch()
    await createOcrcProviderSettingsService().setPersonalModelEnabled('alpha', 'a-2', true)
    expect(calls.find((c) => c.url.includes('/provider'))?.body).toEqual({ providerId: 'alpha', models: [{ id: 'a-1' }, { id: 'a-2' }] })
  })

  it('deletePersonalProvider sends delete:true', async () => {
    const calls = stubFetch()
    await createOcrcProviderSettingsService().deletePersonalProvider('beta')
    expect(calls.find((c) => c.url.includes('/provider'))?.body).toEqual({ providerId: 'beta', delete: true })
  })

  it('reorder routes to the reorder endpoint', async () => {
    const calls = stubFetch()
    await createOcrcProviderSettingsService().reorderPersonalModels('alpha', ['a-1'])
    expect(calls.find((c) => c.url.includes('/reorder'))?.body).toEqual({ providerId: 'alpha', modelIds: ['a-1'] })
  })

  it('refuses to write the displayed keyHint back as the real key', async () => {
    const calls = stubFetch()
    await createOcrcProviderSettingsService().savePersonalProviderOverlay(
      'alpha',
      { api: { baseUrl: 'https://alpha3.example/v1' }, access: { apiKey: 'sk-a…1234' } },
    )
    const body = calls.find((c) => c.url.includes('/provider'))?.body
    expect(body).toEqual({ providerId: 'alpha', baseURL: 'https://alpha3.example/v1' })
    expect(JSON.stringify(body)).not.toContain('sk-a…1234')
  })

  it('writes a genuinely new key and the provider name from metadata', async () => {
    const calls = stubFetch()
    await createOcrcProviderSettingsService().savePersonalProviderOverlay(
      'alpha',
      { api: { baseUrl: 'https://alpha3.example/v1' }, access: { apiKey: 'sk-brand-new' } },
      { providerName: 'Alpha 改名' },
    )
    expect(calls.find((c) => c.url.includes('/provider'))?.body).toEqual({
      providerId: 'alpha',
      name: 'Alpha 改名',
      baseURL: 'https://alpha3.example/v1',
      apiKey: 'sk-brand-new',
    })
  })

  it('surfaces {ok:false} as a thrown error instead of a fake success', async () => {
    stubFetch({ '/api/settings/opencode-config/provider': { ok: false, error: 'JSONC 校验失败' } })
    await expect(createOcrcProviderSettingsService().createPersonalProvider({ providerName: 'x' })).rejects.toThrow(/JSONC/)
  })
})

describe('testModelConnectivity', () => {
  it('maps a host-side probe failure to {success:false,error}', async () => {
    stubFetch({ '/api/settings/test-provider': { ok: false, error: 'GET https://x/models → 401' } })
    const out = await createOcrcProviderSettingsService().testModelConnectivity({ providerId: 'alpha', modelId: 'a-1' })
    expect(out).toEqual({ success: false, error: { message: 'GET https://x/models → 401', code: 'provider-unavailable' } })
  })

  it('maps a host-side success to {success:true}', async () => {
    stubFetch({ '/api/settings/test-provider': { ok: true, latencyMs: 12 } })
    const out = await createOcrcProviderSettingsService().testModelConnectivity({ providerId: 'alpha', modelId: 'a-1' })
    expect(out).toMatchObject({ success: true })
  })
})

describe('onDidChange', () => {
  it('notifies subscribers after a successful write', async () => {
    stubFetch()
    const svc = createOcrcProviderSettingsService()
    const seen: unknown[] = []
    const sub = svc.onDidChange((view: unknown) => seen.push(view))
    await svc.deletePersonalProvider('beta')
    expect(seen).toHaveLength(1)
    sub.dispose()
    await svc.deletePersonalProvider('beta')
    expect(seen).toHaveLength(1)
  })
})
