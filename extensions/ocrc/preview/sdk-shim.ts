/**
 * 预览专用的 SDK 替身：真实包里除 `connectHost` 之外全部原样转发。
 *
 * 面板靠 `connectThemedHost()` 拿宿主，而真正的 `connectHost()` 要走宿主帧的
 * postMessage 握手——在本地预览里没有宿主，所以只换掉这一个函数，其余
 * （`applyHostReady`、kit 的 mount*）都是真的：预览里看到的就是线上那一套。
 */
import { makeHost, type FakeHost } from '../src/test/host-mock.js'
import { SCENARIOS, theme } from './scenarios.js'

export * from '../node_modules/@openchamber/sdk/dist/index.js'

const params = new URLSearchParams(location.search)
const rows = SCENARIOS[params.get('scenario') ?? 'mixed'] ?? []
const host: FakeHost = makeHost({ 'POST /remote-instance': { body: { instances: rows } } })

/** 宿主主题：ready 时按 `?theme=` 发给帧（与真宿主同一条路径）。 */
const originalOnReady = host.client.onReady
host.client.onReady = (listener) => originalOnReady((ctx) => listener({ ...ctx, theme: theme(params.get('theme')) }))

// 预览里这两个动作只记一笔：写剪贴板/开浏览器在无宿主环境没有意义。
const client = host.client as unknown as Record<string, unknown>
client.writeClipboard = async () => {}
client.openUrl = async () => {}

export function connectHost(): typeof host.client {
  return host.client
}

;(globalThis as unknown as { __previewHost: FakeHost }).__previewHost = host
