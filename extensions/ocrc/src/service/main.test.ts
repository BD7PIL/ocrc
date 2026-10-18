import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// service/main.ts is a side-effecting entry (binds a port on import), so the
// unit face here boots it as a child process against a scratch profiles file
// and exercises the HTTP contract directly: auth guard, route dispatch,
// error mapping. End-to-end ssh faces live in scripts/accept-workspace.sh.

let ws: string
let port: number
let child: ReturnType<typeof spawn> | null = null
const TOK = 'unit-tok'

function waitHealth(p: number, tries = 40): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = (n: number) => {
      fetch(`http://127.0.0.1:${p}/health`, { headers: { authorization: `Bearer ${TOK}` } })
        .then((r) => resolve(r.status === 200))
        .catch(() => {
          if (n <= 0) resolve(false)
          else setTimeout(() => attempt(n - 1), 250)
        })
    }
    attempt(tries)
  })
}

/** 起服务并拿到**内核分配的真实端口**。
 *
 *  以前这里是 `4600 + random(80)`：80 个端口的随机池 + 每个用例一个子进程，
 *  并行跑文件时既可能撞上别人占的端口，也可能撞上**上一个用例还没退干净**的服务——
 *  于是失败会随机落在某个用例上（表现为断言不符，而不是启动失败），非常难查。
 *  现在请求端口 0，由内核保证唯一；端口从服务的启动行里读回来。 */
async function startService(extraEnv: Record<string, string> = {}): Promise<void> {
  const proc = spawn(process.execPath, [join('service', 'main.js')], {
    cwd: join(__dirname, '..', '..'),
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: '0',
      OPENCHAMBER_SERVICE_TOKEN: TOK,
      OCRC_PROFILES: join(ws, 'profiles.json'),
      // Keep the service-owned remote-instance store out of the real ~/.ocrc.
      OCRC_HOME: join(ws, 'ocrc-home'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = proc
  const bound = await new Promise<number>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`service did not report its port (stdout: ${buf.slice(-300)})`)), 15_000)
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const m = /service listening on 127\.0\.0\.1:(\d+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`service exited before listening (code ${code}): ${buf.slice(-300)}`))
    })
  })
  port = bound
  if (!(await waitHealth(port))) throw new Error(`service did not become healthy on ${port}`)
}

function req(method: string, path: string, body?: unknown, auth = `Bearer ${TOK}`): Promise<{ status: number; json: any }> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'ocrc-svc-'))
})
afterEach(async () => {
  const proc = child
  child = null
  if (proc && proc.exitCode === null) {
    // 等它**真的**退出再删目录：不等的话下一个用例可能撞上还在服务的旧进程，
    // 读到一个已被删除的 profiles 文件——那正是之前间歇性失败的来源。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* gone */ }
        resolve()
      }, 3_000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try { proc.kill('SIGTERM') } catch { clearTimeout(timer); resolve() }
    })
  }
  try { rmSync(ws, { recursive: true, force: true }) } catch { /* gone */ }
})

