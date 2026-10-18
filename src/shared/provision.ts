/** 面板侧 provisioning 的数据模型。
 *
 * 正文与逐条裁决见 PRODUCT 第零点九条与 docs/research/panel-provisioning-verdict.md
 *  （D1–D19）。两个约束贯穿本文件：
 *    · 档案是**主机级**（D16）——隧道、引擎、运行时、版本都绑主机；项目目录是它下面的子项。
 *    · 同步单位是**能力**（D11）——每项能力声明自己要什么（密钥/网络/运行时），
 *      provisioning 负责在目标侧凑齐，而不是按凭据类别搬运。
 *
 * 纯类型 + 纯函数：面板（浏览器沙箱）与服务都 import 它，所以这里不许出现
 * node 内建或 SDK 依赖。
 */

/** 官方 npm 平台包的目标三元组。musl 变体一律不取（D4：只用官方产物）。 */
export type TargetPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64' | 'win32-arm64'

/** 目标机上的一个工作目录（主机档案的子项，D16）。 */
export interface ProjectEntry {
  /** 被控机上的绝对路径（POSIX）。 */
  path: string
  /** 面板上的显示名，默认取路径末段。 */
  label?: string
}

/** 一条转发。端口 0 = 由 OS 分配，实际端口回写后必须展示（D15）。 */
export interface ForwardSpec {
  /** local = `-L`（被控侧可达 → 面板），remote = `-R`（面板 → 被控侧）。 */
  direction: 'local' | 'remote'
  /** 对侧地址：`-L` 时是从被控机看的地址，`-R` 时是从面板看的地址。 */
  peerHost: string
  peerPort: number
  /** 0 = 动态分配；分配结果记录在 ForwardRuntime.port。 */
  port: number
  /** 为什么需要它——能力 id 或一句人话。重写规则要在面板可见（D15）。 */
  reason: string
}

export interface ForwardRuntime extends ForwardSpec {
  /** 实际生效的端口（动态分配后）。 */
  activePort: number
  /** 该转发用途的原始 URL 与重写后的 URL，面板要能一眼看到改了什么。 */
  rewrites?: Array<{ from: string; to: string }>
}

/** 服务在分配端口时换掉的端口（能力转发端口被占用 → 换空闲的）。主隧道端口
 *  永不在此列：4096 是面板宿主用 `OPENCODE_PORT` 指给 openchamber 的那个端口，
 *  静默换掉等于弄坏接入。 */
export interface PortChange {
  reason: string
  from: number
  to: number
}

/** 端口换了之后，URL 改写也得跟着换——面板上「改写前后」必须是实际生效的那一对，
 *  否则用户照着一个不存在的端口去配客户端。只替换「正好是那个端口」的位置。 */
export function applyPortChanges(
  rewrites: Array<{ from: string; to: string }>,
  changes: PortChange[],
): Array<{ from: string; to: string }> {
  if (changes.length === 0) return rewrites
  return rewrites.map((rewrite) => {
    const change = changes.find((c) => hasPort(rewrite.to, c.from))
    return change ? { ...rewrite, to: swapPort(rewrite.to, change.from, change.to) } : rewrite
  })
}

function hasPort(url: string, port: number): boolean {
  return url.includes(`:${port}/`) || url.endsWith(`:${port}`)
}

function swapPort(url: string, from: number, to: number): string {
  const marker = `:${from}`
  const at = url.indexOf(marker)
  if (at < 0) return url
  const after = url.slice(at + marker.length)
  if (after !== '' && !after.startsWith('/')) return url
  return `${url.slice(0, at)}:${to}${after}`
}

export type ReadinessStepId = 'ssh' | 'shell' | 'engine' | 'project'

/** 就绪四档（D8）。逐档给出可执行动作，不做「部分可用」的模糊态。 */
export interface ReadinessStep {
  id: ReadinessStepId
  label: string
  ok: boolean
  detail: string
  /** 不 ok 时用户可以立刻做的事；ok 时为 undefined。 */
  action?: string
}

export interface ReadinessReport {
  steps: ReadinessStep[]
  /** 四档全绿才算就绪——没有「部分可用」。 */
  ready: boolean
}

/** 一次 SSH 探测的全部结论（一条 ssh，一次往返）。 */
export interface DetectReport {
  reachable: boolean
  /** uname/cpuinfo 解析出的目标平台；不支持时为 undefined。 */
  platform?: TargetPlatform
  /** 该用 baseline 构建（无 AVX2——老 VM 常见）。 */
  baseline?: boolean
  /** /etc/os-release 的 PRETTY_NAME，取不到退化为 uname -s。 */
  os?: string
  kernel?: string
  glibc?: string
  container?: 'none' | 'docker' | 'lxc' | 'unknown'
  home?: string
  homeWritable?: boolean
  hasSh?: boolean
  hasTar?: boolean
  /** 探测时目标机能出网（registry.npmjs.org 可达）→ 走「远端直取」。 */
  outbound?: boolean
  /** 目标平台可选但官方不发的组合（例如 EL5 的 glibc 过旧）。 */
  unsupportedReason?: string
  /** 引擎在位时的落点与版本（`~/.opencode/bin/opencode`）。 */
  engine?: { path: string; version: string } | null
  /** 用户既有安装（我们不覆盖，只用来说明差异）。 */
  legacyEngine?: { path: string; version: string } | null
  node?: string
  /** 目标机的 npm 版本——运行时补齐的安装器。 */
  npm?: string
  /** node 够不够跑 npm 形态的运行时（≥ `MINIMUM_NODE_MAJOR`）。 */
  nodeOk?: boolean
  error?: string
}

