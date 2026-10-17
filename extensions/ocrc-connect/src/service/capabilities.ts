/** 能力包——同步单位是能力，不是凭据类别（D11/D12/D13/D14）。
 *
 * 每项能力声明自己要什么：**密钥 / 网络可达 / 运行时**。provisioning 负责在目标
 * 侧凑齐三者，而不是把某一类文件整包搬过去。三条推论写在这里，因为它们是这个模块
 * 存在的原因：
 *   · 密钥跟着能力走，且**粘性**——面板没提供的密钥字段一律保留远端原值（合并是
 *     phase 3 的事，这里只负责说清「缺哪个名字」）。
 *   · `npx -y X` 这类声明在同步时改写为预装的本地入口，运行期不再依赖 npx 联网（D13）。
 *   · 能力默认在**远端本地**跑；本来就属于桌面的（浏览器等）才选面板侧 + 反向接入（D14）。
 */

import type { CapabilityPackage, RuntimeNeed } from '../shared/provision.js'

/** 引擎配置里「本机进程」的两处落点：MCP server 与命令式工具。 */
export interface McpDeclaration {
  /** 声明里的名字通常由 key 给出；这里只是可选回填，不参与判断。 */
  name?: string
  type?: string
  command?: unknown
  url?: string
  environment?: Record<string, unknown>
}

/** 从 opencode 的项目配置里读出能力清单。只认这两处形状，其余字段一概不动。 */
export function capabilitiesFromConfig(config: Record<string, unknown>): CapabilityPackage[] {
  const out: CapabilityPackage[] = []
  const mcp = config.mcp
  if (mcp && typeof mcp === 'object') {
    const servers = (mcp as { servers?: unknown }).servers
    if (servers && typeof servers === 'object') {
      for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue
        const declaration = raw as McpDeclaration
        out.push(capabilityFromMcp(name, declaration))
      }
    }
  }
  return out
}

function splitCommand(command: unknown): string[] {
  if (Array.isArray(command)) return command.map((part) => String(part))
  if (typeof command === 'string') return command.split(/\s+/).filter(Boolean)
  return []
}

/** `@playwright/mcp@next` → `@playwright/mcp`；`mcp-searxng` → 原样。
 *  只剥**末尾**那段版本：scoped 包名自己就以 `@` 开头，`split('@')[0]` 会把它
 *  整段吃掉（这个 bug 让带版本的 scoped 包永远查不到预装入口）。 */
export function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/** 命令里的三段式：`[npx] [-y] <pkg> [args…]`。返回包名与它后面的参数。 */
export function splitNpxCommand(command: unknown): { prefix: string; spec: string; rest: string[] } | null {
  const argv = splitCommand(command)
  const index = argv.findIndex((part) => part === 'npx' || part === 'bunx')
  if (index < 0) return null
  const tail = argv.slice(index + 1)
  const specIndex = tail.findIndex((part) => !part.startsWith('-'))
  if (specIndex < 0) return null
  return { prefix: argv[index], spec: tail[specIndex], rest: tail.slice(specIndex + 1) }
}

/** 一个 MCP 声明 → 一项能力。需要的三类东西全部从声明本身读出来，不做猜测：
 *  env 里的键是密钥需求，声明里的 URL 与 env 里的 URL 都是网络需求，命令里的
 *  `npx`/二进制是运行时需求（实机取证：searxng 的内网地址就藏在 `SEARXNG_URL`）。 */
export function capabilityFromMcp(name: string, declaration: McpDeclaration): CapabilityPackage {
  const parser = splitNpxCommand(declaration.command)
  const argv = splitCommand(declaration.command)
  const runtime: string[] = []
  const network: string[] = []
  const secrets: string[] = []

  if (parser) runtime.push(parser.spec)
  else if (argv.length > 0) runtime.push(argv[0])

  const urls = new Set<string>()
  if (typeof declaration.url === 'string') urls.add(declaration.url)
  for (const value of Object.values(declaration.environment ?? {})) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) urls.add(value)
  }
  network.push(...urls)

  for (const [key, value] of Object.entries(declaration.environment ?? {})) {
    // 值是字面量密钥 → 需要搬运；值是引用（{env:…}/{file:…}）或是 URL → 不需要。
    const literal = typeof value === 'string' && !/^\{.*\}$/.test(value) && !/^https?:\/\//.test(value) && looksSecret(key)
    if (literal) secrets.push(key)
  }

  return {
    id: `mcp:${name}`,
    label: `MCP ${name}`,
    where: 'remote',
    needs: {
      ...(secrets.length > 0 ? { secrets } : {}),
      ...(network.length > 0 ? { network } : {}),
      ...(runtime.length > 0 ? { runtime } : {}),
    },
    ...(typeof declaration.url === 'string' && /^https?:/.test(declaration.url)
      ? { note: `远程 MCP（${declaration.url}）——凭据内嵌在 URL 里时要按能力搬运` }
      : {}),
  }
}

