/**
 * 预览专用的 SDK 替身：真实包里除 `connectHost` 之外全部原样转发。
 *
 * 面板靠 `connectThemedHost()` 拿宿主，而真正的 `connectHost()` 要走宿主帧的
 * postMessage 握手——在本地预览里没有宿主，所以只换掉这一个函数，其余
 * （`applyHostReady`、kit 的 mount*）都是真的：预览里看到的就是线上那一套。
 *
 * 每个 op 都有固定应答（`scenarios.ts` 的 `opRoutes`），否则面板里那些卡片
 * 根本打不开，"看过每个组件"就无从谈起。
 */
import { makeHost, type FakeHost } from '../src/test/host-mock.js'
import { opRoutes, rows, theme } from './scenarios.js'

export * from '../node_modules/@openchamber/sdk/dist/index.js'

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'mixed'
/** `scenario=error` 让 list 直接 502；`slow` 让它永远不答——首屏 loading 那一行
 *  只有把请求卡住才看得到（否则一闪而过，评审时抓不到）。 */
const listRoute = scenario === 'error'
  ? { status: 502, body: { error: '控制端 service 不可达：connect ECONNREFUSED 127.0.0.1' } }
  : { body: { instances: rows(scenario) } }
const host: FakeHost = makeHost({
  'POST /remote-instance': listRoute,
  ...opRoutes(),
})

/** `?scenario=upfail`：启动失败，用来验证"动作失败贴在卡片里"这条路径。 */
if (scenario === 'upfail') {
  const client = host.client as unknown as Record<string, unknown>
  const original = client.serviceRequest as (r: { body?: string }) => Promise<unknown>
  client.serviceRequest = (request: { body?: string }) => {
    if (typeof request.body === 'string' && request.body.includes('"up"')) {
      return Promise.resolve({ status: 502, body: JSON.stringify({ error: '启动失败：远程机器上没有可用的运行时' }) })
    }
    return original(request)
  }
}

/** 宿主主题：ready 时按 `?theme=` 发给帧（与真宿主同一条路径）。 */
const originalOnReady = host.client.onReady
host.client.onReady = (listener) => originalOnReady((ctx) => listener({ ...ctx, theme: theme(params.get('theme')) }))

// 预览里这两个动作只记一笔：写剪贴板/开浏览器在无宿主环境没有意义。
const client = host.client as unknown as Record<string, unknown>
client.writeClipboard = async () => {}
client.openUrl = async () => {}

/** `?scenario=upgrade`：defaults 注入渠道最新 2.5.0 / 引擎渠道最新 2.1.4 ——
 *  看「可升级 2.5.0」「OpenCode 可升级 2.1.4」两枚徽章、主按钮「升级到 2.5.0」
 *  与确认块（确认文案含「引擎将跟随渠道到 2.1.4」）。 */
if (scenario === 'upgrade') {
  const original = client.serviceRequest as (r: { body?: string }) => Promise<unknown>
  client.serviceRequest = (request: { body?: string }) => {
    if (typeof request.body === 'string' && request.body.includes('"op":"defaults"')) {
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({
          localPort: 4614, instancePort: 2610, appVersion: '2.3.3', latestPack: { version: '2.5.0' },
          engineLatest: { version: '2.1.4' },
          enginePin: '2.0.27', nodeRuntime: '24.22.0', bind: '127.0.0.1', taken: [4610, 4612],
        }),
      })
    }
    return original(request)
  }
}

/** `?scenario=job` / `jobfail`：'up' 走真 job 协议（202 + jobId + op:job 轮询带
 *  logTail 与状态迁移），用来看操作台——运行中的阶段轨道、日志流、成功收起 /
 *  失败保持。轮询第 3 次收尾。 */