/** 安装/升级计划——`POST /provision` 的预演结果，确认后才执行（D3）。 */
export interface ProvisionPlan {
  action: 'install' | 'upgrade' | 'downgrade' | 'reinstall' | 'none'
  target: TargetPlatform
  variant: 'default' | 'baseline'
  /** 官方平台包名，例如 `@opencode/cli-linux-x64-baseline`。 */
  package: string
  version: string
  /** npm 发布的 sha512（base64），推送与直取两条路都一样校验（D4）。 */
  integrity: string
  /** remote = 目标机自己下载；push = 从面板缓存推送（air-gapped）。 */
  source: 'remote' | 'push'
  /** 目标机上的落点目录（`~/.opencode/bin`）。 */
  installDir: string
  /** 目标机的 home（安装脚本要用它拼落点）。 */
  home: string
  /** 当前在位版本（有则显示，用于说明升级/回滚方向）。 */
  currentVersion?: string
  /** 为什么是这个动作——给人看的一句话。 */
  reason: string
  /** 面板宿主就是版本源的哪个版本（D6：镜像面板宿主，不 follow latest）。 */
  anchorVersion: string
}

/** 能力包里的一项需求。三类补齐手段见 D12。 */
export interface CapabilityNeed {
  /** 密钥/令牌的名字——值永远不落配置文件，只写 {env:…}/{file:…} 引用（D11）。 */
  secrets?: string[]
  /** 内网地址——补一条隧道，并把 URL 按实际端口重写。 */
  network?: string[]
  /** 需要的运行时/二进制——纳入 provision 清单，在目标侧装。 */
  runtime?: string[]
}

/** 运行时需求的两种形态：npm 规格（`pkg[@ver]`）或目标机上的绝对路径。
 *  前者由 `~/.ocrc/runtime/<name>/<version>` 落地，后者只核对在不在（我们不装
 *  非 npm 分发的东西）。 */
export interface RuntimeNeed {
  /** 原样保留的声明（`@scope/pkg@1.2.3`、`pkg` 或 `/usr/bin/foo`）。 */
  raw: string
  kind: 'npm' | 'path'
  /** npm 形态：包名（剥掉版本）；path 形态：绝对路径。 */
  name: string
  /** npm 形态的版本约束（`>=20` 这种范围也算，由 npm 自己解析）。 */
  version?: string
}

/** 一项运行时在目标机上的现状与计划。impossible 也要给出理由（D12：如实报「装不了」）。 */
export interface RuntimePlanItem {
  need: RuntimeNeed
  action: 'install' | 'present' | 'impossible'
  /** present 时：目标机上的落点（`<home>/.ocrc/runtime/<name>/<version>/<entry>`）。 */
  found?: { path: string; version?: string }
  /** install 时：要装的包名与版本（版本缺省 = 装最新的、由 npm 定）。 */
  package?: string
  version?: string
  /** install 时：目标机上的落点（`<home>/.ocrc/runtime/<name>/<slot>`）。 */
  dir?: string
  /** 该跑什么入口（npm 元数据的 `bin` 解析结果，相对落点目录）。 */
  entry?: string
  /** impossible 的原因（没有 node / node 太老 / 没有 npm / 是路径且不存在 / 非 npm 分发）。 */
  reason?: string
  /** 哪些能力要它（面板上要显示「装了它谁受益」）。 */
  neededBy: string[]
}

/** 一次运行时补齐的待办清单：逐项 install/present/impossible，绝不合并成「部分可用」。 */
export interface RuntimePlan {
  items: RuntimePlanItem[]
  /** 目标机上的运行时根目录（`<home>/.ocrc/runtime`）。 */
  root?: string
  /** 目标机的 node/npm 现状——每一项的判断都基于它，所以必须一起显示。 */
  node?: string
  npm?: string
  nodeOk?: boolean
}

export interface CapabilityPackage {
  id: string
  label: string
  /** 能力在哪跑：远端本地（默认）还是面板侧 + 反向接入（D14）。 */
  where: 'remote' | 'panel'
  needs: CapabilityNeed
  /** 目标侧已有的迹象（由 inspect 填），用于「还需要补什么」。 */
  satisfied?: { secrets: boolean; network: boolean; runtime: boolean }
  note?: string
}

/** 一次 provisioning 的待办清单：每项能力差什么，以及补它的动作。 */
export interface CapabilityPlan {
  id: string
  label: string
  where: 'remote' | 'panel'
  /** 需要补的三类缺口（空了就是已满足）。 */
  missingSecrets: string[]
  missingNetwork: string[]
  missingRuntime: string[]
  /** 会新增/改写的转发（含重写后的 URL）。 */
  forwards: Array<{ spec: ForwardSpec; reason: string; rewrites: Array<{ from: string; to: string }> }>
  /** 目标侧要装的运行时/二进制（去重后的并集）。 */
  install: string[]
}

