// subagentsService.test.ts — U4：list 投影与 model 覆盖回写的单测钉死。
// fetch 全 mock：引擎合并配置（/api/agents-full）+ 项目 agent 节（/api/settings/project/agents）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOcrcSubagentsService } from '../subagentsService.js'

const fetchMock = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function stubFetch(routes: Array<{ match: (url: string) => boolean; body: unknown }>) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    const route = routes.find((r) => r.match(url))
    return {
      ok: Boolean(route),
      status: route ? 200 : 404,
      json: async () => route?.body,
    } as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('subagentsService.list', () => {
  it('引擎合并配置 + 项目标记 → AgentSummary（裁掉 ZCode 专有字段）', async () => {
    const fn = stubFetch([
      {
        match: (u) => u.includes('/api/agents-full'),
        body: {
          agents: {
            sisyphus: { model: 'deepseek/deepseek-v4.1-flash', options: {}, permission: {} },
            reviewer: { description: '评审', prompt: 'You review.', tools: { write: true, read: false }, model: 'opencode/big-pickle' },
          },
        },
      },
      {
        match: (u) => u.includes('/api/settings/project/agents'),
        body: { agents: { reviewer: { model: 'opencode/big-pickle' } } },
      },
    ])
    const svc = createOcrcSubagentsService()
    const result = await svc.list({ workspacePath: '/repo', mode: 'allRuntimeScopes' })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(result.agents).toHaveLength(2)
    const sisyphus = result.agents.find((a: any) => a.name === 'sisyphus')!
    expect(sisyphus.modelSelection).toEqual({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash' })
    expect(sisyphus.scope).toBe('workspace')
    expect(sisyphus.source).toBe('user')
    expect(sisyphus.enabled).toBe(true)
    expect((sisyphus as Record<string, unknown>).color).toBeUndefined()
    expect((sisyphus as Record<string, unknown>).permissionMode).toBeUndefined()
    const reviewer = result.agents.find((a: any) => a.name === 'reviewer')!
    expect(reviewer.systemPrompt).toBe('You review.')
    expect(reviewer.tools).toEqual(['write'])
    expect(reviewer.modelSelectionOverride).toEqual({ providerId: 'opencode', modelId: 'big-pickle' })
    expect(result.capability).toEqual({ userScopeAvailable: false })
  })

  it('裸 model 名（无 provider 前缀）→ 空 provider 的未完成选择，不造假', async () => {
    stubFetch([
      { match: (u) => u.includes('/api/agents-full'), body: { agents: { a: { model: 'solo-model' } } } },
      { match: (u) => u.includes('/api/settings/project/agents'), body: { agents: {} } },
    ])
    const svc = createOcrcSubagentsService()
    const result = await svc.list({ workspacePath: '/repo' })
    expect(result.agents[0]!.modelSelection).toEqual({ providerId: '', modelId: 'solo-model' })
  })

  it('disable:true → enabled=false；project agents 400 不致命', async () => {
    const fn = stubFetch([
      { match: (u) => u.includes('/api/agents-full'), body: { agents: { off: { model: 'p/m', disable: true } } } },
    ])
    const svc = createOcrcSubagentsService()
    const result = await svc.list({ workspacePath: '/repo' })
    expect(result.agents[0]!.enabled).toBe(false)
    const called = fn.mock.calls.map((c) => String(c[0]))
    expect(called.some((u) => u.includes('/api/settings/project/agents'))).toBe(true)
  })
})

describe('subagentsService model override', () => {
  it('setPluginAgentModelOverride → POST patch {model: provider/model}，记住 list 的工作区', async () => {
    const fn = stubFetch([
      { match: (u) => u.includes('/api/agents-full'), body: { agents: { a: {} } } },
      { match: (u) => u.includes('/api/settings/project/agents'), body: { ok: true } },
    ])
    const svc = createOcrcSubagentsService()
    await svc.list({ workspacePath: '/repo' })
    await svc.setPluginAgentModelOverride({ agentId: 'a', modelSelection: { providerId: 'opencode', modelId: 'big-pickle' } })
    const post = fn.mock.calls.find((c) => String(c[0]).includes('/api/settings/project/agents') && c[1]?.method === 'POST')
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post![1]!.body))).toEqual({ dir: '/repo', id: 'a', patch: { model: 'opencode/big-pickle' } })
  })

  it('清空选择 → patch null（删除项目覆盖，回落全局/默认）', async () => {
    const fn = stubFetch([
      { match: (u) => u.includes('/api/settings/project/agents'), body: { ok: true } },
    ])
    const svc = createOcrcSubagentsService()
    await (svc as any).list({ workspacePath: '/repo' }).catch(() => {})
    await svc.setBuiltInModelOverride({ agentName: 'general-purpose', modelSelection: undefined })
    const post = fn.mock.calls.find((c) => c[1]?.method === 'POST')
    expect(JSON.parse(String(post![1]!.body))).toEqual({ dir: '/repo', id: 'general-purpose', patch: null })
  })

  it('未 list 先覆盖 → 如实抛错（缺工作区路径）', async () => {
    stubFetch([])
    const svc = createOcrcSubagentsService()
    await expect(svc.setPluginAgentModelOverride({ agentId: 'x', modelSelection: undefined })).rejects.toThrow(/工作区/)
  })
})
