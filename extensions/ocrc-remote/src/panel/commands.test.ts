import { describe, expect, it } from 'vitest'
import type { CapabilityReport, DetectReport, ReadinessReport } from '../shared/provision.js'
import type { ServiceApiShape, SshProfile } from '../shared/protocol.js'
import {
  buildHostChip, buildHostSummary, collectHostFacts, describeStartResult,
  registerGuestCommands, type HostFacts,
} from './commands.js'
import { makeHost } from '../test/host-mock.js'

const PROFILE: SshProfile = {
  id: 'p1', name: 'EL7 靶机', host: '192.168.26.101', port: 22, user: 'demo',
  remotePort: 4096, localPort: 4096,
  projects: [{ path: '/home/demo/project' }],
}

const DETECT: DetectReport = {
  reachable: true,
  platform: 'linux-x64',
  os: 'Red Hat Enterprise Linux 7.9',
  kernel: '3.10.0-1160',
  glibc: '2.17',
  container: 'none',
  home: '/home/demo',
  homeWritable: true,
  hasSh: true,
  hasTar: true,
  outbound: true,
  engine: { path: '/home/demo/.opencode/bin/opencode', version: '2.0.27' },
  legacyEngine: { path: '/home/demo/.local/bin/opencode', version: '1.18.3' },
}

const READINESS: ReadinessReport = {
  steps: [
    { id: 'ssh', label: '① SSH 可达', ok: true, detail: '已连上（Red Hat Enterprise Linux 7.9）' },
    { id: 'shell', label: '② sh + tar + 可写 $HOME', ok: true, detail: 'sh ✓ · tar ✓ · $HOME 可写 ✓' },
    { id: 'engine', label: '③ 引擎在位且版本匹配', ok: false, detail: '未安装', action: '点「部署引擎」把面板宿主的引擎版本装到 ~/.opencode/bin（不覆盖用户既有安装）。' },
    { id: 'project', label: '④ 远程工作目录可写', ok: true, detail: '/home/demo/project' },
  ],
  ready: false,
}

const CAPS: CapabilityReport = {
  capabilities: [{
    id: 'searxng', label: 'searxng 检索', where: 'remote',
    needs: { runtime: ['node>=20'], network: ['192.168.96.11:8080'], secrets: ['SEARXNG_TOKEN'] },
  }],
  forwards: [{ direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 18080, reason: 'searxng' }],
  rewrites: [{ from: 'http://192.168.96.11:8080', to: 'http://127.0.0.1:18080' }],
  notes: ['面板本来就到不了 192.168.96.11——这条转发是必须的'],
  config: { projectPath: '/home/demo/project', targetPath: '/home/demo/project/opencode.jsonc', format: 'jsonc', exists: true },
}

const FACTS: HostFacts = {
  profile: PROFILE,
  active: true,
  tunnel: { profileId: 'p1', tunnel: 'up', engine: 'reachable' },
  readiness: READINESS,
  detect: DETECT,
  anchor: '2.0.27',
  anchorSource: '面板宿主 ~/.opencode/bin/opencode',
  projectPath: '/home/demo/project',
  caps: CAPS,
}

