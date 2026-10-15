import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  patchMcpEntry,
  patchProvider,
  reorderConfig,
  testProviderConnectivity,
  summarize,
} from '../../src/core/settings-service.js'

afterEach(() => { vi.unstubAllGlobals() })

function tempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-settings-'))
  const path = join(dir, 'opencode.json')
  writeFileSync(path, content)
  return path
}

const BASE = JSON.stringify({
  provider: {
    alpha: { name: 'Alpha', options: { baseURL: 'https://alpha.example/v1', apiKey: 'sk-alpha-key-1234' }, models: { 'a-1': { name: 'A1' } } },
    beta: { options: { baseURL: 'https://beta.example/v1' }, models: { 'b-1': {}, 'b-2': {} } },
  },
}, null, 2)

describe('patchProvider', () => {
  it('creates a provider entry and writes name + baseURL + key', () => {
    const path = tempConfig('{}')
    patchProvider(path, { providerId: 'gamma', name: 'Gamma 自建', baseURL: 'https://g.example/v1', apiKey: 'sk-g' })
    const summary = summarize(readFileSync(path, 'utf-8'), path)
    const gamma = summary.providers.find((p) => p.id === 'gamma')
    expect(gamma?.name).toBe('Gamma 自建')
    expect(gamma?.baseURL).toBe('https://g.example/v1')
    expect(gamma?.hasKey).toBe(true)
  })

  it('writes the npm loader — an entry without it empties the WHOLE provider registry', () => {
    // 实测（隔离栈，2026-10-08）：provider.e2etest = {name} 或 {name,options:{}} 会让
    // 引擎报 ProviderNoProvidersError，连内置免费模型一起消失；{npm, models:{}} 则健康。
    // 所以 /z/ 创建供应商必须带 npm，这条钉住回归。
    const path = tempConfig('{}')
    patchProvider(path, { providerId: 'custom', name: '自定义', npm: '@ai-sdk/openai-compatible' })
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    expect(doc.provider.custom.npm).toBe('@ai-sdk/openai-compatible')
    expect(doc.provider.custom.name).toBe('自定义')
  })

  it('leaves the stored key untouched when apiKey is absent (write-only semantics)', () => {
    const path = tempConfig(BASE)
    patchProvider(path, { providerId: 'alpha', baseURL: 'https://alpha2.example/v1' })
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    expect(doc.provider.alpha.options.apiKey).toBe('sk-alpha-key-1234')
    expect(doc.provider.alpha.options.baseURL).toBe('https://alpha2.example/v1')
  })

  it('delete:true removes the provider and keeps the others intact', () => {
    const path = tempConfig(BASE)
    patchProvider(path, { providerId: 'alpha', delete: true })
    const summary = summarize(readFileSync(path, 'utf-8'), path)
    expect(summary.providers.map((p) => p.id)).toEqual(['beta'])
    expect(summary.providers[0]!.models.map((m) => m.id)).toEqual(['b-1', 'b-2'])
  })

  it('replaces the models map wholesale (enable/disable = whitelist edit)', () => {
    const path = tempConfig(BASE)
    patchProvider(path, { providerId: 'beta', models: [{ id: 'b-1', name: 'Beta One' }] })
    const summary = summarize(readFileSync(path, 'utf-8'), path)
    const beta = summary.providers.find((p) => p.id === 'beta')
    expect(beta?.models).toEqual([{ id: 'b-1', name: 'Beta One' }])
  })
})

describe('reorderConfig', () => {
  it('reorders providers by the given ids, unlisted ones keep relative order at the end', () => {
    const path = tempConfig(BASE)
    reorderConfig(path, { providerIds: ['beta'] })
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    expect(Object.keys(doc.provider)).toEqual(['beta', 'alpha'])
  })

  it('reorders one provider models and ignores unknown ids', () => {
    const path = tempConfig(BASE)
    reorderConfig(path, { providerId: 'beta', modelIds: ['b-2'] })
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    expect(Object.keys(doc.provider.beta.models)).toEqual(['b-2', 'b-1'])
  })

  it('throws on invalid JSONC instead of clobbering the file', () => {
    const path = tempConfig('{ not jsonc ')
    expect(() => reorderConfig(path, { providerIds: ['alpha'] })).toThrow(/JSONC/)
  })
})

describe('testProviderConnectivity', () => {
  it('probes <baseURL>/models server-side with the STORED key and reports latency', async () => {
    const path = tempConfig(BASE)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const out = await testProviderConnectivity(path, 'alpha')
    expect(out.ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('https://alpha.example/v1/models')
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer sk-alpha-key-1234')
  })

  it('reports the upstream error instead of faking success', async () => {
    const path = tempConfig(BASE)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    const out = await testProviderConnectivity(path, 'alpha')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('401')
  })

  it('fails loudly when the provider has no baseURL', async () => {
    const path = tempConfig(JSON.stringify({ provider: { bare: { models: {} } } }))
    const out = await testProviderConnectivity(path, 'bare')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('baseURL')
  })
})

describe('patchMcpEntry', () => {
  const WITH_MCP = JSON.stringify({
    provider: { alpha: { name: 'Alpha' } },
    mcp: { existing: { type: 'remote', url: 'https://old.example/mcp', enabled: true } },
  }, null, 2)

  it('upserts a valid entry and keeps unrelated keys + the other MCP entries', () => {
    const path = tempConfig(WITH_MCP)
    patchMcpEntry(path, { id: 'ctx7', entry: { type: 'remote', url: 'https://mcp.example/sse' } })
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    expect(doc.mcp.ctx7).toEqual({ type: 'remote', url: 'https://mcp.example/sse' })
    expect(doc.mcp.existing).toMatchObject({ url: 'https://old.example/mcp', enabled: true })
    expect(doc.provider.alpha.name).toBe('Alpha')
  })

  it('validates the entry shape the engine fail-fasts on (type / command / url)', () => {
    const path = tempConfig(WITH_MCP)
    expect(() => patchMcpEntry(path, { id: 'bad', entry: { command: ['npx', 'x'] } })).toThrow(/type/)
    expect(() => patchMcpEntry(path, { id: 'bad', entry: { type: 'local' } })).toThrow(/command/)
    expect(() => patchMcpEntry(path, { id: 'bad', entry: { type: 'remote' } })).toThrow(/url/)
    // nothing was written on the failed attempts
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcp.bad).toBeUndefined()
  })

  it('deletes an entry and leaves a backup of the previous file', () => {
    const path = tempConfig(WITH_MCP)
    patchMcpEntry(path, { id: 'existing', delete: true })
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    expect(doc.mcp.existing).toBeUndefined()
    expect(readFileSync(`${path}.ocrc-bak`, 'utf-8')).toBe(WITH_MCP)
  })

  it('toggles enabled only on an existing entry (no bare {enabled} stubs)', () => {
    const path = tempConfig(WITH_MCP)
    patchMcpEntry(path, { id: 'existing', enabled: false })
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcp.existing.enabled).toBe(false)
    expect(() => patchMcpEntry(path, { id: 'ghost', enabled: true })).toThrow(/不存在/)
  })

  it('refuses to patch a config that is not valid JSONC', () => {
    const path = tempConfig('{ // broken')
    expect(() => patchMcpEntry(path, { id: 'x', entry: { type: 'remote', url: 'https://x' } })).toThrow(/JSONC/)
  })
})
