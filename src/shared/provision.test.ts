import { describe, expect, it } from 'vitest'
import {
  applyPortChanges, engineBinaryName, installDirFor, isSupportedEngineVersion, MINIMUM_NODE_MAJOR,
  platformPackage, readinessAction, runtimeDirFor, runtimeDirName, runtimeRootFor, type PortChange,
} from './provision.js'

describe('引擎版本门禁', () => {
  it('只认 2.x 且不低于 2.0.20（与 openchamber 的 compatibility 判据一致）', () => {
    expect(isSupportedEngineVersion('2.0.20')).toBe(true)
    expect(isSupportedEngineVersion('2.0.27')).toBe(true)
    expect(isSupportedEngineVersion('2.1.0')).toBe(true)
    expect(isSupportedEngineVersion('2.0.19')).toBe(false)
    expect(isSupportedEngineVersion('1.18.34')).toBe(false)
    expect(isSupportedEngineVersion('3.0.0')).toBe(false)
    expect(isSupportedEngineVersion('v2.0.27')).toBe(false)
  })
})

describe('落点与包名', () => {
  it('官方安装脚本的落点约定', () => {
    expect(installDirFor('/home/demo/')).toBe('/home/demo/.opencode/bin')
    expect(engineBinaryName('linux-x64')).toBe('opencode')
    expect(engineBinaryName('win32-x64')).toBe('opencode.exe')
  })

  it('平台包名：baseline 只在官方发过这个变体时选', () => {
    expect(platformPackage('linux-x64', 'default')).toBe('@opencode/cli-linux-x64')
    expect(platformPackage('linux-x64', 'baseline')).toBe('@opencode/cli-linux-x64-baseline')
    expect(platformPackage('darwin-arm64', 'default')).toBe('@opencode/cli-darwin-arm64')
    expect(platformPackage('win32-x64', 'default')).toBe('@opencode/cli-windows-x64')
  })

  it('运行时落点：包名进目录不留层级，node 下限是常量', () => {
    expect(runtimeDirName('@playwright/mcp')).toBe('playwright__mcp')
    expect(runtimeDirName('mcp-searxng')).toBe('mcp-searxng')
    expect(runtimeDirFor('/home/demo', '@playwright/mcp', 'latest')).toBe('/home/demo/.ocrc/runtime/playwright__mcp/latest')
    expect(runtimeRootFor('/home/demo')).toBe('/home/demo/.ocrc/runtime')
    expect(MINIMUM_NODE_MAJOR).toBe(20)
  })
})

describe('就绪四档的动作话术', () => {
  it('每一档都给出「能做的事」，没有一档是「部分可用」', () => {
    for (const id of ['ssh', 'shell', 'engine', 'project'] as const) {
      const action = readinessAction(id)
      expect(action.length).toBeGreaterThan(10)
      expect(action).not.toContain('部分')
    }
  })
})

describe('端口被换掉之后，URL 改写跟着换', () => {
  const rewrites = [
    { from: 'http://192.168.96.11:8080', to: 'http://127.0.0.1:18080' },
    { from: 'https://api.tavily.com', to: 'https://api.tavily.com' },
  ]
  const changes: PortChange[] = [{ reason: 'searxng', from: 18080, to: 18081 }]

  it('没有任何端口变化时原样返回（同一个数组，不改写）', () => {
    expect(applyPortChanges(rewrites, [])).toBe(rewrites)
  })

  it('换过的端口出现在 to 侧，没换的不要动', () => {
    const next = applyPortChanges(rewrites, changes)
    expect(next[0].to).toBe('http://127.0.0.1:18081')
    expect(next[1]).toEqual(rewrites[1])
    // from 侧（能力自己的地址）永远不改——那是用户配的东西。
    expect(next[0].from).toBe('http://192.168.96.11:8080')
  })

  it('带路径的写法也能换（:18080/path）', () => {
    const next = applyPortChanges([{ from: 'http://x:8080', to: 'http://127.0.0.1:18080/tavily' }], changes)
    expect(next[0].to).toBe('http://127.0.0.1:18081/tavily')
  })

  it('只是数字里凑巧含相同片段时不误伤（1808 vs 18080）', () => {
    const next = applyPortChanges([{ from: 'http://x', to: 'http://127.0.0.1:1808' }], changes)
    expect(next[0].to).toBe('http://127.0.0.1:1808')
  })
})