describe('buildHostSummary — 纯函数：现状进，文本出', () => {
  it('counts the pending rungs in the title and lists every rung with its action', () => {
    const { title, text } = buildHostSummary(FACTS)
    expect(title).toBe('ocrc 远端主机 EL7 靶机（1 项待办）')
    expect(text).toContain('【ocrc 远端主机现状】')
    expect(text).toContain('档案：EL7 靶机（demo@192.168.26.101:22）')
    expect(text).toContain('就绪四档（3/4）：')
    expect(text).toContain('✓ ① SSH 可达')
    expect(text).toContain('✗ ③ 引擎在位且版本匹配 — 未安装')
    // 缺的那档必须带上「能做的事」，否则模型只能猜。
    expect(text).toContain('→ 点「部署引擎」')
  })

  it('carries the system facts, the engine, and the untouched user install', () => {
    const { text } = buildHostSummary(FACTS)
    expect(text).toContain('Red Hat Enterprise Linux 7.9')
    expect(text).toContain('glibc 2.17')
    expect(text).toContain('可出网')
    expect(text).toContain('/home/demo/.opencode/bin/opencode → 2.0.27（面板宿主锚点 2.0.27，一致）')
    expect(text).toContain('用户既有安装：1.18.3 @ /home/demo/.local/bin/opencode（ocrc 不覆盖它）')
    expect(text).toContain('工作目录：/home/demo/project')
  })

  it('flags version drift instead of a silent mismatch', () => {
    const { text } = buildHostSummary({
      ...FACTS,
      detect: { ...DETECT, engine: { path: '/home/demo/.opencode/bin/opencode', version: '2.0.20' } },
    })
    expect(text).toContain('/home/demo/.opencode/bin/opencode → 2.0.20（面板宿主锚点 2.0.27，**版本漂移**）')
  })

  it('summarises capabilities, needed forwards and URL rewrites', () => {
    const { text } = buildHostSummary(FACTS)
    expect(text).toContain('能力盘点（/home/demo/project）：')
    expect(text).toContain('searxng 检索（远端）— 运行时 node>=20 · 网络 192.168.96.11:8080 · 密钥 SEARXNG_TOKEN')
    expect(text).toContain('需要补 1 条转发（与主隧道同一个 ssh 进程）：')
    expect(text).toContain('-L 127.0.0.1:18080 → 192.168.96.11:8080　(searxng)')
    expect(text).toContain('URL 改写：http://192.168.96.11:8080 → http://127.0.0.1:18080')
    expect(text).toContain('说明：面板本来就到不了 192.168.96.11')
  })

  it('讲法二（plan）说的是「还差什么」，标题与结尾都不同', () => {
    const { title, text } = buildHostSummary(FACTS, 'plan')
    expect(title).toBe('ocrc 主机待办 · EL7 靶机（1 项）')
    expect(text).toContain('【ocrc 远端主机待办】')
    expect(text).toContain('请按这份现状安排「先补什么、后补什么」')
  })

  it('says a host is ready when all four rungs are green', () => {
    const ready = { ...READINESS, steps: READINESS.steps.map((s) => ({ ...s, ok: true, action: undefined })), ready: true }
    expect(buildHostSummary({ ...FACTS, readiness: ready }).title).toBe('ocrc 远端主机 EL7 靶机（四档就绪）')
  })

  it('never pretends a disconnected profile has been probed', () => {
    const { title, text } = buildHostSummary({ profile: PROFILE, active: false, tunnel: { profileId: null, tunnel: 'down', engine: 'unknown' } })
    expect(title).toBe('ocrc 远端主机 EL7 靶机')
    expect(text).toContain('不是连接中的那一份')
    expect(text).toContain('再重新提交这个命令')
    // 没探测就没探测：不许出现能力或就绪的结论。
    expect(text).not.toContain('就绪四档')
    expect(text).not.toContain('能力盘点')
  })

  it('reports probe and inventory failures as facts, not as readiness', () => {
    const { text } = buildHostSummary({ ...FACTS, readiness: undefined, detect: undefined, probeError: 'ssh 断开：Broken pipe' })
    expect(text).toContain('探测失败：ssh 断开：Broken pipe')
    expect(text).toContain('（没探到——先看上面的原因）')
    expect(text).toContain('~/.opencode/bin 里还没有引擎')
  })

  it('surfaces an inventory failure and a broken project config', () => {
    const broken = buildHostSummary({ ...FACTS, caps: undefined, capsError: 'path outside allowedRoots' })
    expect(broken.text).toContain('（盘点失败：path outside allowedRoots）')

    const badJson = buildHostSummary({ ...FACTS, caps: { ...CAPS, config: { ...CAPS.config, parseError: 'Unexpected token }' } } })
    expect(badJson.text).toContain('解析失败（Unexpected token }）')
  })

  it('says an unbound profile has no work directory instead of inventing one', () => {
    const { text } = buildHostSummary({ ...FACTS, profile: { ...PROFILE, projects: undefined }, projectPath: undefined, caps: undefined })
    expect(text).toContain('工作目录：（档案还没有绑定工作目录）')
    expect(text).not.toContain('能力盘点')
  })
})

