import type { Hono } from 'hono'
import type { RemoteInstancesStore } from '../../../core/remote-instances.js'
import { redactInstance } from '../../../core/remote-instances.js'
import type { RemoteInstanceManager } from '../../../core/remote-instance-bridge.js'
import { DEFAULT_APP_VERSION, DEFAULT_INSTANCE_PORT, DEFAULT_LOCAL_PORT, buildDesktopHandoff, type RemoteInstance } from '../../../core/remote-instance.js'

/**
 * 2.0.0-alpha.8 远程实例（对端能力）HTTP 面 —— 与 `routes/remotes.ts` 同一套约定：
 * 密钥不回显（`uiPassword` → `hasUiPassword`）、状态来自活的管理器、错误码
 * 401（未授权）/400（参数）/404（没这个 id）/502（对端或转发层失败）。
 *
 * 为什么要有 `/plan`：`apply`/`up` 都会在对端落地东西，面板需要一个**只读预演**
 * （ssh/环境/引擎门禁/将要做什么）让用户在按下去之前看见代价——尤其是 R12 的
 * 引擎门禁，它决定这台机器现在能不能用。
 */
export function registerRemoteInstance(app: Hono, store?: RemoteInstancesStore, manager?: RemoteInstanceManager) {
  if (!store || !manager) return

  const list = () => store.list().map((i) => ({ ...redactInstance(i), status: manager.status(i.id) ?? null }))

  app.get('/api/remote-instance', (c) => c.json({ instances: list() }))

  app.post('/api/remote-instance', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteInstance>
    if (!body.host || typeof body.host !== 'string') return c.json({ error: 'host required' }, 400)
    for (const [key, value] of [['port', body.port], ['instancePort', body.instancePort], ['localPort', body.localPort]] as const) {
      if (value != null && (!Number.isFinite(value) || value < 1 || value > 65535)) {
        return c.json({ error: `invalid ${key}` }, 400)
      }
    }
    const saved = store.upsert({
      ...body,
      host: body.host,
      port: body.port ?? 22,
      instancePort: body.instancePort ?? DEFAULT_INSTANCE_PORT,
      localPort: body.localPort ?? DEFAULT_LOCAL_PORT,
      appVersion: body.appVersion ?? DEFAULT_APP_VERSION,
    })
    return c.json({ instance: { ...redactInstance(saved), status: manager.status(saved.id) ?? null } })
  })

  app.patch('/api/remote-instance/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteInstance>
    const updated = store.update(c.req.param('id'), body)
    if (!updated) return c.json({ error: 'not found' }, 404)
    // 开关是"下一次动作"的口径，不在这里偷偷停/起隧道；要改现状请显式 up/down。
    return c.json({ instance: { ...redactInstance(updated), status: manager.status(updated.id) ?? null } })
  })

  app.post('/api/remote-instance/:id/delete', async (c) => {
    const id = c.req.param('id')
    if (!store.get(id)) return c.json({ error: 'not found' }, 404)
    await manager.down(id).catch(() => { /* 停不干净也允许删档案 */ })
    store.remove(id)
    return c.json({ ok: true })
  })

  /** 只读预演：ssh/环境/引擎门禁/将要做的动作。不写对端、不改档案。 */
  app.post('/api/remote-instance/:id/plan', async (c) => {
    if (!store.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    try {
      return c.json({ plan: await manager.plan(c.req.param('id')) })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  /** 装机（推运行时/引擎/应用）。长动作：面板轮询 GET 看 logTail。 */
  app.post('/api/remote-instance/:id/apply', async (c) => {
    const id = c.req.param('id')
    if (!store.get(id)) return c.json({ error: 'not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { force?: boolean; confirm?: boolean }
    // 会在对端写盘的动作要求一次显式确认（与 remotes 的 provision 同一纪律）。
    if (body.confirm !== true) return c.json({ error: 'confirm:true required', dryRun: true }, 409)
    try {
      const result = await manager.apply(id, { force: body.force === true })
      return c.json(result, result.ok ? 200 : 502)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  app.post('/api/remote-instance/:id/up', async (c) => {
    const id = c.req.param('id')
    if (!store.get(id)) return c.json({ error: 'not found' }, 404)
    try {
      const result = await manager.up(id)
      return c.json(result, result.ok ? 200 : 502)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  app.post('/api/remote-instance/:id/down', async (c) => {
    const id = c.req.param('id')
    if (!store.get(id)) return c.json({ error: 'not found' }, 404)
    try {
      const result = await manager.down(id)
      return c.json(result, result.ok ? 200 : 502)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  app.get('/api/remote-instance/:id/status', async (c) => {
    const status = manager.status(c.req.param('id'))
    if (!status) return c.json({ error: 'not found' }, 404)
    // 面板可能连的是另一个进程里的管理器：用一次实测覆盖内存状态。
    const live = await manager.probe(c.req.param('id'))
    if (live.online) return c.json({ status: { ...status, state: 'online', detail: status.detail ?? `openchamber ${live.version}（实测）` } })
    return c.json({ status: { ...status, state: status.state === 'online' ? 'offline' : status.state, detail: live.detail ?? status.detail } })
  })

  app.get('/api/remote-instance/:id/logs', (c) => {
    if (!store.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    const tail = Number(c.req.query('tail') ?? 100)
    const lines = manager.logs(c.req.param('id'))
    return c.json({ lines: Number.isFinite(tail) && tail > 0 ? lines.slice(-tail) : lines })
  })

  /** 「一键 external」的交接信息（**不含密码**——HTTP 面沿用 remotes 的纪律：
   *  secrets 只在本机终端出现；面板据此显示"去 CLI 取密码"）。 */
  app.get('/api/remote-instance/:id/connect', (c) => {
    const instance = store.get(c.req.param('id'))
    if (!instance) return c.json({ error: 'not found' }, 404)
    const status = manager.status(instance.id)
    const { uiPassword, lines, ...handoff } = buildDesktopHandoff(instance, status ?? undefined)
    return c.json({
      handoff: {
        ...handoff,
        hasUiPassword: !!uiPassword,
        lines: lines.map((l) => l.replace(/^密码 : .*$/, '密码 : （见本机 ocrc remote connect）')),
      },
    })
  })

  /** 面板要"打开对端 UI"时用它拿地址：URL 与是否已在线。 */
  app.get('/api/remote-instance/:id/url', (c) => {
    const instance = store.get(c.req.param('id'))
    if (!instance) return c.json({ error: 'not found' }, 404)
    return c.json({ url: `http://127.0.0.1:${instance.localPort}`, online: manager.status(instance.id)?.state === 'online' })
  })
}