/** 远程项目的配置现状（GET /project-config）。 */
export interface ProjectConfigReport {
  projectPath: string
  /** 引擎实际会读的那一个文件；都缺时是推荐落点（`.jsonc`，D10）。 */
  targetPath: string
  format: 'jsonc' | 'json' | 'missing'
  exists: boolean
  /** 解析失败时的原因——面板要如实显示，不猜。 */
  parseError?: string
  /** 写入会丢掉注释（.jsonc 里出现注释时如实提示）。 */
  commentsWillBeLost?: boolean
  sections?: Record<string, unknown>
}

/** `POST /capabilities` 的应答：一份被控端项目配置盘出来的能力清单 + 补齐计划。
 *  面板（主机视图、斜杠命令）与服务共用同一份形状。 */
export interface CapabilityReport {
  capabilities: CapabilityPackage[]
  /** 还需要补的转发（端口已由服务侧的分配器定稿）。 */
  forwards: ForwardSpec[]
  /** URL 改写：能力声明里的地址 → 面板上实际能用的地址。 */
  rewrites: Array<{ from: string; to: string }>
  /** 服务想说的人话（哪条能力为什么要转发、哪项网络面板本来就是通的…）。 */
  notes: string[]
  config: ProjectConfigReport
  /** 每项能力要的运行时：install / present / impossible 逐项如实（D12）。 */
  runtime?: RuntimePlan
}

export const MINIMUM_ENGINE_VERSION = '2.0.20'
export const ENGINE_MAJOR = 2
/** npm 形态的运行时要求的最低 node 大版本——EL7 上的老 node 装不了现代包。 */
export const MINIMUM_NODE_MAJOR = 20
/** 运行时落点：`<home>/.ocrc/runtime/<name>/<version>`（D12）。名字里的 `/` 与 `@`
 *  在这里被换成 `__`，避免 scoped 包在目标机上造出意外的目录层级。 */
export const RUNTIME_ROOT = '.ocrc/runtime'

/** openchamber 的门禁是 `major === 2 && >= 2.0.20`（其 compatibility.js）；
 *  这里复述同一判据，因为面板宿主是我们唯一的版本源，推之前必须复核（D6）。 */
export function isSupportedEngineVersion(version: string): boolean {
  const parts = version.split(/[-+]/, 1)[0]?.split('.').map(Number) ?? []
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n))) return false
  if (parts[0] !== ENGINE_MAJOR) return false
  const floor = MINIMUM_ENGINE_VERSION.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i]
  }
  return true
}

/** `@opencode/cli-<target>` / `-baseline`。musl 永不选（D4）。 */
export function platformPackage(target: TargetPlatform, variant: 'default' | 'baseline'): string {
  const suffix = target.replace(/^linux-|^darwin-|^win32-/, '')
  const os = target.startsWith('linux') ? 'linux' : target.startsWith('darwin') ? 'darwin' : 'windows'
  return `@opencode/cli-${os}-${suffix}${variant === 'baseline' ? '-baseline' : ''}`
}

/** 官方安装脚本的落点与文件名（照抄其约定，不发明自己的布局）。 */
export function installDirFor(home: string): string {
  return `${home.replace(/\/+$/, '')}/.opencode/bin`
}

/** 包名 → 目录名：`@scope/pkg` → `scope__pkg`，`pkg` → `pkg`。
 *  只用来造目录，不改写进任何配置——配置里引用的永远是真实入口路径。 */
export function runtimeDirName(packageName: string): string {
  return packageName.replace(/^@/, '').replace(/\//g, '__')
}

/** `~/.ocrc/runtime/<name>/<version>`（D12 的落点约定）。 */
export function runtimeDirFor(home: string, packageName: string, version: string): string {
  return `${home.replace(/\/+$/, '')}/${RUNTIME_ROOT}/${runtimeDirName(packageName)}/${version}`
}

/** 运行时根目录。 */
export function runtimeRootFor(home: string): string {
  return `${home.replace(/\/+$/, '')}/${RUNTIME_ROOT}`
}

export function engineBinaryName(target: TargetPlatform): string {
  return target.startsWith('win32') ? 'opencode.exe' : 'opencode'
}

/** 缺失的档位在 UI 上怎么讲——一句话必须是能做的事，不能是「部分可用」。 */
export function readinessAction(step: ReadinessStepId): string {
  switch (step) {
    case 'ssh': return '检查档案里的地址、端口、私钥路径；面板宿主上先手工 ssh 一次确认能免密登录。'
    case 'shell': return '目标机需要一个可用的 POSIX sh、tar 与可写的 $HOME——这是官方安装路径的最低要求。'
    case 'engine': return '点「部署引擎」把面板宿主的引擎版本装到 ~/.opencode/bin（不覆盖用户既有安装）。'
    case 'project': return '在档案里绑定一个被控机上的工作目录，或在被控机上创建它。'
  }
}