describe('buildHostChip — 宿主 chip 契约', () => {
  it('carries all five required fields with a legal provider id', () => {
    const chip = buildHostChip(FACTS)
    expect(chip.providerId).toBe('ocrc')
    expect(/^[a-z][a-z0-9-]*$/.test(chip.providerId)).toBe(true)
    expect(chip.id).toBe('host:p1')
    expect(chip.id.length).toBeLessThanOrEqual(128)
    expect(chip.url).toBe('http://127.0.0.1:4096/')
    expect(chip.title).toBe(buildHostSummary(FACTS).title)
    expect(chip.text).toBe(buildHostSummary(FACTS).text)
    expect(chip.text!.length).toBeLessThanOrEqual(16_000)
  })

  it('adds machine-readable data so nobody has to parse the prose', () => {
    expect(buildHostChip(FACTS).data).toEqual({
      profileId: 'p1',
      host: '192.168.26.101:22',
      user: 'demo',
      projectPath: '/home/demo/project',
      ready: false,
      pendingSteps: ['engine'],
      engineVersion: '2.0.27',
      anchorVersion: '2.0.27',
      capabilities: [{ id: 'searxng', where: 'remote' }],
      forwards: 1,
    })
  })

  it('omits the answer for anything it did not probe', () => {
    expect(buildHostChip({ profile: PROFILE, active: false }).data).toMatchObject({
      ready: null, pendingSteps: [], engineVersion: null, anchorVersion: null, capabilities: [], forwards: 0,
    })
  })
})

describe('collectHostFacts — 探测失败是事实，服务没起才是异常', () => {
  const status = (body: ServiceApiShape) => ({ '/status': { body } })

  const requestFor = (routes: Parameters<typeof makeHost>[0]) => {
    const host = makeHost(routes)
    return { host, request: (path: string, method?: string, body?: unknown) => host.client.serviceRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body) } as never) }
  }

  it('throws when the service itself does not answer', async () => {
    const host = makeHost({})
    const request = (path: string) => host.client.serviceRequest({ path } as never)
    await expect(collectHostFacts(request as never)).rejects.toThrow(/ocrc 服务没有应答/)
  })

  it('throws with the known profile names when the argument matches nothing', async () => {
    const { request } = requestFor(status({ status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [PROFILE] }))
    await expect(collectHostFacts(request as never, '不存在的档案')).rejects.toThrow(/没有叫「不存在的档案」的档案。现有：EL7 靶机/)
  })

  it('says how to get started when there is no profile at all', async () => {
    const { request } = requestFor(status({ status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [] }))
    await expect(collectHostFacts(request as never)).rejects.toThrow(/还没有档案——先在 ocrc Connect/)
  })

  it('stops at the profile record when nothing is connected', async () => {
    const { request, host } = requestFor(status({ status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [PROFILE] }))
    const facts = await collectHostFacts(request as never)
    expect(facts.active).toBe(false)
    expect(facts.projectPath).toBe('/home/demo/project')
    expect(host.requests.some((r) => r.path === '/detect')).toBe(false)
  })

  it('refuses to guess when several profiles are stored and none is connected', async () => {
    const other = { ...PROFILE, id: 'p2', name: '另一台' }
    const { request } = requestFor(status({ status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [PROFILE, other] }))
    await expect(collectHostFacts(request as never)).rejects.toThrow(/现有档案不止一份（EL7 靶机、另一台）——用 \/ocrc-host <档案名>/)
    // 点名时光是「没连上」不算错——那份档案本身还是能报出来的。
    expect((await collectHostFacts(request as never, '另一台')).active).toBe(false)
  })

  it('probes readiness, engine and capabilities for the connected profile', async () => {
    const { request } = requestFor({
      ...status({ status: { profileId: 'p1', tunnel: 'up', engine: 'reachable' }, profiles: [PROFILE] }),
      'POST /detect': { body: { detect: DETECT, readiness: READINESS, anchor: '2.0.27', anchorSource: '面板宿主' } },
      'POST /capabilities': { body: CAPS },
    })
    const facts = await collectHostFacts(request as never)
    expect(facts.active).toBe(true)
    expect(facts.detect?.os).toBe('Red Hat Enterprise Linux 7.9')
    expect(facts.readiness?.ready).toBe(false)
    expect(facts.anchor).toBe('2.0.27')
    expect(facts.caps?.capabilities[0].id).toBe('searxng')
  })

  it('inventories the project the caller names, not just the profile default', async () => {
    const { request, host } = requestFor({
      ...status({ status: { profileId: 'p1', tunnel: 'up', engine: 'reachable' }, profiles: [PROFILE] }),
      'POST /detect': { body: { detect: DETECT, readiness: READINESS, anchorSource: '面板宿主' } },
      'POST /capabilities': { body: CAPS },
    })
    await collectHostFacts(request as never, '', { projectPath: '/srv/other' })
    expect(host.requests.find((r) => r.path === '/capabilities')?.body).toEqual({ projectPath: '/srv/other' })
  })

  it('keeps going when one probe fails and records why', async () => {
    const { request } = requestFor({
      ...status({ status: { profileId: 'p1', tunnel: 'up', engine: 'reachable' }, profiles: [PROFILE] }),
      'POST /detect': { status: 502, body: { error: 'ssh exit 255' } },
      'POST /capabilities': { status: 409, body: { error: 'no active profile' } },
    })
    const facts = await collectHostFacts(request as never)
    expect(facts.probeError).toBe('ssh exit 255')
    expect(facts.capsError).toBe('no active profile')
    expect(buildHostSummary(facts).text).toContain('盘点失败：no active profile')
  })
})

