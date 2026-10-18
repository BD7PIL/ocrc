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
if (scenario === 'slow') client.serviceRequest = () => new Promise(() => { /* 永远不答 */ })

export function connectHost(): typeof host.client {
  return host.client
}

;(globalThis as unknown as { __previewHost: FakeHost }).__previewHost = host
