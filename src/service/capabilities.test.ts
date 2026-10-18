import { describe, expect, it } from 'vitest'
import {
  applyNpxRewrites, capabilitiesFromConfig, capabilityFromMcp, classifyRuntimeNeed,
  looksSecret, packageVersionOf, rewriteNpxCommand, runtimeNeedsOf,
} from './capabilities.js'

/** 被控机上抄回来的真实配置形状（批次 6 取证，见 panel-provisioning-verdict §2.3）。 */
const REAL_CONFIG = {
  mcp: {
    servers: {
      searxng: { type: 'local', command: 'npx mcp-searxng', environment: { SEARXNG_URL: 'http://192.168.96.11:8080' } },
      playwright: { type: 'local', command: 'npx @playwright/mcp@next --cdp-endpoint http://127.0.0.1:9222' },
      tavily: { type: 'remote', url: 'https://api.tavily.com?tavilyApiKey=sk-live-xxx' },
      codegraph: { type: 'local', command: '/opt/tools/codegraph serve' },
    },
  },
}

describe('从配置读出能力（D11：单位是能力，不是凭据类别）', () => {
  it('每个 MCP server 是一项能力，需求三类各归各位', () => {
    const capabilities = capabilitiesFromConfig(REAL_CONFIG)
    expect(capabilities.map((c) => c.id)).toEqual(['mcp:searxng', 'mcp:playwright', 'mcp:tavily', 'mcp:codegraph'])

    const searxng = capabilities.find((c) => c.id === 'mcp:searxng')
    expect(searxng?.needs.network).toEqual(['http://192.168.96.11:8080'])
    expect(searxng?.needs.runtime).toEqual(['mcp-searxng'])
    // SEARXNG_URL 不是密钥（名字不像），所以不该被要求搬运。
    expect(searxng?.needs.secrets).toBeUndefined()

    const playwright = capabilities.find((c) => c.id === 'mcp:playwright')
    // 需求名保留声明的原样（含版本/dist-tag）——剥版本是 classifyRuntimeNeed 的事。
    expect(playwright?.needs.runtime).toEqual(['@playwright/mcp@next'])

    const codegraph = capabilities.find((c) => c.id === 'mcp:codegraph')
    expect(codegraph?.needs.runtime).toEqual(['/opt/tools/codegraph'])

    const tavily = capabilities.find((c) => c.id === 'mcp:tavily')
    expect(tavily?.needs.network).toEqual(['https://api.tavily.com?tavilyApiKey=sk-live-xxx'])
    expect(tavily?.note).toContain('凭据内嵌在 URL 里')
    // 内嵌在 URL 里的凭据不是 env 字面量，所以不该出现在 secrets 里——
    // 它跟着这条能力的 URL 一起走，不是另一个搬运项。
    expect(tavily?.needs.secrets).toBeUndefined()
  })

  it('字符串与数组两种 command 都认', () => {
    expect(capabilityFromMcp('a', { command: 'npx -y pkg@1' }).needs.runtime).toEqual(['pkg@1'])
    expect(capabilityFromMcp('b', { command: ['npx', '-y', 'pkg@1'] }).needs.runtime).toEqual(['pkg@1'])
  })

  it('只有名字像密钥的字面量才算密钥需求（不为了「完整」搬一堆环境变量）', () => {
    expect(looksSecret('GITHUB_TOKEN')).toBe(true)
    expect(looksSecret('OPENAI_API_KEY')).toBe(true)
    expect(looksSecret('SEARXNG_URL')).toBe(false)
    expect(looksSecret('LOG_LEVEL')).toBe(false)
    const withSecret = capabilityFromMcp('s', { command: 'npx x', environment: { API_KEY: 'sk-1', REGION: 'cn' } })
    expect(withSecret.needs.secrets).toEqual(['API_KEY'])
  })

  it('已经是引用的值不再要求搬运（{env:…}/{file:…} 本来就是间接层）', () => {
    const capability = capabilityFromMcp('s', { command: 'npx x', environment: { API_KEY: '{env:MY_KEY}' } })
    expect(capability.needs.secrets).toBeUndefined()
  })

  it('配置里没有 mcp 时不报错，返回空清单', () => {
    expect(capabilitiesFromConfig({})).toEqual([])
    expect(capabilitiesFromConfig({ mcp: { servers: { bad: 'string' } } })).toEqual([])
  })
})

