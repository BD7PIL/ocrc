/** 多路转发——复用同一条 ssh 进程的多个 `-L`/`-R`（D15）。
 *
 * 端口**动态分配并记录**，不写死：能力需要的是「面板能到达 192.168.96.11:8080」，
 * 不是「面板的 18080 一定空着」。分配由面板侧自己选（`listen(0)` 拿一个空端口再
 * 还回去），而不是依赖 ssh 打印分配结果——`ssh -L` 不像 `-R` 那样把实际端口报到
 * stderr，而 `ExitOnForwardFailure=yes` 会让冲突立刻炸出来，比猜端口可靠。
 *
 * 重写是可见的：每条转发都带 from/to，面板要能一眼看出改了哪个 URL（D15/D12）。
 */
import { createServer } from 'node:net'
import type { CapabilityPackage, ForwardRuntime, ForwardSpec } from '../shared/provision.js'

export interface PortAllocator {
  (): Promise<number>
}

/** 问操作系统要一个空闲端口。先 bind 到 0，读到端口，再关掉——中间那段窗口
 *  由 `ExitOnForwardFailure` 兜底。 */
export const systemPortAllocator: PortAllocator = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('没有分配到可用端口'))))
    })
  })

/** 从内网地址里拆出 host/port。只认 http/https 的显式端口写法——
 *  没有端口的 URL 本来就能被面板直接访问，不需要转发。 */
export function parseAddress(address: string): { host: string; port: number; url: URL } | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!url.hostname) return null
  return { host: url.hostname, port, url }
}

/** 面板自己够得着的地址不需要隧道（127.0.0.1 尤其不要——那会把自己套进隧道）。 */
export function isPanelLocal(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export interface PlanForwardsOptions {
  /** 面板能不能直接到达 host:port（注入，测试里确定化）。 */
  panelReachable: (host: string, port: number) => Promise<boolean>
  allocatePort?: PortAllocator
}

/** 把地址里的对端换成隧道入口。
 *
 * 用字符串替换而不是 `URL` 重新序列化：这个值会被写进引擎的配置，重排成
 * `http://127.0.0.1:41000/` 那种带尾斜杠的规范化写法是没必要的惊吓——原文除
 * host:port 之外一个字节都不该动。 */
export function rewriteAddress(address: string, host: string, peerPort: number, localPort: number): string {
  const explicit = `${host}:${peerPort}`
  if (address.includes(explicit)) return address.replace(explicit, `127.0.0.1:${localPort}`)
  // 没有显式端口（走默认端口）时，替换主机名并把端口补上。
  return address.replace(host, `127.0.0.1:${localPort}`)
}

/** 面板侧某个端口是否空闲。 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** 给每条转发定一个**能用的**端口（D15）。
 *
 * 能力转发的端口是实现细节——它的用途只是「面板够得到对端那个服务」，URL 改写会跟着
 * 实际端口走。所以被占用时自动换一个空闲端口，而不是让整条隧道起不来。
 *
 * **主隧道端口不在此列**：`localPort` 默认 4096 是面板宿主启动 openchamber 时用
 * `OPENCODE_PORT=4096`（或 `OPENCODE_HOST`）指过去的地址——上游**不盲探** 4096（他们
 * 早年这么干会劫持用户自己开的 OpenCode，所以删掉了），于是这个端口就是面板与隧道之间
 * 的约定，静默换掉等于把接入弄坏。主端口冲突要如实报错（supervisor 会把 ssh 的
 * `cannot listen to port` 带回来）。
 *
 * 返回每条转发的实际端口，调用方负责回写档案与改写 URL。 */
export async function settleForwardPorts(
  forwards: ForwardSpec[],
  deps: { isFree?: (port: number) => Promise<boolean>; allocate?: PortAllocator } = {},
): Promise<{ settled: ForwardSpec[]; changed: Array<{ reason: string; from: number; to: number }> }> {
  const isFree = deps.isFree ?? isPortFree
  const allocate = deps.allocate ?? systemPortAllocator
  const settled: ForwardSpec[] = []
  const changed: Array<{ reason: string; from: number; to: number }> = []
  const taken = new Set<number>()

  for (const forward of forwards) {
    if (forward.port && !taken.has(forward.port) && (await isFree(forward.port))) {
      taken.add(forward.port)
      settled.push(forward)
      continue
    }
    let next = 0
    for (let attempt = 0; attempt < 8 && !next; attempt += 1) {
      const candidate = await allocate()
      if (!taken.has(candidate) && (await isFree(candidate))) next = candidate
    }
    if (!next) throw new Error(`没有可用的本地端口（${forward.reason}）`)
    taken.add(next)
    if (forward.port) changed.push({ reason: forward.reason, from: forward.port, to: next })
    settled.push({ ...forward, port: next })
  }

  return { settled, changed }
}

/** 能力包 → 需要哪些转发 + 哪些 URL 要改。
 *
 * 只有「在面板侧跑、却要够到被控侧内网地址」的能力才需要 `-L`：能力默认跑在
 * 远端（D14），那时它用的是远端自己的路由，天然够得着，加隧道只会绕远。 */
export async function planForwards(
  packages: CapabilityPackage[],
  options: PlanForwardsOptions,
): Promise<{ specs: ForwardSpec[]; rewrites: Array<{ from: string; to: string }>; notes: string[] }> {
  const allocate = options.allocatePort ?? systemPortAllocator
  const specs: ForwardSpec[] = []
  const rewrites: Array<{ from: string; to: string }> = []
  const notes: string[] = []

  for (const pkg of packages) {
    for (const address of pkg.needs.network ?? []) {
      const parsed = parseAddress(address)
      if (!parsed) {
        notes.push(`${pkg.label}：${address} 不是可解析的 http(s) 地址，无法为它补隧道`)
        continue
      }
      if (isPanelLocal(parsed.host)) continue
      if (pkg.where === 'remote') {
        notes.push(`${pkg.label}：跑在被控端，${parsed.host}:${parsed.port} 由被控端自己的路由负责，不加隧道`)
        continue
      }
      if (await options.panelReachable(parsed.host, parsed.port)) {
        notes.push(`${pkg.label}：面板已达 ${parsed.host}:${parsed.port}，不加隧道`)
        continue
      }
      const port = await allocate()
      specs.push({
        direction: 'local',
        peerHost: parsed.host,
        peerPort: parsed.port,
        port,
        reason: `${pkg.label}（面板侧能力）需要 ${parsed.host}:${parsed.port}`,
      })
      rewrites.push({ from: address, to: rewriteAddress(address, parsed.host, parsed.port, port) })
    }
  }

  return { specs, rewrites, notes }
}

/** 把计划里的端口填成运行时视图（端口已分配，方向不变）。 */
export function toForwardRuntime(specs: ForwardSpec[], rewrites: Array<{ from: string; to: string }>): ForwardRuntime[] {
  return specs.map((spec) => ({
    ...spec,
    activePort: spec.port,
    rewrites: rewrites.filter((r) => r.to.includes(`:${spec.port}/`) || r.to.endsWith(`:${spec.port}`)),
  }))
}
