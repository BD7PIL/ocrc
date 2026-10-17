import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { makeHost, type FakeHost } from '../test/host-mock.js'
import { Panel } from './Panel.js'

/** The host client is the one thing a guest cannot construct itself, so the
 *  module is mocked and the real kit primitives are left in place — the tests
 *  then read the DOM the SDK actually paints. */
const held = vi.hoisted(() => ({ host: null as unknown as FakeHost }))
vi.mock('@openchamber/sdk', async (original) => {
  const actual = await original<typeof import('@openchamber/sdk')>()
  return { ...actual, connectHost: () => held.host.client }
})

const STATUS = {
  status: { profileId: null, tunnel: 'down', engine: 'unknown' },
  profiles: [],
}

beforeEach(() => {
  held.host = makeHost({ '/status': { body: STATUS } })
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-oc-surface')
})

describe('Panel — host integration', () => {
  it('paints the host theme onto the document root', async () => {
    render(<Panel />)
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--surface-background')).toBe('#0e0e10')
    })
    expect(document.documentElement.style.getPropertyValue('--oc-font')).toBe('system-ui, sans-serif')
    expect(document.documentElement.dataset.ocSurface).toBe('panel')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('collects a new profile in an inline form — never window.prompt', async () => {
    render(<Panel />)
    await screen.findByText('添加档案')

    screen.getByText('添加档案').click()
    const target = await screen.findByLabelText(/SSH 目标/)
    const key = screen.getByLabelText(/私钥路径/)

    act(() => {
      setNativeValue(target, 'demo@192.168.26.101:2222')
      setNativeValue(key, 'C:\\keys\\id_ed25519')
    })
    act(() => { screen.getByText('添加').click() })

    await waitFor(() => {
      expect(held.host.requests.some((r) => r.method === 'POST' && r.path === '/profiles')).toBe(true)
    })
    const post = held.host.requests.find((r) => r.path === '/profiles')
    expect(post?.body).toEqual({
      profile: { host: '192.168.26.101', user: 'demo', port: 2222, keyPath: 'C:\\keys\\id_ed25519' },
    })
  })

  it('keeps a half-written form when the user visits another tab', async () => {
    render(<Panel />)
    screen.getByText('添加档案').click()
    const target = await screen.findByLabelText(/SSH 目标/)
    act(() => { setNativeValue(target, 'demo@host') })

    act(() => { screen.getByRole('tab', { name: '配置同步' }).click() })
    act(() => { screen.getByRole('tab', { name: '连接' }).click() })

    await waitFor(() => {
      expect((screen.getByLabelText(/SSH 目标/) as HTMLInputElement).value).toBe('demo@host')
    })
  })

  it('reports the tunnel state with host-toned badges', async () => {
    held.host = makeHost({
      '/status': { body: { status: { profileId: 'p1', tunnel: 'up', engine: 'unreachable' }, profiles: [] } },
    })
    render(<Panel />)
    expect(await screen.findByText('隧道已连')).toBeTruthy()
    const engine = await screen.findByText('引擎不可达')
    expect(engine.dataset.tone).toBe('error')
  })

  it('surfaces a service error as a banner with the service message', async () => {
    held.host = makeHost({
      '/status': {
        body: { status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [{ id: 'p1', name: 'vm', host: 'h', port: 22, user: 'demo', remotePort: 4096, localPort: 4096 }] },
      },
      'POST /connect': { status: 502, body: { error: 'ssh 握手失败：Permission denied (publickey)' } },
    })
    render(<Panel />)
    const card = (await screen.findByText('vm')).closest('.oc-card') as HTMLElement
    act(() => { within(card).getByText('连接').click() })

    expect(await screen.findByText('ssh 握手失败：Permission denied (publickey)')).toBeTruthy()
  })

  it('registers the slash commands in the same effect as connectHost', async () => {
    render(<Panel />)
    // 同步注册：宿主弹隐藏帧问 /ocrc-host 时，处理者必须已经在了。
    await waitFor(() => expect(held.host.hasResolver()).toBe(true))
  })

  it('resolves /ocrc-plan into a chip built from the live service', async () => {
    held.host = makeHost({
      '/status': {
        body: {
          status: { profileId: 'p1', tunnel: 'up', engine: 'reachable' },
          profiles: [{ id: 'p1', name: 'EL7 靶机', host: '192.168.26.101', port: 22, user: 'demo', remotePort: 4096, localPort: 4096, projects: [{ path: '/home/demo/project' }] }],
        },
      },
      'POST /detect': {
        body: {
          detect: { reachable: true, platform: 'linux-x64', os: 'Red Hat Enterprise Linux 7.9', glibc: '2.17', home: '/home/demo', hasSh: true, hasTar: true, homeWritable: true, outbound: true },
          readiness: { steps: [{ id: 'engine', label: '③ 引擎在位且版本匹配', ok: false, detail: '未安装', action: '点「部署引擎」' }], ready: false },
          anchor: '2.0.27',
          anchorSource: '面板宿主',
        },
      },
      'POST /capabilities': { body: { capabilities: [], forwards: [], rewrites: [], notes: [], config: { projectPath: '/home/demo/project', targetPath: '/home/demo/project/opencode.jsonc', format: 'missing', exists: false } } },
    })
    render(<Panel />)
    await waitFor(() => expect(held.host.hasResolver()).toBe(true))

    const chip = await held.host.resolve({ command: 'ocrc-plan', args: '' })
    expect(chip?.providerId).toBe('ocrc')
    expect(chip?.title).toBe('ocrc 主机待办 · EL7 靶机（1 项）')
    expect(chip?.text).toContain('✗ ③ 引擎在位且版本匹配')
    expect(chip?.text).toContain('→ 点「部署引擎」')
    expect(chip?.url).toBe('http://127.0.0.1:4096/')
  })
})

/** React tracks the previous value on the node, so a plain assignment is
 *  swallowed: the native setter plus an input event is what React listens to. */
function setNativeValue(element: HTMLElement, value: string) {
  const field = element as HTMLInputElement | HTMLTextAreaElement
  const proto = Object.getPrototypeOf(field) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