describe('npx 改写（D13：运行期不再依赖 npx 联网）', () => {
  it('`npx -y pkg` → 预装入口', () => {
    expect(rewriteNpxCommand('npx -y mcp-searxng', '/home/demo/.ocrc/runtime/bin/mcp-searxng'))
      .toBe('/home/demo/.ocrc/runtime/bin/mcp-searxng')
  })

  it('保留包后面的参数', () => {
    expect(rewriteNpxCommand('npx @playwright/mcp@next --cdp-endpoint http://127.0.0.1:9222', '/opt/ocrc/pw'))
      .toBe('/opt/ocrc/pw --cdp-endpoint http://127.0.0.1:9222')
  })

  it('不是 npx/bunx 的命令不改写', () => {
    expect(rewriteNpxCommand('/opt/tools/codegraph serve', '/x')).toBeNull()
  })

  it('改写落到配置副本上：原始配置不动，改了什么逐条列出来', () => {
    const { config, rewritten } = applyNpxRewrites(REAL_CONFIG, { 'mcp-searxng': '/opt/ocrc/searxng' })
    expect(rewritten).toEqual([{ capability: 'mcp:searxng', from: 'npx mcp-searxng', to: '/opt/ocrc/searxng' }])
    const servers = (config.mcp as { servers: Record<string, { command: unknown }> }).servers
    expect(servers.searxng.command).toBe('/opt/ocrc/searxng')
    // 没装的那个保持原样，不做半截改写。
    expect(servers.playwright.command).toBe('npx @playwright/mcp@next --cdp-endpoint http://127.0.0.1:9222')
    // 原件不动。
    const original = (REAL_CONFIG.mcp.servers.searxng as { command: string })
    expect(original.command).toBe('npx mcp-searxng')
  })

  it('包名带版本时按不带版本的名字查表', () => {
    const { rewritten } = applyNpxRewrites(REAL_CONFIG, { '@playwright/mcp': '/opt/ocrc/pw' })
    expect(rewritten.map((r) => r.capability)).toEqual(['mcp:playwright'])
  })

  it('没有可改写的目标时返回原样', () => {
    const { config } = applyNpxRewrites({ mcp: { servers: { x: { command: '/usr/bin/x' } } } }, {})
    expect((config.mcp as { servers: Record<string, { command: string }> }).servers.x.command).toBe('/usr/bin/x')
  })
})

describe('运行时需求分类（D12：npm 规格 vs 目标机上的绝对路径）', () => {
  it('规格串里的版本只取末尾那一段（scoped 包名前导的 @ 不算）', () => {
    expect(packageVersionOf('pkg@1.2.3')).toBe('1.2.3')
    expect(packageVersionOf('pkg@next')).toBe('next')
    expect(packageVersionOf('@playwright/mcp@next')).toBe('next')
    expect(packageVersionOf('@playwright/mcp')).toBeUndefined()
    expect(packageVersionOf('mcp-searxng')).toBeUndefined()
  })

  it('绝对路径不进 npm 通道，npm 规格剥出版本', () => {
    expect(classifyRuntimeNeed('/opt/tools/codegraph')).toEqual({ raw: '/opt/tools/codegraph', kind: 'path', name: '/opt/tools/codegraph' })
    expect(classifyRuntimeNeed('~/bin/foo')).toEqual({ raw: '~/bin/foo', kind: 'path', name: '~/bin/foo' })
    expect(classifyRuntimeNeed('mcp-searxng')).toEqual({ raw: 'mcp-searxng', kind: 'npm', name: 'mcp-searxng', version: undefined })
    expect(classifyRuntimeNeed('@playwright/mcp@next')).toEqual({ raw: '@playwright/mcp@next', kind: 'npm', name: '@playwright/mcp', version: 'next' })
  })

  it('需求量去重，并且每个需求都记得是谁要它', () => {
    const packages = [
      { id: 'mcp:a', label: 'a', where: 'remote' as const, needs: { runtime: ['mcp-searxng', 'node'] } },
      { id: 'mcp:b', label: 'b', where: 'remote' as const, needs: { runtime: ['mcp-searxng'] } },
      { id: 'mcp:c', label: 'c', where: 'remote' as const, needs: {} },
    ]
    const needs = runtimeNeedsOf(packages)
    expect(needs.map((n) => n.need.raw)).toEqual(['mcp-searxng', 'node'])
    expect(needs[0].neededBy).toEqual(['mcp:a', 'mcp:b'])
    expect(needs[1].neededBy).toEqual(['mcp:a'])
  })
})
