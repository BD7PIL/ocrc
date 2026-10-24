/** ocrc service entry — openchamber spawns this on the PANEL HOST (Win/Mac) with
 *  OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN env.
 *  Contract (packages/sdk/GUEST_SERVICES.md): loopback only, /health must
 *  return 200 within 15 s, every request carries Authorization: Bearer <token>.
 *
 *  **两条路由，故意的。** 面板只做一件事——把 openchamber 装到远程机器上、起它、
 *  递出配对链接——所以这个进程也只管这件事：`/health` 与 `/remote-instance`
 *  （manager + store 直接归它，不再经过 :4099）。
 *
 *  上一代在这个进程里还挂着：ssh 档案隧道、fs/git over ssh、项目级配置桥、运行时安装、
 *  omo 编排编辑。它们属于另一个拓扑（面板宿主的 openchamber 用 `-L` 连远程机器上裸跑
 *  的引擎），面板上早就没有入口了——0.9.2 连同它们的端点一起删除。裁决见
 *  docs/decisions/2026-10-18-rename-to-ocrc.md，运维口径见 docs/OPS.md。
 */
import http from 'node:http'

import {
  createRemoteInstanceManager, createRemoteInstancesStore, remoteInstancesPath,
} from '../../../../src/remote-instance/index.js'
import { ocrcHome } from '../../../../src/utils/paths.js'
import { createRemoteInstanceOps, type RemoteInstanceOp } from './remote-instance-ops.js'

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0)
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? ''

/**
 * 远程实例：service 是控制端唯一的长期 OCRC 进程，所以 store/manager 直接归它，
 * 不再经过 :4099。UI 的 `-L` 由桌面壳持有；这里持有反向出网腿与本地中继监听。
 */
const remoteInstances = createRemoteInstancesStore(remoteInstancesPath(ocrcHome()), { flushOnExit: false })
const remoteManager = createRemoteInstanceManager({ store: remoteInstances, tunnelOwner: 'external' })
const remoteOps = createRemoteInstanceOps({ store: remoteInstances, manager: remoteManager })

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
}

const server = http.createServer(async (req, res) => {
  // Guest-service contract: bearer token on everything (including /health).
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { error: 'unauthorized' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true })
      return
    }
    // Remote instances: the service owns the manager directly (no :4099 hop).
    if (req.method === 'POST' && url.pathname === '/remote-instance') {
      const body = (await readBody(req)) as RemoteInstanceOp
      if (!body?.op) { json(res, 400, { error: 'op required' }); return }
      const reply = await remoteOps.handle(body)
      json(res, reply.status, reply.body)
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
})

// `0` 是合法请求（让内核挑一个空闲端口）：测试用它消除端口碰撞。缺变量才是错。
if (process.env.OPENCHAMBER_SERVICE_PORT === undefined || process.env.OPENCHAMBER_SERVICE_PORT === '') {
  console.error('[ocrc] OPENCHAMBER_SERVICE_PORT missing — not launched by openchamber?')
  process.exit(1)
}
server.listen(PORT, '127.0.0.1', () => {
  // 报**实际**绑定端口（PORT=0 时就是内核给的那个）：调用方/测试据此决定打哪里。
  const addr = server.address()
  const bound = addr && typeof addr !== 'string' ? addr.port : PORT
  console.log(`[ocrc] service listening on 127.0.0.1:${bound}`)
  // Restore remote instances in the background; the UI tunnel belongs to the
  // desktop shell, so this only starts the far-side servers and the relay leg.
  // 0.11 冷状态识别：restore 不覆盖（或复用）的实例不再是永远的「未检查」——
  // 启动即对 enabled 实例做一轮实测探测（fire-and-forget，5 分钟冷却）。
  remoteManager.ensureAll()
  remoteManager.probeColdAll()
})

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  remoteInstances.flush()
  remoteOps.dispose()
  remoteManager.dispose()
}
process.on('SIGTERM', () => { shutdown(); process.exit(0) })
process.on('SIGINT', () => { shutdown(); process.exit(0) })
