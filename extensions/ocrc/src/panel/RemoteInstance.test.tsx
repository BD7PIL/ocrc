import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  id: 'user@192.0.2.10', host: '192.0.2.10', user: 'user', port: 22,
  instancePort: 2610, localPort: 4610, appVersion: '2.3.3', enabled: true, name: 'EL7 box',
  reconnect: true, restoreOnStart: true, hasUiPassword: true,
  sshAuth: 'key' as const, provision: 'push' as const, egress: 'auto' as const,
  status: {
    state: 'online', detail: '远端实例在线；隧道由桌面版持有', url: 'http://127.0.0.1:4610',
    app: '2.3.3',
    engine: { path: '/home/user/.ocrc/remote/engine/opencode', version: '2.0.27' },
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
  inspected: { uname: 'Linux x86_64', glibc: '2.17', home: '/home/user' },
  runtime: 'v24.22.0', app: '2.3.3',
  engine: undefined, engineError: '远程机器上没有找到满足 v2 门禁的 OpenCode',
  engineCandidates: [{ path: '/home/user/.local/bin/opencode', raw: '1.18.32' }],
  actions: ['推送我们 pin 的 OpenCode 2.0.27 到 ~/.ocrc/remote/engine/opencode', '建转发'],
  url: 'http://127.0.0.1:4610',
  egress: { mode: 'auto', relay: true, reason: '远程机器出不了网', probe: 'none' },
  provision: 'push' as const,
  tier: 'legacy',
  peerPort: 'closed' as const,
}

/** 最小差异卡：无差异、无删除候选，供 syncauth 等动作测试复用。 */
const DIFF_MIN = {
  localDir: '/home/u/.config/opencode',
  add: [], change: [], same: [], peerOnly: [], unknown: [],
  auth: { local: true, peer: true },
  plan: {
    basename: 'opencode.json', configChanged: false, files: [], deletes: [],
    keyDeletes: { requested: [], removed: [] },
    keyDeleteCandidates: [], droppedManagedKeys: [], secretsReplaced: [], baseUrlRewrites: [], shadowed: [],
    notes: [],
  },
}

