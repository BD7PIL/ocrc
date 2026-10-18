import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import type { GuestRequestMethod, GuestRequestResult } from '@openchamber/sdk'
import { RemoteInstance } from './RemoteInstance.js'

/**
 * 远程服务器卡片的「不撒谎」清单：
 *   · 每条事实只出现一次（地址不再既进标题又进第二行；网络不再同时进徽标、摘要、详情）；
 *   · 字段顺序固定，缺的写「未知」——两台机器不许显示成两个产品；
 *   · 主动作随状态推进（未安装 → 检查并安装；已停止 → 启动；在线 → 打开界面 + 停止）；
 *   · 安装必须两步：先检查（只读）、再二次确认；
 *   · 移除服务器要二次确认；service 不可达时如实报，不装成空列表。
 */

type Call = { path: string; method: GuestRequestMethod; body: unknown }

function fakeRequest(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = []
  const request = async (path: string, method: GuestRequestMethod = 'GET', body?: unknown): Promise<GuestRequestResult> => {
    const call = { path, method, body }
    calls.push(call)
    const r = handler(call)
    return { status: r.status, body: JSON.stringify(r.body) }
  }
  return { request, calls }
}

const STUB_HOST = { openUrl: async () => {}, writeClipboard: async () => {} } as never

const ROW = {
  id: 'demo@192.168.26.101', host: '192.168.26.101', user: 'demo', port: 22,
  instancePort: 2610, localPort: 4610, appVersion: '2.3.3', enabled: true, name: 'EL7 box',
  reconnect: true, restoreOnStart: true, hasUiPassword: true,
  sshAuth: 'key' as const, provision: 'push' as const, egress: 'auto' as const,
  status: {
    state: 'online', detail: '远端实例在线；隧道由桌面版持有', url: 'http://127.0.0.1:4610',
    app: '2.3.3',
    engine: { path: '/home/demo/.ocrc/remote/engine/opencode', version: '2.0.27' },
    runtime: 'v24.22.0', proxy: { enabled: true, localPort: 4711, remotePort: 2711 },
    egress: { mode: 'auto', relay: true, reason: '远程机器出不了网', probe: 'none', cached: true },
  },
}

/** 没装过：探测不到 OpenCode，状态停在未检查。 */
const FRESH = {
  ...ROW, id: 'root@10.0.0.5', host: '10.0.0.5', user: 'root', name: '新机器',
  status: { state: 'unknown', url: 'http://127.0.0.1:4614', detail: '还没有检查过' },
}

/** 装过但停了。 */
const STOPPED = {
  ...ROW, id: 'ubuntu@100.100.69.3', host: '100.100.69.3', user: 'ubuntu', name: 'Ubuntu 26.04',
  status: { ...ROW.status, state: 'offline', app: '2.3.3', egress: { mode: 'auto', relay: false, reason: '远程机器自己能出网', cached: true } },
}

const DEFAULTS = {
  localPort: 4612, instancePort: 2610, appVersion: '2.3.3', enginePin: '2.0.27',
  nodeRuntime: '24.22.0', bind: '127.0.0.1', taken: [4610],
}

const PLAN = {
  reachable: true,
  inspected: { uname: 'Linux x86_64', glibc: '2.17', home: '/home/demo' },
  runtime: 'v24.22.0', app: '2.3.3',
  engine: undefined, engineError: '远程机器上没有找到满足 v2 门禁的 OpenCode',
  engineCandidates: [{ path: '/home/demo/.local/bin/opencode', raw: '1.18.32' }],
  actions: ['推送我们 pin 的 OpenCode 2.0.27 到 ~/.ocrc/remote/engine/opencode', '建转发'],
  url: 'http://127.0.0.1:4610',
  egress: { mode: 'auto', relay: true, reason: '远程机器出不了网', probe: 'none' },
  provision: 'push' as const,
  tier: 'legacy',
  peerPort: 'closed' as const,
}

