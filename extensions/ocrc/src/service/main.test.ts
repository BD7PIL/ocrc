import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// service/main.ts is a side-effecting entry (binds a port on import), so the
// unit face here boots it as a child process against a scratch store and
// exercises the HTTP contract directly: auth guard, route dispatch, error
// mapping. The two routes are the whole surface — `/health` and
// `/remote-instance` (the ssh faces behind the remote-instance ops are covered
// by remote-instance-ops.test.ts and scripts/accept-remote-instance.sh).

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
    // 读到一个已被删除的 store——那正是之前间歇性失败的来源。
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
  it('每个路由都在 bearer token 后面（含 /health）', async () => {
    await startService()
    for (const [method, path] of [['GET', '/health'], ['POST', '/remote-instance']] as const) {
      const r = await req(method, path, method === 'POST' ? { op: 'list' } : undefined, '')
      expect(r.status).toBe(401)
      const wrong = await req(method, path, method === 'POST' ? { op: 'list' } : undefined, 'Bearer nope')
      expect(wrong.status).toBe(401)
    }
  })

  it('GET /health 带 token → 200', async () => {
    await startService()
    const r = await req('GET', '/health')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
  })

  it('/remote-instance 缺 op → 400（不猜用户想干什么）', async () => {
    await startService()
    expect((await req('POST', '/remote-instance', {})).status).toBe(400)
  })

  it('list → add（密码不回显）→ apply 要 confirm（409 + dryRun）→ 未知 id 404', async () => {
    await startService()
    expect((await req('POST', '/remote-instance', { op: 'list' })).json.instances).toEqual([])

    const added = await req('POST', '/remote-instance', {
      op: 'add',
      payload: { host: '10.0.0.9', user: 'demo', sshAuth: 'password', sshPassword: 'sekret', name: 'lab' },
    })
    expect(added.status).toBe(200)
    expect(added.json.instance.id).toBe('demo@10.0.0.9')
    expect(added.json.instance.sshPassword).toBeUndefined()
    expect(added.json.instance.hasSshPassword).toBe(true)

    const listed = await req('POST', '/remote-instance', { op: 'list' })
    expect(listed.json.instances).toHaveLength(1)

    // 写远程机器必须先有一次显式确认。
    const noConfirm = await req('POST', '/remote-instance', { op: 'apply', id: 'demo@10.0.0.9' })
    expect(noConfirm.status).toBe(409)
    expect(noConfirm.json.dryRun).toBe(true)

    for (const op of ['plan', 'status', 'up', 'down', 'delete', 'pairlink', 'logs']) {
      const r = await req('POST', '/remote-instance', { op, id: 'nope@nowhere' })
      expect(r.status).toBe(404)
    }
  })

  it('闭集字段写错就拒（否则会静默退回密钥档 / auto）', async () => {
    await startService()
    for (const payload of [
      { host: 'h', sshAuth: 'Password' },
      { host: 'h', egress: 'directt' },
      { host: 'h', provision: 'pushing' },
    ]) {
      const r = await req('POST', '/remote-instance', { op: 'add', payload })
      expect(r.status).toBe(400)
    }
  })

  it('实例记录落盘：服务重启后还在（面板重启不用重新添加）', async () => {
    await startService()
    await req('POST', '/remote-instance', { op: 'add', payload: { host: '10.0.0.10', user: 'u', name: 'kept' } })
    // store 的落盘是 100ms 去抖（`remote-instances.ts`），服务自己没挂 exit 钩子
    // （`flushOnExit: false`，它长命、退出时自己 flush）。而 Windows 上
    // `kill('SIGTERM')` 是直接 TerminateProcess，跑不到 SIGTERM 处理器——所以这里
    // 必须等去抖自己烧完，否则测的是"刚写完就断电"。
    await new Promise((r) => setTimeout(r, 300))
    child?.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    await startService()
    const listed = await req('POST', '/remote-instance', { op: 'list' })
    expect(listed.json.instances.map((i: { id: string }) => i.id)).toEqual(['u@10.0.0.10'])
  })

  it('未知路由 404；坏 JSON 体 500（被接住，不崩）', async () => {
    await startService()
    expect((await req('GET', '/nope')).status).toBe(404)
    const bad = await fetch(`http://127.0.0.1:${port}/remote-instance`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(bad.status).toBe(500)
  })
})