describe('远程服务器卡片', () => {
  it('三行固定字段：名称+状态 / 地址+登录方式 / 版本+网络；地址只出现一次', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [ROW] } }))
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('EL7 box')).toBeTruthy())
    expect(screen.getByText('在线')).toBeTruthy()
    // 地址：只在第二行出现一次（它曾经既进标题又进第二行）
    expect(screen.getAllByText(/user@192\.0\.2\.10:22 · 密钥登录/)).toHaveLength(1)
    expect(screen.getByText(/OpenChamber 2\.3\.3 · OpenCode 2\.0\.27 · 经本机转发/)).toBeTruthy()
    // 在线不解释自己；详情默认收起
    expect(screen.queryByText(/隧道由桌面版持有/)).toBeNull()
    expect(screen.queryByText('/home/user/.ocrc/remote/engine/opencode')).toBeNull()
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

  it('「更多」菜单收低频动作（配置/密码/编辑/移除）；检查更新与日志是可见按钮', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('EL7 box')).toBeTruthy())
    // 日志不再藏在折叠里（「检查更新」只出现在未在线的机器，由升级链路用例断言）
    expect(screen.getByText('日志')).toBeTruthy()
    // 低频动作默认不在屏上
    expect(screen.queryByText('配置差异与同步')).toBeNull()
    expect(screen.queryByText('移除服务器')).toBeNull()

    await act(async () => { screen.getByText('更多').click() })
    await waitFor(() => expect(screen.getByText('配置差异与同步')).toBeTruthy())
    for (const label of ['配置差异与同步', '界面密码', '编辑', '移除服务器']) {
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
    expect(screen.getByText('OpenCode：/home/user/.ocrc/remote/engine/opencode')).toBeTruthy()
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
    await act(async () => { screen.getByText('更多').click() })
    await act(async () => { screen.getByText('配置差异与同步').click() })
    await waitFor(() => expect(screen.getByText(/配置差异（控制端 ↔ 远程机器/)).toBeTruthy())
    expect(screen.getByText(/\+ skill\/new\.md/)).toBeTruthy()
    expect(screen.getByText('文件 agent/old.md')).toBeTruthy()
    expect(screen.getByText('配置项 provider:acc-provider')).toBeTruthy()

    await act(async () => { screen.getByText('试运行（不写远程机器）').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'syncconfig')).toBe(true))
    let last = calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig').pop()
    expect(last).toBeTruthy()
    expect((last as { body: { payload: { dryRun: boolean; deletes: string[]; keyDeletes: string[] } } }).body.payload)
      .toEqual({ dryRun: true, deletes: [], keyDeletes: [] })

    await act(async () => { screen.getByText('配置项 provider:acc-provider').click() })
    await act(async () => { screen.getByText('同步配置').click() })
    await waitFor(() => expect(calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig')).toHaveLength(2))
    last = calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig').pop()
    expect(last).toBeTruthy()
    expect((last as { body: { payload: { dryRun: boolean; keyDeletes: string[] } } }).body.payload)
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

  // ── op 补齐：18 个 op 里前两组测试只点过 8 个，这里把剩余的可点面钉住 ──────────

  it('添加：表单提交走 add op（含表单里的端口与安装方式），成功后表单收起', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [] } }
      if (body?.op === 'defaults') return { status: 200, body: DEFAULTS }
      if (body?.op === 'add') return { status: 200, body: { ok: true } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('添加服务器').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'defaults')).toBe(true))

    // 主机留空 → 前端拦截，不发 add
    await act(async () => { screen.getByText('添加').click() })
    expect(calls.some((c) => (c.body as { op?: string })?.op === 'add')).toBe(false)
    expect(screen.getByText('需要主机地址')).toBeTruthy()

    // KitField listens to the native `input` event (not React onChange), and
    // the kit pushes props through an effect after each render — so each
    // keystroke needs its own act batch (in a browser, discrete input events
    // are separate tasks and React flushes synchronously between them).
    await act(async () => {
      fireEvent.input(screen.getByPlaceholderText('192.0.2.10 或主机名'), { target: { value: '10.1.2.3' } })
    })
    await act(async () => {
      fireEvent.input(screen.getByPlaceholderText('demo（留空=本机当前用户）'), { target: { value: 'root' } })
    })
    await act(async () => { screen.getByText('添加').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'add')).toBe(true))
    const add = calls.find((c) => (c.body as { op?: string })?.op === 'add')
    expect(add?.body).toMatchObject({
      payload: { host: '10.1.2.3', user: 'root', port: 22, sshAuth: 'key', provision: 'push', egress: 'auto' },
    })
    // 成功后表单收起（回到列表态）。
    await waitFor(() => expect(screen.queryByText('SSH 端口')).toBeNull())
  })

  it('启动/停止：STOPPED 卡发 up，在线卡发 down（带实例 id）', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [STOPPED, ROW] } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('启动')).toBeTruthy())

    await act(async () => { screen.getByText('启动').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'up')).toBe(true))
    expect(calls.find((c) => (c.body as { op?: string })?.op === 'up')?.body).toMatchObject({ id: STOPPED.id })

    await act(async () => { screen.getByText('停止').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'down')).toBe(true))
    expect(calls.find((c) => (c.body as { op?: string })?.op === 'down')?.body).toMatchObject({ id: ROW.id })
  })

  it('打开界面：走 url op 再交给宿主 openUrl', async () => {
    const opened: string[] = []
    const host = { openUrl: async (u: string) => { opened.push(u) }, writeClipboard: async () => {} } as never
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'url') return { status: 200, body: { url: 'http://127.0.0.1:4610' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={host} />) })
    await waitFor(() => expect(screen.getByText('打开界面')).toBeTruthy())
    await act(async () => { screen.getByText('打开界面').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'url')).toBe(true))
    await waitFor(() => expect(opened).toEqual(['http://127.0.0.1:4610']))
  })

  it('日志：logs 与 peerlog 两连发，三段都进同一张卡', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'logs') return { status: 200, body: { lines: ['forward line 1', 'forward line 2'] } }
      if (body?.op === 'peerlog') {
        return {
          status: 200, body: {
            ok: true,
            paths: { instance: '/home/user/.ocrc/remote/instance.log', app: '/home/user/.openchamber/openchamber.log' },
            instance: ['instance line'], app: ['app line'],
          },
        }
      }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('日志').click() })
    await waitFor(() => expect(screen.getByText(/日志（三处/)).toBeTruthy())
    expect(screen.getByText(/实时刷新中 · 每 5 秒/)).toBeTruthy()
    // 日志行都在同一个 <pre> 文本节点里（join('\n')），按整段断言。
    expect(screen.getByText(/forward line 1[\s\S]*forward line 2/)).toBeTruthy()
    expect(screen.getByText(/instance line/)).toBeTruthy()
    expect(screen.getByText(/app line/)).toBeTruthy()
    expect(calls.find((c) => (c.body as { op?: string })?.op === 'logs')?.body).toMatchObject({ id: ROW.id })
    expect(calls.find((c) => (c.body as { op?: string })?.op === 'peerlog')?.body).toMatchObject({ id: ROW.id })
  })

  it('开关在详情里：自动重连/服务重启后恢复各发一个 patch（只带那一个字段）', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('详情 ▾').click() })
    await waitFor(() => expect(screen.getAllByText('自动重连').length).toBeGreaterThan(0))

    const reconnectSwitch = screen.getByRole('switch', { name: '自动重连' }) as HTMLInputElement
    await act(async () => { fireEvent.click(reconnectSwitch) })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'patch')).toBe(true))
    expect(calls.find((c) => (c.body as { op?: string })?.op === 'patch')?.body)
      .toMatchObject({ id: ROW.id, payload: { reconnect: false } })

    const restoreSwitch = screen.getByRole('switch', { name: '服务重启后恢复' }) as HTMLInputElement
    await act(async () => { fireEvent.click(restoreSwitch) })
    await waitFor(() => expect(calls.filter((c) => (c.body as { op?: string })?.op === 'patch')).toHaveLength(2))
    const last = calls.filter((c) => (c.body as { op?: string })?.op === 'patch').pop()
    expect(last?.body).toMatchObject({ id: ROW.id, payload: { restoreOnStart: false } })
  })

  it('界面密码：uipassword op 的 url+密码一起显示，可复制', async () => {
    const clipboard: string[] = []
    const host = { openUrl: async () => {}, writeClipboard: async (t: string) => { clipboard.push(t) } } as never
    const { request } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'uipassword') return { status: 200, body: { uiPassword: 's3cret-pass', url: 'http://127.0.0.1:4610' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={host} />) })
    await act(async () => { screen.getByText('更多').click() })
    await act(async () => { screen.getByText('界面密码').click() })
    await waitFor(() => expect(screen.getByText(/界面密码（只在控制端本地）/)).toBeTruthy())
    expect(screen.getByText(/s3cret-pass/)).toBeTruthy()
    await act(async () => { screen.getByText('复制').click() })
    await waitFor(() => expect(clipboard).toContain('http://127.0.0.1:4610\ns3cret-pass'))
  })

  it('同步凭据：syncauth op 的结果回显在卡片里', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'configdiff') return { status: 200, body: DIFF_MIN }
      if (body?.op === 'syncauth') return { status: 200, body: { ok: true, detail: '凭据已写到远程 0600' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('更多').click() })
    await act(async () => { screen.getByText('配置差异与同步').click() })
    await waitFor(() => expect(screen.getByText('同步凭据（auth.json）')).toBeTruthy())
    await act(async () => { screen.getByText('同步凭据（auth.json）').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'syncauth')).toBe(true))
    // syncResult 贴两处（卡内动作行 + 卡片下方），断言存在即可。
    expect(screen.getAllByText('OK 凭据已写到远程 0600').length).toBeGreaterThan(0)
  })
})

