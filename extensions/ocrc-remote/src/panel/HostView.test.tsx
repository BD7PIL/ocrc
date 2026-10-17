import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { makeHost, type FakeHost } from '../test/host-mock.js'
import type { SshProfile, TunnelStatus } from '../shared/protocol.js'
import type { RequestFn } from '../shared/service-client.js'
import { HostView } from './HostView.js'

/** 主机视图的末端一步：现状 → chip → 新会话 / 当前对话。
 *
 *  这里量的是「不撒谎」：目录不是 openchamber 的项目就不建会话（也没有 API 建），
 *  建起来了就把 `sent` 四态原样说出来。 */

const PROFILE: SshProfile = {
  id: 'p1', name: 'EL7 靶机', host: '192.168.26.101', port: 22, user: 'demo',
  remotePort: 4096, localPort: 4096, projects: [{ path: '/home/demo/project' }],
}

const UP: TunnelStatus = { profileId: 'p1', tunnel: 'up', engine: 'reachable' }

const DETECT = {
  reachable: true, platform: 'linux-x64', os: 'Red Hat Enterprise Linux 7.9', kernel: '3.10.0',
  glibc: '2.17', container: 'none', home: '/home/demo', homeWritable: true, hasSh: true, hasTar: true,
  outbound: true, engine: { path: '/home/demo/.opencode/bin/opencode', version: '2.0.27' },
}

const READINESS = {
  steps: [
    { id: 'ssh', label: '① SSH 可达', ok: true, detail: '已连上' },
    { id: 'project', label: '④ 远程工作目录可写', ok: true, detail: '/home/demo/project' },
  ],
  ready: true,
}

const CAPS = {
  capabilities: [], forwards: [], rewrites: [], notes: [],
  config: { projectPath: '/home/demo/project', targetPath: '/home/demo/project/opencode.jsonc', format: 'jsonc', exists: false },
}

const RUNTIME_CAPS = {
  capabilities: [{
    id: 'mcp:searxng', label: 'MCP searxng', where: 'remote' as const,
    needs: { runtime: ['mcp-searxng'], network: ['http://192.168.96.11:8080'] },
  }],
  forwards: [{ direction: 'local' as const, peerHost: '192.168.96.11', peerPort: 8080, port: 18080, reason: 'mcp:searxng' }],
  rewrites: [{ from: 'http://192.168.96.11:8080', to: 'http://127.0.0.1:18080' }],
  notes: [],
  config: { ...CAPS.config, exists: true },
  runtime: {
    root: '/home/demo/.ocrc/runtime', node: 'v20.20.2', npm: '10.8.2', nodeOk: true,
    items: [
      {
        need: { raw: 'mcp-searxng', kind: 'npm' as const, name: 'mcp-searxng' },
        action: 'install' as const, package: 'mcp-searxng',
        dir: '/home/demo/.ocrc/runtime/mcp-searxng/latest', neededBy: ['mcp:searxng'],
      },
      {
        need: { raw: 'node', kind: 'npm' as const, name: 'node' },
        action: 'present' as const, found: { path: '/usr/local/bin/node', version: '20.20.2' }, neededBy: ['mcp:other'],
      },
      {
        need: { raw: '/opt/tools/graph', kind: 'path' as const, name: '/opt/tools/graph' },
        action: 'impossible' as const, neededBy: ['mcp:graph'],
        reason: '/opt/tools/graph 在目标机上不存在——ocrc 只装 npm 形态的运行时，二进制分发包要你在被控端自己装好',
      },
    ],
  },
}

let host: FakeHost
let request: RequestFn

const routes = () => ({
  '/status': { body: { status: UP, profiles: [PROFILE] } },
  'POST /detect': { body: { detect: DETECT, readiness: READINESS, anchor: '2.0.27', anchorSource: '面板宿主' } },
  'POST /capabilities': { body: CAPS },
})

function mount(options: Parameters<typeof makeHost>[1] = {}) {
  host = makeHost(routes(), options)
  request = ((path: string, method = 'GET', body?: unknown) =>
    host.client.serviceRequest({ path, method, body: body === undefined ? undefined : JSON.stringify(body) } as never)) as RequestFn
  render(<HostView request={request} status={UP} profiles={[PROFILE]} host={host.client} />)
}

beforeEach(() => { host = makeHost({}) })