describe('远程服务器卡片', () => {
  it('三行固定字段：名称+状态 / 地址+登录方式 / 版本+网络；地址只出现一次', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [ROW] } }))
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('EL7 box')).toBeTruthy())
    expect(screen.getByText('在线')).toBeTruthy()
    // 地址：只在第二行出现一次（它曾经既进标题又进第二行）
    expect(screen.getAllByText(/demo@192\.168\.26\.101:22 · 密钥登录/)).toHaveLength(1)
    expect(screen.getByText(/OpenChamber 2\.3\.3 · OpenCode 2\.0\.27 · 经本机转发/)).toBeTruthy()
    // 在线不解释自己；详情默认收起
    expect(screen.queryByText(/隧道由桌面版持有/)).toBeNull()
    expect(screen.queryByText('/home/demo/.ocrc/remote/engine/opencode')).toBeNull()
  })

  it('缺的字段写「未知」，不省字段（两台机器不许显示成两个产品）', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [FRESH] } }))
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('新机器')).toBeTruthy())
    expect(screen.getByText(/OpenChamber 未知 · OpenCode 未知 · 未探测/)).toBeTruthy()
  })

  it('主动作随状态推进：未安装→检查并安装，已停止→启动，在线→打开界面+停止', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [FRESH, STOPPED, ROW] } }))
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('新机器')).toBeTruthy())
    expect(screen.getByText('检查并安装')).toBeTruthy()
    expect(screen.getByText('启动')).toBeTruthy()
    expect(screen.getByText('打开界面')).toBeTruthy()
    expect(screen.getByText('停止')).toBeTruthy()
    // 没装过的机器不摆配对链接（它要求实例在跑）
    expect(screen.getAllByText('创建配对链接')).toHaveLength(2)
  })

  it('安装两步：先检查（只读），再二次确认才 apply', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [FRESH] } }
      if (body?.op === 'plan') return { status: 200, body: PLAN }
      if (body?.op === 'apply') return { status: 200, body: { ok: true, detail: '已推送 2.3.3' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('检查并安装')).toBeTruthy())

    await act(async () => { screen.getByText('检查并安装').click() })
    await waitFor(() => expect(screen.getByText('检查结果（只读，不写远程机器）')).toBeTruthy())
    expect(screen.getByText(/1.18.32/)).toBeTruthy()
    expect(screen.getByText(/推送我们 pin 的 OpenCode/)).toBeTruthy()
    expect(calls.filter((c) => (c.body as { op?: string })?.op === 'apply')).toHaveLength(0)

    await act(async () => { screen.getByText(/安装到远程机器/).click() })
    await waitFor(() => expect(screen.getByText('确认安装')).toBeTruthy())
    expect(calls.filter((c) => (c.body as { op?: string })?.op === 'apply')).toHaveLength(0)

    await act(async () => { screen.getByText('确认安装').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'apply')).toBe(true))
    const apply = calls.find((c) => (c.body as { op?: string })?.op === 'apply')
    expect(apply?.body).toMatchObject({ id: FRESH.id, payload: { confirm: true } })
  })

  it('service 不可达时如实报，不装成空列表', async () => {
    const { request } = fakeRequest(() => ({ status: 502, body: { error: '控制端 service 不可达：connect ECONNREFUSED' } }))
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText(/控制端 service 不可达/)).toBeTruthy())
  })

  it('「更多」按配置/维护分组，默认收起；移除要二次确认', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('EL7 box')).toBeTruthy())
    // 次要动作默认不在屏上
    expect(screen.queryByText('配置差异与同步')).toBeNull()
    expect(screen.queryByText('移除服务器')).toBeNull()

    await act(async () => { screen.getByText('更多 ▾').click() })
    await waitFor(() => expect(screen.getByText('配置差异与同步')).toBeTruthy())
    for (const label of ['配置', '维护', '界面密码', '检查并更新', '日志', '编辑', '移除服务器', '自动重连', '服务重启后恢复']) {
      expect(screen.getByText(label)).toBeTruthy()
    }

    // 移除：先问一次，确认才真的删
    await act(async () => { screen.getByText('移除服务器').click() })
    await waitFor(() => expect(screen.getByText('确认移除')).toBeTruthy())
    expect(calls.some((c) => (c.body as { op?: string })?.op === 'delete')).toBe(false)
    await act(async () => { screen.getByText('确认移除').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'delete')).toBe(true))
  })

  it('详情里放事实：端口、OpenCode 路径、转发、探测原因；网络只在详情出现第二次', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [ROW] } }))
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('EL7 box')).toBeTruthy())
    await act(async () => { screen.getByText('详情 ▾').click() })
    await waitFor(() => expect(screen.getByText('端口：远程 2610 → 本机 4610（绑定 127.0.0.1）')).toBeTruthy())
    expect(screen.getByText('OpenCode：/home/demo/.ocrc/remote/engine/opencode')).toBeTruthy()
    expect(screen.getByText('运行时：node v24.22.0')).toBeTruthy()
    expect(screen.getByText('本机转发：:4711 → :2711')).toBeTruthy()
    expect(screen.getByText(/联网方式：auto，探测 none —— 远程机器出不了网/)).toBeTruthy()
  })

  it('创建配对链接：拿到链接后能复制、能重新创建', async () => {
    const LINK = 'openchamber://connect?v=2&p=eyJ2IjoyfQ'
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'pairlink') {
        return { status: 200, body: { ok: true, detail: '配对链接已生成（远程实例在跑）', link: LINK, expiresAt: '2026-10-17T12:00:00Z' } }
      }
      return { status: 200, body: {} }
    })
    const clipboard: string[] = []
    const host = { openUrl: async () => {}, writeClipboard: async (t: string) => { clipboard.push(t) } } as never
    await act(async () => { render(<RemoteInstance request={request} host={host} />) })
    await waitFor(() => expect(screen.getByText('创建配对链接')).toBeTruthy())

    await act(async () => { screen.getByText('创建配对链接').click() })
    await waitFor(() => expect(screen.getByText(LINK)).toBeTruthy())
    expect(screen.getAllByText(/其他 OpenChamber 服务器/).length).toBeGreaterThan(0)

    await act(async () => { screen.getByText('复制链接').click() })
    await waitFor(() => expect(clipboard).toContain(LINK))
    // 宿主对 open-url 只放行 http(s)，深链点不动——所以卡片里没有"在 app 里打开"，
    // 改说清去哪里粘（app 的服务器列表 →「导入链接」）。
    expect(screen.queryByText('在 app 里打开')).toBeNull()
    expect(screen.getAllByText(/导入链接/).length).toBeGreaterThan(0)

    await act(async () => { screen.getByText('重新创建').click() })
    await waitFor(() => expect(calls.filter((c) => (c.body as { op?: string })?.op === 'pairlink')).toHaveLength(2))
  })

  it('配置差异：先看差异，删除要勾选，同步前可试运行', async () => {
    const DIFF = {
      localDir: '/home/u/.config/opencode',
      add: ['skill/new.md'], change: ['opencode.json'], same: [], peerOnly: ['agent/old.md'], unknown: [],
      auth: { local: true, peer: false },
      plan: {
        basename: 'opencode.json', configChanged: true, files: ['opencode.json', 'skill/new.md'], deletes: [],
        keyDeletes: { requested: [], removed: [] },
        keyDeleteCandidates: [{ collection: 'provider', key: 'acc-provider' }],
        droppedManagedKeys: ['plugin'], secretsReplaced: [], baseUrlRewrites: [], shadowed: [],
        notes: ['远程独有的 1 个文件不会被动（要删得显式勾选）'],
      },
    }
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'configdiff') return { status: 200, body: DIFF }
      if (body?.op === 'syncconfig') return { status: 200, body: { ok: true, detail: '同步 2 个文件' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('更多 ▾').click() })
    await act(async () => { screen.getByText('配置差异与同步').click() })
    await waitFor(() => expect(screen.getByText(/配置差异（控制端 ↔ 远程机器/)).toBeTruthy())
    expect(screen.getByText(/\+ skill\/new\.md/)).toBeTruthy()
    expect(screen.getByText('文件 agent/old.md')).toBeTruthy()
    expect(screen.getByText('配置项 provider:acc-provider')).toBeTruthy()

    await act(async () => { screen.getByText('试运行（不写远程机器）').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'syncconfig')).toBe(true))
    let last = calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig').pop()
    expect((last?.body as { payload: { dryRun: boolean; deletes: string[]; keyDeletes: string[] } }).payload)
      .toEqual({ dryRun: true, deletes: [], keyDeletes: [] })

    await act(async () => { screen.getByText('配置项 provider:acc-provider').click() })
    await act(async () => { screen.getByText('同步配置').click() })
    await waitFor(() => expect(calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig')).toHaveLength(2))
    last = calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig').pop()
    expect((last?.body as { payload: { dryRun: boolean; keyDeletes: string[] } }).payload)
      .toMatchObject({ dryRun: false, keyDeletes: ['provider:acc-provider'] })
  })

  it('表单是安装输入：登录方式/安装方式/联网方式都在，自动决定的值只显示不给控件', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [] } }
      if (body?.op === 'defaults') return { status: 200, body: DEFAULTS }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('添加服务器').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'defaults')).toBe(true))
    expect((screen.getByDisplayValue('4612') as HTMLInputElement).value).toBe('4612')
    expect(screen.getByText('登录方式')).toBeTruthy()
    expect(screen.getByText('安装方式')).toBeTruthy()
    expect(screen.getByText('联网方式')).toBeTruthy()
    expect(screen.getByText('服务器名称')).toBeTruthy()
    expect(screen.getByText(/兼容档：按远程机器 glibc 判定/)).toBeTruthy()
    expect(screen.getByText(/OpenCode pin：2\.0\.27/)).toBeTruthy()
    expect(screen.getByText(/绑定：127\.0\.0\.1/)).toBeTruthy()
    // 默认密钥档：不显示密码框
    expect(screen.queryByText('SSH 密码')).toBeNull()
  })
})