describe('升级链路与操作台（0.10.0）', () => {
  it('渠道有新版：徽章「可升级 X」，已停机器主按钮变「升级到 X」、启动降为次级，确认后发 upgrade payload.to', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [STOPPED] } }
      if (body?.op === 'defaults') return { status: 200, body: { ...DEFAULTS, latestPack: { version: '2.5.0' } } }
      if (body?.op === 'upgrade') return { status: 200, body: { ok: true, changed: true, from: '2.3.3', to: '2.5.0', detail: '升级完成；重启装载：online' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('可升级 2.5.0')).toBeTruthy())
    expect(screen.getByText('升级到 2.5.0')).toBeTruthy()
    // 启动仍在（降为 outline），检查更新也在
    expect(screen.getByText('启动')).toBeTruthy()
    expect(screen.getByText('检查更新')).toBeTruthy()

    await act(async () => { screen.getByText('升级到 2.5.0').click() })
    await waitFor(() => expect(screen.getByText('确认升级到 2.5.0')).toBeTruthy())
    expect(calls.some((c) => (c.body as { op?: string })?.op === 'upgrade')).toBe(false)
    await act(async () => { screen.getByText('确认升级到 2.5.0').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'upgrade')).toBe(true))
    const upgrade = calls.find((c) => (c.body as { op?: string })?.op === 'upgrade')
    expect(upgrade?.body).toMatchObject({ id: STOPPED.id, payload: { to: '2.5.0' } })
  })

  it('操作台：job 运行时自动展开、实时日志流、成功收起成结果 chip', { timeout: 20_000 }, async () => {
    // 'up' 先回 202 + jobId；job 轮询第一次 running（带 logTail），第二次 done。
    let jobCalls = 0
    const { request } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [STOPPED] } }
      if (body?.op === 'up') return { status: 200, body: { jobId: 'job-up-1' } }
      if (body?.op === 'job') {
        jobCalls += 1
        if (jobCalls === 1) return { status: 200, body: { job: { state: 'running' }, logTail: ['instance serve :2610'] } }
        return { status: 200, body: { job: { state: 'done', result: { ok: true, detail: 'online：http://127.0.0.1:4610' } }, logTail: ['instance serve :2610', 'forward up'] } }
      }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await waitFor(() => expect(screen.getByText('启动')).toBeTruthy())
    await act(async () => { screen.getByText('启动').click() })
    // 操作台自动展开：标题 + 连接日志折叠器（行数随轮询变，别锁具体数字）
    await waitFor(() => expect(screen.getByText('启动', { selector: '.oc-card-title' })).toBeTruthy(), { timeout: 4000 })
    await waitFor(() => expect(screen.getByText(/连接日志（\d+）/)).toBeTruthy())
    await act(async () => { screen.getByText(/连接日志（\d+）/).click() })
    await waitFor(() => expect(screen.getByText(/instance serve :2610/)).toBeTruthy())
    // done 之后 3 秒收起成结果 chip（chip 上带结果摘要）
    await waitFor(() => expect(screen.getByText(/online：http:\/\/127\.0\.0\.1:4610/)).toBeTruthy(), { timeout: 6000 })
  })

  it('操作台：job 失败保持展开并给出错误横幅', { timeout: 20_000 }, async () => {
    let jobCalls = 0
    const { request } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [STOPPED] } }
      if (body?.op === 'up') return { status: 200, body: { jobId: 'job-up-2' } }
      if (body?.op === 'job') {
        jobCalls += 1
        if (jobCalls >= 2) return { status: 200, body: { job: { state: 'error', error: '转发探活失败：connection refused' } } }
        return { status: 200, body: { job: { state: 'running' }, logTail: ['starting'] } }
      }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('启动').click() })
    await waitFor(() => expect(screen.getByText('启动失败')).toBeTruthy(), { timeout: 4000 })
    // 错误原文会出现两处（操作台横幅 + 卡片错误横幅）——都要在，不许静默
    expect(screen.getAllByText(/转发探活失败/).length).toBeGreaterThan(0)
    // 失败的操作台不许收走：没有「收起成 chip」的自动行为（3 秒后仍展开）
    await new Promise((r) => setTimeout(r, 3500))
    expect(screen.getByText('启动失败')).toBeTruthy()
  })

  it('apply 的 ok:false 不再被静默丢弃——落成这张卡的错误横幅', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [FRESH] } }
      if (body?.op === 'plan') return { status: 200, body: PLAN }
      if (body?.op === 'apply') return { status: 200, body: { ok: false, detail: '复用已安装检查未通过：运行时缺失' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByText('检查并安装').click() })
    await waitFor(() => expect(screen.getByText(/安装到远程机器/)).toBeTruthy())
    await act(async () => { screen.getByText(/安装到远程机器/).click() })
    await act(async () => { screen.getByText('确认安装').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'apply')).toBe(true))
    await waitFor(() => expect(screen.getByText(/复用已安装检查未通过/)).toBeTruthy())
  })

  it('两台机器的操作互不抹按钮状态（per-row busy）', async () => {
    // STOPPED 的 up 是长 job（一直 running）；ROW（在线）的「打开界面」不该被它带进 loading。
    const { request } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [STOPPED, ROW] } }
      if (body?.op === 'up') return { status: 200, body: { jobId: 'job-slow' } }
      if (body?.op === 'job') return { status: 200, body: { job: { state: 'running' } } }
      if (body?.op === 'url') return { status: 200, body: { url: 'http://127.0.0.1:4610' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={STUB_HOST} />) })
    await act(async () => { screen.getByRole('button', { name: '启动' }).click() })
    // 启动按钮进入 loading（aria-busy 由 kit button 的 loading 设置）
    await waitFor(() => expect(screen.getByRole('button', { name: '启动' }).getAttribute('aria-busy')).toBe('true'))
    // 在线那台的「打开界面」没被抹成 busy
    expect(screen.getByRole('button', { name: '打开界面' }).getAttribute('aria-busy')).not.toBe('true')
  })
})