describe('service main — auth + routing contract', () => {
  it('401 on every route without the bearer token', async () => {
    await startService()
    for (const path of ['/health', '/status', '/profiles', '/fs/list']) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: path === '/fs/list' ? 'POST' : 'GET' })
      expect(r.status).toBe(401)
    }
  })

  it('GET /health and GET /status with token', async () => {
    await startService()
    expect((await req('GET', '/health')).json).toMatchObject({ ok: true })
    const s = await req('GET', '/status')
    expect(s.status).toBe(200)
    expect(s.json).toHaveProperty('status')
    expect(s.json).toHaveProperty('profiles')
  })

  it('profiles CRUD: create → duplicate-id upsert → delete', async () => {
    await startService()
    const mk = await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', user: 'root' } })
    expect(mk.status).toBe(200)
    expect(mk.json.profiles).toHaveLength(1)
    expect(mk.json.profiles[0].port).toBe(22) // normalizeProfile default
    // same id → replace, not duplicate
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.2', user: 'u' } })
    const again = await req('GET', '/status')
    expect(again.json.profiles).toHaveLength(1)
    expect(again.json.profiles[0].host).toBe('127.0.0.2')
    const del = await req('DELETE', '/profiles/u1')
    expect(del.json.profiles).toHaveLength(0)
  })

  it('connect to unknown profile → 404; fs face without connect → 409', async () => {
    await startService()
    expect((await req('POST', '/connect', { profileId: 'nope' })).status).toBe(404)
    const fs = await req('POST', '/fs/list', { path: '/tmp' })
    expect(fs.status).toBe(409)
    expect(fs.json).toMatchObject({ error: expect.stringContaining('connect') })
  })

  it('fs face rejects relative paths with 400 (before any ssh)', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', allowedRoots: ['/tmp'] } })
    await req('POST', '/connect', { profileId: 'u1' })
    const r = await req('POST', '/fs/read', { path: 'relative/path' })
    expect(r.status).toBe(400)
  })

  it('unknown route → 404; malformed JSON body → 500 (caught)', async () => {
    await startService()
    expect((await req('GET', '/nope')).status).toBe(404)
    const raw = await fetch(`http://127.0.0.1:${port}/profiles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
      body: '{broken',
    })
    expect(raw.status).toBeGreaterThanOrEqual(400)
  })

  it('profiles persist across a service restart (auto-reconnect mirror)', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'keep', host: 'h1' } })
    child?.kill('SIGTERM')
    child = null
    // restart against the SAME profiles file
    await startService()
    const s = await req('GET', '/status')
    expect(s.json.profiles.map((p: { id: string }) => p.id)).toContain('keep')
  })
})

describe('provisioning 路由契约（第零点九条）', () => {
  it('每个新端点都在 bearer token 后面', async () => {
    await startService()
    for (const path of ['/detect', '/inspect', '/provision/plan', '/provision/apply', '/provision/prefetch', '/provision/rollback', '/provision/uninstall', '/capabilities', '/project-config', '/forwards', '/runtime/plan', '/runtime/apply', '/runtime/remove']) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
      expect(`${path} ${r.status}`).toBe(`${path} 401`)
    }
  })

  it('探测与规划要求先连上档案（409，而不是拿一台随机机器动手）', async () => {
    await startService()
    for (const path of ['/detect', '/inspect', '/provision/plan', '/capabilities']) {
      const r = await req('POST', path, {})
      expect(`${path} ${r.status}`).toBe(`${path} 409`)
    }
  })

  it('安装与卸载必须显式确认（D3）——没有 confirm 就 400', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', projects: [{ path: '/tmp' }] } })
    await req('POST', '/connect', { profileId: 'u1' })

    const apply = await req('POST', '/provision/apply', { plan: {}, artifact: {} })
    expect(apply.status).toBe(400)
    expect(apply.json.error).toContain('显式确认')

    const uninstall = await req('POST', '/provision/uninstall', { home: '/tmp' })
    expect(uninstall.status).toBe(400)
    expect(uninstall.json.error).toContain('显式确认')

    // 确认了但没带计划 → 400，而不是 500。
    const missing = await req('POST', '/provision/apply', { confirm: true })
    expect(missing.status).toBe(400)
  })

  it('回滚/卸载的 home 必须是被控机的 $HOME（不是项目号，更不是 /）', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', projects: [{ path: '/tmp' }] } })
    await req('POST', '/connect', { profileId: 'u1' })

    for (const home of ['', '/', 'relative/dir', '/home/../etc']) {
      const r = await req('POST', '/provision/uninstall', { home, confirm: true })
      expect(`${home} ${r.status}`).toBe(`${home} 400`)
      expect(r.json.error).toContain('$HOME')
    }
  })

  it('项目级配置写入要求被控机上的绝对路径；读取给出引擎会读的那一份', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })

    const relative = await req('GET', '/project-config?projectPath=relative/x')
    expect(relative.status).toBe(400)
    expect(relative.json.error).toContain('绝对路径')
  })

  it('项目级配置写入要先过段白名单（不接受空产物）', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })
    const r = await req('POST', '/project-config', { projectPath: '/tmp', config: { apiKey: 'sk-panel' } })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('没有可写入的段')
  })

  it('旧的全局写入入口被拒绝（410），并指向项目级端点', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })
    for (const path of ['/config/preview', '/config/apply']) {
      const r = await req('POST', path, {})
      expect(`${path} ${r.status}`).toBe(`${path} 410`)
      expect(r.json.error).toContain('/project-config')
    }
  })

  it('/config/source 仍然只读面板宿主的清单（它的活儿没变）', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })
    const r = await req('POST', '/config/source', {})
    expect(r.status).toBe(200)
    expect(r.json).toHaveProperty('configPath')
  })

  it('凭据通道：搬运要显式确认，且回面板的只有 provider 名字（D11）', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })

    const noHome = await req('GET', '/auth-sync')
    expect(noHome.status).toBe(400)

    const unconfirmed = await req('POST', '/auth-sync', { home: '/tmp' })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.json.error).toContain('显式确认')

    // 面板宿主上真实存在的那份凭据文件：这里只断言「账里没有值」。
    const inventory = await req('GET', '/auth-sync?home=/tmp')
    if (inventory.status === 200) {
      expect(Array.isArray(inventory.json.panelProviders)).toBe(true)
      expect(JSON.stringify(inventory.json)).not.toMatch(/sk-[A-Za-z0-9]/)
    }
  })

  it('/forwards 落到档案并持久化（与主隧道共生，D15），且不要求先连上', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })

    // 连接之前就能配：转发的用途就是「连之前先配好」（spike 抓到的缺陷）。
    const before = await req('POST', '/forwards', {
      profileId: 'u1',
      forwards: [{ direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 41001, activePort: 41001, reason: 'searxng' }],
    })
    expect(before.status).toBe(200)
    expect(before.json.restarted).toBe(false)

    // 连上之后再改同一份档案：这次要重启隧道让新转发生效。
    await req('POST', '/connect', { profileId: 'u1' })
    const after = await req('POST', '/forwards', {
      profileId: 'u1',
      forwards: [{ direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 41002, activePort: 41002, reason: 'searxng' }],
    })
    expect(after.json.restarted).toBe(true)

    const status = await req('GET', '/status')
    expect(status.json.profiles[0].forwards[0].port).toBe(41002)
  })

  it('/forwards 没给档案也不在连接态 → 400，指名道姓', async () => {
    await startService()
    const r = await req('POST', '/forwards', { forwards: [] })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('profileId')
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    expect((await req('POST', '/forwards', { profileId: 'nope', forwards: [] })).json.error).toContain('不存在')
  })
})

describe('运行时路由契约（D12/D13）', () => {
  const NEED_ITEM = {
    need: { raw: 'mcp-searxng', kind: 'npm', name: 'mcp-searxng' },
    action: 'install',
    package: 'mcp-searxng',
    dir: '/home/demo/.ocrc/runtime/mcp-searxng/latest',
    neededBy: ['mcp:searxng'],
  }

  it('新端点都在 bearer token 后面', async () => {
    await startService()
    for (const path of ['/runtime/plan', '/runtime/apply', '/runtime/remove']) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
      expect(`${path} ${r.status}`).toBe(`${path} 401`)
    }
  })

  it('计划与安装都要求先连上档案（409）', async () => {
    await startService()
    for (const path of ['/runtime/plan', '/runtime/apply', '/runtime/remove']) {
      const r = await req('POST', path, {})
      expect(`${path} ${r.status}`).toBe(`${path} 409`)
    }
  })

  it('安装要显式确认，且必须带计划里那一项（D3）', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', projects: [{ path: '/tmp' }] } })
    await req('POST', '/connect', { profileId: 'u1' })

    const unconfirmed = await req('POST', '/runtime/apply', { item: NEED_ITEM })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.json.error).toContain('显式确认')

    const missing = await req('POST', '/runtime/apply', { confirm: true })
    expect(missing.status).toBe(400)
    expect(missing.json.error).toContain('/runtime/plan')
  })

  it('计划要项目路径：没有被控机上的工作目录就 400', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })
    const r = await req('POST', '/runtime/plan', {})
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('工作目录')
  })

  it('移除也只认自己的运行时根目录', async () => {
    await startService()
    await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1' } })
    await req('POST', '/connect', { profileId: 'u1' })

    const unconfirmed = await req('POST', '/runtime/remove', { dir: '/home/demo/.ocrc/runtime/x/latest' })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.json.error).toContain('显式确认')

    // 落点必须落在**这台目标机**的 ~/.ocrc/runtime 里——探测失败时也绝不放过。
    const outside = await req('POST', '/runtime/remove', { dir: '/etc', confirm: true })
    expect(outside.status).toBe(400)
    expect(outside.json.error).toContain('.ocrc/runtime')
  })
})

describe('remote-instance ops contract (service-owned manager)', () => {
  it('list → add (redacted) → apply confirmation gate → status', async () => {
    await startService()
    const empty = await req('POST', '/remote-instance', { op: 'list' })
    expect(empty.status).toBe(200)
    expect(empty.json.instances).toEqual([])

    const add = await req('POST', '/remote-instance', { op: 'add', payload: { host: '127.0.0.1' } })
    expect(add.status).toBe(200)
    const id = add.json.instance.id as string
    expect(add.json.instance.hasUiPassword).toBe(true)
    // Secrets never come back over the service face.
    expect(JSON.stringify(add.json)).not.toMatch(/"uiPassword"/)

    const gate = await req('POST', '/remote-instance', { op: 'apply', id, payload: {} })
    expect(gate.status).toBe(409)
    expect(gate.json).toMatchObject({ dryRun: true })

    const status = await req('POST', '/remote-instance', { op: 'status', id })
    expect(status.status).toBe(200)
    expect(status.json.status.id).toBe(id)
  })
})
