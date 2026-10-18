import { describe, expect, it } from 'vitest'
import type { CapabilityPackage, ForwardSpec } from '../shared/provision.js'
import { isPanelLocal, parseAddress, planForwards, settleForwardPorts, toForwardRuntime } from './tunnels.js'

const never = async () => false
const always = async () => true

const pkg = (over: Partial<CapabilityPackage>): CapabilityPackage => ({
  id: 'mcp:x', label: 'MCP x', where: 'remote', needs: {}, ...over,
})

describe('parseAddress', () => {
  it('从内网地址里拆 host/port（实机上的 searxng 就是这一条）', () => {
    expect(parseAddress('http://192.168.96.11:8080')).toMatchObject({ host: '192.168.96.11', port: 8080 })
    expect(parseAddress('https://api.tavily.com')).toMatchObject({ host: 'api.tavily.com', port: 443 })
    expect(parseAddress('http://127.0.0.1:9222')).toMatchObject({ host: '127.0.0.1', port: 9222 })
  })

  it('非 http(s) 或不成形的地址不猜', () => {
    expect(parseAddress('postgres://db:5432')).toBeNull()
    expect(parseAddress('not a url')).toBeNull()
  })
})

describe('planForwards（D12/D14/D15）', () => {
  it('远端能力的内网地址不加隧道——它用被控端自己的路由', async () => {
    const plan = await planForwards([pkg({ needs: { network: ['http://192.168.96.11:8080'] } })], { panelReachable: never })
    expect(plan.specs).toEqual([])
    expect(plan.notes.join()).toContain('被控端自己的路由')
  })

  it('面板侧能力够不着的地址 → 补一条 -L，并把 URL 重写到实际端口', async () => {
    const plan = await planForwards(
      [pkg({ where: 'panel', label: '浏览器', needs: { network: ['http://192.168.96.11:8080'] } })],
      { panelReachable: never, allocatePort: async () => 41873 },
    )
    expect(plan.specs).toEqual([
      { direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 41873, reason: '浏览器（面板侧能力）需要 192.168.96.11:8080' },
    ])
    expect(plan.rewrites).toEqual([{ from: 'http://192.168.96.11:8080', to: 'http://127.0.0.1:41873' }])
  })

  it('面板已经够得着就不加隧道（公网 MCP 不该被绕进隧道）', async () => {
    const plan = await planForwards([pkg({ where: 'panel', needs: { network: ['https://api.tavily.com'] } })], { panelReachable: always })
    expect(plan.specs).toEqual([])
    expect(plan.notes.join()).toContain('面板已达')
  })

  it('面板本机地址永远不转发——那会把自己套进隧道', async () => {
    const plan = await planForwards([pkg({ where: 'panel', needs: { network: ['http://127.0.0.1:9222'] } })], { panelReachable: never })
    expect(plan.specs).toEqual([])
    expect(isPanelLocal('localhost')).toBe(true)
    expect(isPanelLocal('192.168.96.11')).toBe(false)
  })

  it('每个端口单独分配，不写死也不复用', async () => {
    let next = 40000
    const plan = await planForwards(
      [pkg({ where: 'panel', needs: { network: ['http://a.lan:8080', 'http://b.lan:9090'] } })],
      { panelReachable: never, allocatePort: async () => (next += 1) },
    )
    expect(plan.specs.map((s) => s.port)).toEqual([40001, 40002])
  })

  it('重写的端口与 specs 对得上（面板要能逐条看到改了哪个 URL）', async () => {
    const plan = await planForwards(
      [pkg({ where: 'panel', id: 'mcp:s', label: 'searxng', needs: { network: ['http://192.168.96.11:8080'] } })],
      { panelReachable: never, allocatePort: async () => 41000 },
    )
    const [runtime] = toForwardRuntime(plan.specs, plan.rewrites)
    expect(runtime.activePort).toBe(41000)
    expect(runtime.rewrites).toEqual([{ from: 'http://192.168.96.11:8080', to: 'http://127.0.0.1:41000' }])
  })

  it('不成形的地址如实记一笔，而不是静默跳过', async () => {
    const plan = await planForwards([pkg({ where: 'panel', needs: { network: ['db.internal:5432'] } })], { panelReachable: never })
    expect(plan.specs).toEqual([])
    expect(plan.notes.join()).toContain('无法为它补隧道')
  })
})

describe('settleForwardPorts（D15：能力转发端口是实现细节，占用就换）', () => {
  const spec = (port: number, reason = 'searxng'): ForwardSpec => ({ direction: 'local', peerHost: '10.0.0.5', peerPort: 8080, port, reason })

  it('端口空着就原样用', async () => {
    const { settled, changed } = await settleForwardPorts([spec(4601)], { isFree: async () => true, allocate: async () => 4700 })
    expect(settled[0].port).toBe(4601)
    expect(changed).toEqual([])
  })

  it('端口被占用 → 换一个空闲的，并如实报出换了什么', async () => {
    const busy = new Set([4601])
    const { settled, changed } = await settleForwardPorts([spec(4601)], {
      isFree: async (p) => !busy.has(p),
      allocate: async () => 4702,
    })
    expect(settled[0].port).toBe(4702)
    expect(changed).toEqual([{ reason: 'searxng', from: 4601, to: 4702 }])
  })

  it('同一批里不重复用同一个端口（allocator 给重复值时继续要）', async () => {
    const busy = new Set([4601, 4602])   // 两个请求的端口都被占
    const allocated = [4700, 4700, 4701] // 第一次重复给 4700
    const { settled } = await settleForwardPorts([spec(4601), spec(4602)], {
      isFree: async (p) => !busy.has(p),
      allocate: async () => allocated.shift() ?? 4799,
    })
    expect(new Set(settled.map((s) => s.port)).size).toBe(2)
    expect(settled.map((s) => s.port)).toEqual([4700, 4701])
  })

  it('实在找不到空闲端口时抛，而不是给一个可能冲突的端口', async () => {
    await expect(settleForwardPorts([spec(4601)], { isFree: async () => false, allocate: async () => 4700 }))
      .rejects.toThrow(/没有可用的本地端口/)
  })
})