if (scenario === 'job' || scenario === 'jobfail') {
  let ticks = 0
  const fail = scenario === 'jobfail'
  const original = client.serviceRequest as (r: { body?: string }) => Promise<unknown>
  client.serviceRequest = (request: { body?: string }) => {
    const body = typeof request.body === 'string' ? request.body : ''
    if (body.includes('"op":"up"')) {
      return Promise.resolve({ status: 200, body: JSON.stringify({ jobId: 'job-preview' }) })
    }
    if (body.includes('"op":"job"')) {
      ticks += 1
      const logTail = [
        '升级：2.3.3 → 2.5.0（旧树留 .ocrc-bak，一份就够）',
        'OpenChamber 包兼容档：legacy-glibc217（远程机器 glibc 2.17）',
        '应用包已取件：ocrc-openchamber-pack-2.5.0-linux-x64-legacy-glibc217.tar.gz（214.3MB）',
        '运行时：已推送 node v24.22.0',
        'OpenCode：2.0.27 已在位',
      ].slice(0, ticks)
      if (fail && ticks >= 3) {
        return Promise.resolve({ status: 200, body: JSON.stringify({ job: { state: 'error', error: 'ssh 不可达：22 端口超时（第 3 次重试）' }, logTail }) })
      }
      if (ticks >= 3) {
        return Promise.resolve({ status: 200, body: JSON.stringify({ job: { state: 'done', result: { ok: true, detail: 'online：http://127.0.0.1:4610（openchamber 2.5.0）' } }, logTail }) })
      }
      return Promise.resolve({ status: 200, body: JSON.stringify({ job: { state: 'running' }, logTail }) })
    }
    // 阶段轨道的原料：list 的状态跟着 tick 走（checking → provisioning → online/offline）。
    if (body.includes('"op":"list"')) {
      const state = ticks === 0 ? 'offline' : ticks === 1 ? 'checking' : ticks === 2 ? 'provisioning' : (fail ? 'error' : 'online')
      const withState = rows('upgrade').map((r) => ({ ...r, status: { ...(r.status as object), state, app: ticks >= 3 && !fail ? '2.5.0' : '2.3.3' } }))
      return Promise.resolve({ status: 200, body: JSON.stringify({ instances: withState }) })
    }
    return original(request)
  }
}

/** `?scenario=jobdone`：一次轮询就 done（audit 的「结果 chip」截图用，避免时序竞态）。 */
if (scenario === 'jobdone') {
  let ticked = false
  const original = client.serviceRequest as (r: { body?: string }) => Promise<unknown>
  client.serviceRequest = (request: { body?: string }) => {
    const body = typeof request.body === 'string' ? request.body : ''
    if (body.includes('"op":"up"')) {
      return Promise.resolve({ status: 200, body: JSON.stringify({ jobId: 'job-done-preview' }) })
    }
    if (body.includes('"op":"job"')) {
      const logTail = ['升级：2.3.3 → 2.5.0（旧树留 .ocrc-bak，一份就够）', '应用包已取件：ocrc-openchamber-pack-2.5.0-linux-x64-legacy-glibc217.tar.gz（214.3MB）']
      if (ticked) {
        return Promise.resolve({ status: 200, body: JSON.stringify({ job: { state: 'done', result: { ok: true, detail: 'online：http://127.0.0.1:4612（openchamber 2.5.0）' } }, logTail }) })
      }
      ticked = true
      return Promise.resolve({ status: 200, body: JSON.stringify({ job: { state: 'running' }, logTail: logTail.slice(0, 1) }) })
    }
    if (body.includes('"op":"list"')) {
      const withState = rows('upgrade').map((r) => ({ ...r, status: { ...(r.status as object), state: ticked ? 'online' : 'checking', app: ticked ? '2.5.0' : '2.3.3' } }))
      return Promise.resolve({ status: 200, body: JSON.stringify({ instances: withState }) })
    }
    return original(request)
  }
}

if (scenario === 'slow') client.serviceRequest = () => new Promise(() => { /* 永远不答 */ })

export function connectHost(): typeof host.client {
  return host.client
}

;(globalThis as unknown as { __previewHost: FakeHost }).__previewHost = host