/** 名字长得像密钥才要求搬运。宁可少要，也不要为了「完整」去搬一堆非密钥的环境变量。 */
export function looksSecret(key: string): boolean {
  return /(key|token|secret|password|passwd|credential|apikey)/i.test(key)
}

/** 规格串里末尾那段版本/dist-tag：`@scope/pkg@next` → `next`，`pkg` → undefined。
 *  scoped 包名自己的前导 `@` 不算版本（否则 `@scope/pkg` 会解析出 `scope/pkg`）。 */
export function packageVersionOf(spec: string): string | undefined {
  const at = spec.lastIndexOf('@')
  const version = at > 0 ? spec.slice(at + 1).trim() : ''
  return version || undefined
}

/** 一条运行时声明 → 可执行的需求。只有两种形态：
 *  · 绝对路径（`/usr/local/bin/foo`）——目标机上必须已经有了，我们不装二进制分发；
 *  · npm 规格（`mcp-searxng`、`@playwright/mcp@next`）——落到
 *    `~/.ocrc/runtime/<name>/<version|latest>`，运行期不再依赖 npx 联网（D13）。 */
export function classifyRuntimeNeed(raw: string): RuntimeNeed {
  const text = String(raw ?? '').trim()
  if (text.startsWith('/') || text.startsWith('~/')) return { raw: text, kind: 'path', name: text }
  return { raw: text, kind: 'npm', name: packageNameOf(text), version: packageVersionOf(text) }
}

/** 把一批能力要的运行时去重成待办清单（同一项被多项能力要时只装一次）。
 *  返回顺序稳定：先按首次出现顺序，于是面板上的清单不会因为 map 顺序而抖动。 */
export function runtimeNeedsOf(packages: CapabilityPackage[]): Array<{ need: RuntimeNeed; neededBy: string[] }> {
  const table = new Map<string, { need: RuntimeNeed; neededBy: string[] }>()
  for (const pkg of packages) {
    for (const raw of pkg.needs.runtime ?? []) {
      const text = String(raw).trim()
      if (!text) continue
      const existing = table.get(text)
      if (existing) {
        if (!existing.neededBy.includes(pkg.id)) existing.neededBy.push(pkg.id)
        continue
      }
      table.set(text, { need: classifyRuntimeNeed(text), neededBy: [pkg.id] })
    }
  }
  return [...table.values()]
}

/** `npx -y mcp-searxng` → 指向我们在目标侧装好的入口（D13）。
 *  返回 null 表示这条声明不需要改写。 */
export function rewriteNpxCommand(command: unknown, installedPath: string): string | null {
  const parsed = splitNpxCommand(command)
  if (!parsed) return null
  return [installedPath, ...parsed.rest].join(' ')
}

/** 运行期不再依赖 npx 联网：把改写落到配置的副本上（原始配置不被本函数改动）。 */
export function applyNpxRewrites(
  config: Record<string, unknown>,
  installed: Record<string, string>,
): { config: Record<string, unknown>; rewritten: Array<{ capability: string; from: string; to: string }> } {
  const next = structuredClone(config) as Record<string, unknown>
  const rewritten: Array<{ capability: string; from: string; to: string }> = []
  const mcp = next.mcp as { servers?: Record<string, unknown> } | undefined
  if (!mcp?.servers) return { config: next, rewritten }

  for (const [name, raw] of Object.entries(mcp.servers)) {
    if (!raw || typeof raw !== 'object') continue
    const declaration = raw as McpDeclaration
    const parsed = splitNpxCommand(declaration.command)
    if (!parsed) continue
    // 查表先按带版本的写法找，再退到不带版本的名字。
    const replacement = installed[parsed.spec] ?? installed[packageNameOf(parsed.spec)]
    if (!replacement) continue
    const before = splitCommand(declaration.command).join(' ')
    const command = rewriteNpxCommand(declaration.command, replacement)
    if (!command) continue
    declaration.command = Array.isArray(declaration.command) ? command.split(' ') : command
    rewritten.push({ capability: `mcp:${name}`, from: before, to: command })
  }
  return { config: next, rewritten }
}