describe('registerGuestCommands — composer 里的两个命令', () => {
  const setup = (extra: Parameters<typeof makeHost>[0] = {}) => {
    const host = makeHost({
      '/status': { body: { status: { profileId: 'p1', tunnel: 'up', engine: 'reachable' }, profiles: [PROFILE] } },
      'POST /detect': { body: { detect: DETECT, readiness: READINESS, anchor: '2.0.27', anchorSource: '面板宿主' } },
      'POST /capabilities': { body: CAPS },
      ...extra,
    })
    const unregister = registerGuestCommands(host.client)
    return { host, unregister }
  }

  it('turns /ocrc-host into a chip with the host summary inside', async () => {
    const { host } = setup()
    expect(host.hasResolver()).toBe(true)
    const chip = await host.resolve({ command: 'ocrc-host', args: '' })
    expect(chip?.providerId).toBe('ocrc')
    expect(chip?.title).toContain('ocrc 远端主机 EL7 靶机')
    expect(chip?.text).toContain('就绪四档（3/4）')
  })

  it('/ocrc-plan is the same facts told as a to-do list', async () => {
    const { host } = setup()
    const chip = await host.resolve({ command: 'ocrc-plan', args: '' })
    expect(chip?.title).toBe('ocrc 主机待办 · EL7 靶机（1 项）')
    expect(chip?.text).toContain('请按这份现状安排')
  })

  it('answers nothing for a command that is not ours', async () => {
    const { host } = setup()
    expect(await host.resolve({ command: 'someone-else', args: '' })).toBeNull()
  })

  it('lets the user name a profile and fails loudly on a typo', async () => {
    const { host } = setup()
    expect((await host.resolve({ command: 'ocrc-host', args: 'EL7 靶机' }))?.id).toBe('host:p1')
    await expect(host.resolve({ command: 'ocrc-host', args: 'dd' })).rejects.toThrow(/没有叫「dd」的档案/)
  })

  it('stops resolving once unregistered', async () => {
    const { host, unregister } = setup()
    unregister()
    expect(host.hasResolver()).toBe(false)
    await expect(host.resolve({ command: 'ocrc-host', args: '' })).rejects.toThrow(/no onResolve handler/)
  })
})

describe('describeStartResult — sent 是「首条消息发没发出去」，不是任务状态', () => {
  it('translates all five outcomes without euphemism', () => {
    expect(describeStartResult({ sessionId: 's1', sent: 'sent' }, 'proj')).toContain('首条消息已发给模型')
    expect(describeStartResult({ sessionId: 's1', sent: 'no-model' }, 'proj')).toContain('模型侧没有可用凭据')
    expect(describeStartResult({ sessionId: 's1', sent: 'failed' }, 'proj')).toContain('首条消息发送失败')
    expect(describeStartResult({ sessionId: 's1', sent: 'skipped' }, 'proj')).toContain('没有可发送的正文')
    expect(describeStartResult({ sessionId: null, sent: 'skipped', directory: '/d', worktree: null as never, failure: 'bootstrap-failed' }, 'proj'))
      .toContain('会话没有建起来（项目目录初始化失败）')
  })
})