describe('HostView — 把主机交给模型', () => {
  it('creates the session in the matching project and reports what actually got sent', async () => {
    mount({ projects: [{ id: 'proj-1', name: 'project', directory: '/home/demo/project' }] })
    await screen.findByText('主机视图')

    act(() => { screen.getByText('在此项目上新建会话').click() })

    await waitFor(() => expect(host.started.length).toBe(1))
    const sent = host.started[0]
    expect(sent.projectId).toBe('proj-1')
    expect(sent.navigation).toBe('open')
    // chip 五个必填字段照样齐全——startSession 就是「带 chip 的会话」。
    expect(sent.providerId).toBe('ocrc')
    expect(sent.id).toBe('host:p1')
    expect(sent.url).toBe('http://127.0.0.1:4096/')
    expect(sent.text).toContain('就绪四档')
    expect(host.attached.length).toBe(0)

    expect(await screen.findByText(/已在项目「project」新建会话 ses-1——首条消息已发给模型/)).toBeTruthy()
  })

  it('never invents a project for a directory openchamber does not have', async () => {
    mount({ projects: [{ id: 'proj-9', name: 'other', directory: '/srv/other' }] })
    await screen.findByText('主机视图')

    act(() => { screen.getByText('在此项目上新建会话').click() })

    await waitFor(() => expect(host.attached.length).toBe(1))
    // 没有创建项目的 API —— 就不建会话，也不假装建了。
    expect(host.started.length).toBe(0)
    expect(host.attached[0].id).toBe('host:p1')
    expect(await screen.findByText(/还不是 openchamber 的项目——扩展没有创建项目的 API/)).toBeTruthy()
  })

  it('keeps a trailing slash from hiding a match', async () => {
    mount({ projects: [{ id: 'proj-1', name: 'project', directory: '/home/demo/project/' }] })
    await screen.findByText('主机视图')

    act(() => { screen.getByText('在此项目上新建会话').click() })
    await waitFor(() => expect(host.started.length).toBe(1))
    expect(host.started[0].projectId).toBe('proj-1')
  })

  it('offers the composer path for the same chip', async () => {
    mount({ projects: [{ id: 'proj-1', name: 'project', directory: '/home/demo/project' }] })
    await screen.findByText('主机视图')

    act(() => { screen.getByText('贴到当前对话').click() })

    await waitFor(() => expect(host.attached.length).toBe(1))
    expect(host.started.length).toBe(0)
    expect(host.attached[0].text).toContain('能力盘点')
    expect(await screen.findByText(/现状已作为 chip 贴到当前对话的输入框/)).toBeTruthy()
  })

  it('tells the truth when the session exists but no model took the message', async () => {
    mount({
      projects: [{ id: 'proj-1', name: 'project', directory: '/home/demo/project' }],
      startResult: { sessionId: 'ses-7', sent: 'no-model' },
    })
    await screen.findByText('主机视图')

    act(() => { screen.getByText('在此项目上新建会话').click() })

    expect(await screen.findByText(/会话已建，但模型侧没有可用凭据/)).toBeTruthy()
  })

  it('surfaces a create failure with the host\'s own reason', async () => {
    mount({
      projects: [{ id: 'proj-1', name: 'project', directory: '/home/demo/project' }],
      startResult: { sessionId: null, sent: 'skipped', directory: '/home/demo/project', worktree: null as never, failure: 'session-create-failed' },
    })
    await screen.findByText('主机视图')

    act(() => { screen.getByText('在此项目上新建会话').click() })

    expect(await screen.findByText(/会话没有建起来（会话创建失败）/)).toBeTruthy()
  })
})

describe('HostView — 运行时三类状态与一次确认', () => {
  const mountWithCaps = async () => {
    host = makeHost({
      '/status': { body: { status: UP, profiles: [PROFILE] } },
      'POST /detect': { body: { detect: DETECT, readiness: READINESS, anchor: '2.0.27', anchorSource: '面板宿主' } },
      'POST /capabilities': { body: RUNTIME_CAPS },
      'POST /runtime/apply': { body: { ok: true, entry: '/home/demo/.ocrc/runtime/mcp-searxng/latest/node_modules/.bin/mcp-searxng', version: '1.2.3' } },
    })
    request = ((path: string, method = 'GET', body?: unknown) =>
      host.client.serviceRequest({ path, method, body: body === undefined ? undefined : JSON.stringify(body) } as never)) as RequestFn
    render(<HostView request={request} status={UP} profiles={[PROFILE]} host={host.client} />)
    await screen.findByText('主机视图')
    act(() => { screen.getByText('盘点能力').click() })
    await screen.findByText('运行时')
  }

  it('逐项如实显示 install / present / impossible 与各自的理由', async () => {
    await mountWithCaps()
    expect(await screen.findByText('待安装')).toBeTruthy()
    expect(screen.getByText('已就位')).toBeTruthy()
    expect(screen.getByText('装不了')).toBeTruthy()
    // 已就位的给出实际路径 + 为什么用它；装不了的给出人话原因。
    expect(screen.getByText(/\/usr\/local\/bin\/node（20.20.2）/)).toBeTruthy()
    expect(screen.getByText(/ocrc 只装 npm 形态的运行时/)).toBeTruthy()
    // 待安装的先把将要做的事说清楚（包名 → 落点）。
    expect(screen.getByText(/npm install mcp-searxng → \/home\/demo\/\.ocrc\/runtime\/mcp-searxng\/latest/)).toBeTruthy()
  })

  it('安装走一次确认：确认前不发请求，确认后按计划里那一项执行', async () => {
    await mountWithCaps()
    // The capability rows land a render after the "运行时" section header, so
    // wait for the button instead of assuming it is already mounted (a slower
    // runner — Node 20 on CI — otherwise fails here).
    const install = await screen.findByText('安装这一项')
    act(() => { install.click() })

    expect(await screen.findByText('将要执行')).toBeTruthy()
    expect(screen.getByText(/npm install mcp-searxng@latest --prefix \/home\/demo\/\.ocrc\/runtime\/mcp-searxng\/latest/)).toBeTruthy()
    expect(host.requests.some((r) => r.path === '/runtime/apply')).toBe(false)

    act(() => { screen.getByText('确认安装').click() })
    await waitFor(() => expect(host.requests.some((r) => r.path === '/runtime/apply')).toBe(true))
    const body = host.requests.find((r) => r.path === '/runtime/apply')?.body as { item?: { need?: { raw?: string } }; confirm?: boolean }
    expect(body.confirm).toBe(true)
    expect(body.item?.need?.raw).toBe('mcp-searxng')

    expect(await screen.findByText(/运行时已就位.*mcp-searxng/)).toBeTruthy()
  })

  it('取消就什么都不做', async () => {
    await mountWithCaps()
    const install = await screen.findByText('安装这一项')
    act(() => { install.click() })
    await screen.findByText('将要执行')
    act(() => { screen.getByText('取消安装').click() })
    await waitFor(() => expect(screen.queryByText('将要执行')).toBeNull())
    expect(host.requests.some((r) => r.path === '/runtime/apply')).toBe(false)
  })
})

describe('HostView — 端口被换掉时改写跟着实际端口走', () => {
  it('显示换过的端口，并把 URL 改写算成换过之后的那个', async () => {
    host = makeHost({
      '/status': { body: { status: UP, profiles: [PROFILE] } },
      'POST /detect': { body: { detect: DETECT, readiness: READINESS, anchor: '2.0.27', anchorSource: '面板宿主' } },
      'POST /capabilities': { body: RUNTIME_CAPS },
      'POST /forwards': {
        body: {
          forwards: [{ direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 18081, reason: 'mcp:searxng' }],
          portChanges: [{ reason: 'mcp:searxng', from: 18080, to: 18081 }],
          restarted: true,
        },
      },
    })
    request = ((path: string, method = 'GET', body?: unknown) =>
      host.client.serviceRequest({ path, method, body: body === undefined ? undefined : JSON.stringify(body) } as never)) as RequestFn
    render(<HostView request={request} status={UP} profiles={[PROFILE]} host={host.client} />)
    await screen.findByText('主机视图')
    act(() => { screen.getByText('盘点能力').click() })

    // 计划里的端口是 18080；真实挂上时被占用换成了 18081。
    expect(await screen.findByText(/改写：http:\/\/192\.168\.96\.11:8080 → http:\/\/127\.0\.0\.1:18080/)).toBeTruthy()
    act(() => { screen.getByText('挂上这些转发').click() })

    expect(await screen.findByText(/mcp:searxng 的 18080 被占用，改用 18081/)).toBeTruthy()
  })
})
