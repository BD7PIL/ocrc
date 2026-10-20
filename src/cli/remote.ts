import { createLogger } from '../utils/logger.js'
import { ocrcHome } from '../utils/paths.js'
import { join } from 'node:path'
import { createRemoteInstancesStore, redactInstance, remoteInstancesPath } from '../core/remote-instances.js'
import { createRemoteInstanceManager, cleanSshNoise, proxyConfig, type InstanceStatus } from '../core/remote-instance-bridge.js'
import { DEFAULT_APP_VERSION, DEFAULT_INSTANCE_PORT, DEFAULT_LOCAL_PORT, PROXY_DEFAULTS, RECONNECT_DEFAULTS, buildDesktopHandoff, instanceIdFor, type RemoteInstance } from '../core/remote-instance.js'
import { appPayloadPath, buildOfflineGuardExports, ensureAppPayload, ensureEngineBinary, ensureRuntimePayload, runtimePayloadPath, sha512Base64, sha256Hex, appTreeDir } from '../core/remote-instance-push.js'
import { defaultComponentSources, prepareComponent } from '../core/components.js'
import { bootstrapRemoteInstance, type BootstrapRecordInput, type BootstrapStep } from '../core/remote-instance-bootstrap.js'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'

const log = createLogger('remote-cli')

/** Where a detached relay writes what it dialled — the R9 evidence trail. */
function relayLogPath(): string {
  return join(ocrcHome(), 'remote-relay.log')
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    const done = (v: boolean) => { s.destroy(); resolve(v) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(1_000, () => done(false))
  })
}

/** Make sure an egress relay is listening for this instance before we start it.
 *  Reuses whatever already listens (another instance's relay, or the panel's). */
async function ensureRelay(instance: RemoteInstance): Promise<'existing' | 'started' | 'off'> {
  const cfg = proxyConfig(instance)
  if (!cfg.enabled) return 'off'
  if (await portAccepts(cfg.localPort)) return 'existing'
  const logFile = relayLogPath()
  const entry = process.argv[1] ?? ''
  const allowArg = cfg.allow.length > 0 ? ['--allow', cfg.allow.join(',')] : []
  const child = spawn(process.execPath, [entry, 'remote', 'proxy-serve', '--port', String(cfg.localPort), '--log', logFile, ...allowArg], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 20; i += 1) {
    if (await portAccepts(cfg.localPort)) {
      console.log(`egress relay 已在 127.0.0.1:${cfg.localPort} 上监听（日志 ${logFile}）`)
      return 'started'
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  console.error(`警告：egress relay 没起来（127.0.0.1:${cfg.localPort}）——远程机器的 OpenCode 将没有出网`)
  return 'off'
}

/**
 * `ocrc remote …` — the remote-instance line without the panel.
 *
 * Same store, same manager as the host process (`~/.ocrc/remote-instances.json`),
 * so a tunnel brought up here is the one the panel shows, and the desktop
 * openchamber's "external" entry can attach to it.
 */

const HELP = `
ocrc remote — 远程 openchamber 实例（对端能力）

USAGE:
  ocrc remote add --host H [--user U] [--port 22] [--name N]
                  [--ssh-auth key|password] [--ssh-password P]
                  [--egress auto|relay|direct] [--provision push|reuse] [--provider-baseurl id=url,...]
                  [--instance-port ${DEFAULT_INSTANCE_PORT}] [--local-port ${DEFAULT_LOCAL_PORT}]
                  [--engine-path /abs/path] [--app-version ${DEFAULT_APP_VERSION}]
                  --ssh-auth password：不写 --ssh-password 时从终端（不回显）或 stdin 读一行
                  --egress：auto（默认，探测对端）| relay（强制经控制端）| direct（强制直连）
                  --provision：push（默认，推备件）| reuse（不推字节，只检查 + pin 引擎）
                  --provider-baseurl：同步配置时改写这些 provider 的 baseURL（无外网对端经内网网关，C2b）
  环境变量 OCRC_INSTANCE_ENV=TAVILY_API_KEY[,OTHER]
                  把控制端的这些变量透传进对端实例的 serve 行（让配置里的 {env:…} 能解析；
                  密钥仍然只在控制端的进程环境里，不写进任何配置文件）
  ocrc remote list [--json]
  ocrc remote plan <id>            只读预演：ssh/环境/引擎门禁/装机动作，不写对端
  ocrc remote apply <id> [--force] 推运行时 + 引擎(v2 pin) + 应用（控制端备件，对端零联网）
                  [--engine-version V] [--offline-guard] [--trace <远端前缀>]
                  [--component <dir|tgz|npm-spec>]... [--with-components]
                                   组件（reeve / deep-memory）：读 provision.json，装插件/工件/扩展
  ocrc remote up <id> [--offline-guard] [--no-proxy] [--open]   启动/复用实例 + 转发 + 出网中继
  ocrc remote relay-status <id>    中继端口与日志尾（R9 证据）
  ocrc remote down <id>            停实例 + 撤转发（保留档案）
  ocrc remote status [id]          状态（含对端引擎路径与版本）
  ocrc remote connect <id> [--json] [--open]
                                   三项读出（地址/UI 密码/端口）——浏览器/手动路径；装进官方 app 用 pairlink
  ocrc remote pairlink <id> [--json] [--open]
                                   向上游要一张配对链接（一次性；换每设备 token，可撤销无过期）
                                   --open：拉起桌面版确认；确认后机器出现在「其他 OpenChamber 服务器」
  ocrc remote config-diff <id> [--component <src>]... [--with-components]
                                   本地 vs 对端配置差异（两个方向）+ 一次同步会做什么（只读）
  ocrc remote sync-config <id> [--delete a,b] [--delete-key provider:x,mcp.servers:y] [--dry-run]
                  [--component <src>]... [--with-components]
                  [--prefer-commented-target]
                                   推白名单配置（opencode.json 深合并、只推差异、旧件留 .ocrc-bak）
                                   --delete：对端独有的文件显式删掉（也留 .ocrc-bak）
                                   --delete-key：删对端独有的配置项（provider:x / mcp.servers:y）
                                   --prefer-commented-target：允许重写带注释的对端配置（注释会丢；默认写 opencode.json）
  ocrc remote sync-auth <id>       把本机 auth.json（provider 凭据）写到对端（0600，不回显）
  ocrc remote upgrade <id>         升到控制端的 app pin（已在 pin 上就什么都不做）
  ocrc remote open <id>            打印 URL（并尝试用系统浏览器打开）
  ocrc remote logs <id>            本端隧道/隧道重连日志尾
  ocrc remote peerlog <id> [--lines N]  对端日志尾（我们的 instance.log + 对端 openchamber 日志）
  ocrc remote remove <id>          删档案（不动对端文件）
  ocrc remote proxy <id> on|off           开关对端引擎的出网代理（R9，落盘）
  ocrc remote proxy <id> allow <a,b>      目标白名单（点边界后缀匹配；空=只拒回环）
  ocrc remote proxy <id> allow-clear      清空白名单
  ocrc remote proxy-serve [--port 4711] [--log F]  前台跑出网中继（up 会自动拉起它）
  ocrc remote proxy-log <file>            判读中继日志：对端是否真的走了我们的代理
  ocrc remote prepare [--app-version V] [--engine-version V] [--force]
                  [--component <dir|tgz|npm-spec>]... [--with-components]
                                   只在控制端取件并备好载荷：运行时 + 应用 + 引擎三件（离线部署前预热）
                                   加组件时同时把组件的 npm tarball 取进本地缓存
  ocrc remote bootstrap [<id> | --target user@host[:port]]
                  [--host H --user U] [--port 22] [--name N]
                  [--ssh-auth key|password] [--ssh-password P]
                  [--egress auto|relay|direct] [--provision push|reuse]
                  [--instance-port ${DEFAULT_INSTANCE_PORT}] [--local-port ${DEFAULT_LOCAL_PORT}]
                  [--app-version V] [--engine-path P]
                  [--component <dir|tgz|npm-spec>]... [--with-components]
                  [--no-sync-auth] [--no-sync-config] [--no-pairlink]
                  [--dry-run] [--yes] [--force] [--open]
                                   一条命令接管：记录 → plan → apply → sync-auth → sync-config → up → pairlink
                                   只覆盖你显式给出的字段（uiPassword/端口/引擎 pin/既有密码都保留）；
                                   告警步骤（sync-auth/sync-config/pairlink）不中断；不动对端已 adopt 的引擎
                                   --dry-run：只做本地登记 + 预演，不写远程机器
                                   --yes：非交互执行（没有 TTY 又没给 --yes 会拒绝执行）
  ocrc remote offline-proof       结构性断言：所有远程脚本零联网命令
  ocrc remote trace-check <file>  判读 strace 输出：安装期间是否真的零外联
  ocrc remote --help              这段文字
`

function parseFlags(args: string[]): { _: string[]; flags: Map<string, string | true> } {
  const flags = new Map<string, string | true>()
  const rest: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      } else {
        flags.set(name, true)
      }
    } else {
      rest.push(a)
    }
  }
  return { _: rest, flags }
}

function flagNum(flags: Map<string, string | true>, name: string, fallback: number): number {
  const v = flags.get(name)
  if (v === undefined || v === true) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 65535) throw new Error(`--${name} 不是合法端口：${v}`)
  return n
}

function flagStr(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name)
  return v === undefined || v === true ? undefined : v
}

/** Every value of a repeatable flag (`--component a --component b`). */
function flagAll(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
      out.push(argv[i + 1]!)
      i += 1
    }
  }
  return out
}

/**
 * The peer's SSH password, asked for rather than passed on the command line.
 *
 * `--ssh-password <p>` still works (a scripted run needs it), but the default is
 * to prompt: an argv value lands in the shell history and in every `ps` on the
 * control side, and this is a credential for someone else's machine. With no
 * TTY (a pipe) one line is read from stdin, so `echo "$PW" | ocrc remote add …`
 * never puts the secret in argv either.
 */
async function readSshPassword(flags: Map<string, string | true>): Promise<string> {
  const given = flagStr(flags, 'ssh-password')
  if (given) return given.trim()
  if (!process.stdin.isTTY) {
    const piped = readFileSync(0, 'utf-8').split('\n')[0] ?? ''
    if (!piped.trim()) throw new Error('--ssh-auth password 需要密码：给 --ssh-password，或从 stdin 喂一行')
    return piped.trim()
  }
  process.stdout.write('SSH 密码（不回显）：')
  const pw = await new Promise<string>((resolve) => {
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode?.(true)
    stdin.resume()
    let buf = ''
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(wasRaw ?? false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003') { // Ctrl-C: raw mode swallows the signal, so honour it here.
          stdin.setRawMode?.(wasRaw ?? false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else buf += ch
      }
    }
    stdin.on('data', onData)
  })
  if (!pw.trim()) throw new Error('密码为空——密码档需要非空密码')
  return pw.trim()
}

function store() {
  return createRemoteInstancesStore(remoteInstancesPath(ocrcHome()))
}

// 前台监督（supervise）必须用受监督的隧道：detached 隧道不挂在进程上，
// 也就没有退出事件可依赖（这正是 supervise 存在的理由）。
function supervisedManager() {
  return createRemoteInstanceManager({ store: store() })
}

function manager() {
  // The CLI's tunnels must outlive the command that created them (`up` then
  // `open` then exit); the panel host instead supervises them in-process.
  return createRemoteInstanceManager({ store: store(), forwards: 'detached' })
}

/** `--target user@host[:port]` → a record shape (ad-hoc, no store write). */
function targetFromFlags(flags: Map<string, string | true>): RemoteInstance | undefined {
  const target = flagStr(flags, 'target')
  if (!target) return undefined
  const [userhost, portPart] = target.split(':')
  const [user, host] = userhost.includes('@') ? userhost.split('@') : [undefined, userhost]
  return {
    id: instanceIdFor({ host, user }),
    host,
    user,
    port: portPart ? Number(portPart) : 22,
    instancePort: flagNum(flags, 'instance-port', DEFAULT_INSTANCE_PORT),
    localPort: flagNum(flags, 'local-port', DEFAULT_LOCAL_PORT),
    appVersion: flagStr(flags, 'app-version') ?? DEFAULT_APP_VERSION,
    enginePath: flagStr(flags, 'engine-path'),
    enabled: true,
  }
}

function printStatus(s: InstanceStatus): void {
  const engine = s.engine ? `${s.engine.path}（${s.engine.version}）` : '未定'
  console.log(`  ${s.id}`)
  console.log(`    state   ${s.state}${s.detail ? ` — ${s.detail}` : ''}`)
  console.log(`    url     ${s.url}`)
  if (s.forwardPid) console.log(`    tunnel  pid ${s.forwardPid}${s.forwardAttempts ? `（重连 ${s.forwardAttempts} 次）` : ''}`)
  for (const line of s.holders ?? []) console.log(`    持有者  ${line}`)
  if (s.runtime) console.log(`    runtime ${s.runtime}`)
  if (s.app) console.log(`    app     ${s.app}`)
  console.log(`    engine  ${engine}`)
  if (s.inspected) console.log(`    host    ${s.inspected.uname ?? '?'} glibc ${s.inspected.glibc ?? '?'}`)
  // D1: the decision, not just the relay config. "直连" for a peer with its own
  // internet is a result, not a missing relay, and the reason says which.
  if (s.egress) {
    console.log(`    联网    ${s.egress.relay ? '经本机转发' : '直连'}（策略 ${s.egress.mode}${s.egress.probe ? `，探测 ${s.egress.probe}` : ''}：${s.egress.reason}）`)
  }
  if (s.egress?.cached === false && s.proxy?.enabled) {
    console.log('            （本进程还没探测过；`ocrc remote plan <id>` 会把它探出来）')
  }
}

/** The record the command should act on: an id from the store, or `--target`. */
function resolveInstance(args: string[], flags: Map<string, string | true>): RemoteInstance {
  const id = args[0]
  if (id) {
    const found = store().get(id)
    if (!found) throw new Error(`没有这台服务器：${id}（用 ocrc remote list 看看）`)
    return found
  }
  const adhoc = targetFromFlags(flags)
  if (!adhoc) throw new Error('需要实例 id 或 --target user@host[:port]')
  return adhoc
}

/** A usage mistake (exit 2), as opposed to a step that failed (exit 1). */
class UsageError extends Error {}

function optNum(flags: Map<string, string | true>, name: string): number | undefined {
  if (!flags.has(name)) return undefined
  const v = flags.get(name)
  if (v === undefined || v === true) throw new UsageError(`--${name} 需要一个数值`)
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--${name} 不是合法端口：${v}`)
  return n
}

/** TTY confirmation for a command that writes someone else's machine. */
async function confirmTty(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `)
  const answer = await new Promise<string>((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', (chunk) => {
      process.stdin.pause()
      resolve(chunk.toString('utf-8').split('\n')[0] ?? '')
    })
  })
  return /^y(es)?$/i.test(answer.trim())
}

function stepMark(step: BootstrapStep): string {
  return step.status === 'ok' ? 'OK  '
    : step.status === 'warn' ? 'WARN'
      : step.status === 'failed' ? 'FAIL'
        : '--  '
}

/**
 * `ocrc remote bootstrap` — the seven steps a takeover actually needs, in order.
 *
 * The core sequence lives in `remote-instance-bootstrap.ts`; this function owns
 * argument interpretation, the one confirmation, and the terminal summary. The
 * exit code follows the same split the sequence does: a fatal step = 1, warnings
 * only = 0, a usage mistake = 2.
 */
async function runBootstrap(args: string[], flags: Map<string, string | true>, argv: string[]): Promise<void> {
  const id = args[0]
  const input: BootstrapRecordInput = {}
  if (id) input.id = id

  const target = flagStr(flags, 'target')
  if (target) {
    const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(target.trim())
    if (!m) throw new UsageError(`--target 要写成 user@host[:port]（收到 ${target}）`)
    input.user = m[1]
    input.host = m[2]
    if (m[3]) input.port = Number(m[3])
  }
  const host = flagStr(flags, 'host')
  const user = flagStr(flags, 'user')
  if (host) input.host = host
  if (user) input.user = user
  const port = optNum(flags, 'port')
  if (port !== undefined) input.port = port
  const instancePort = optNum(flags, 'instance-port')
  if (instancePort !== undefined) input.instancePort = instancePort
  const localPort = optNum(flags, 'local-port')
  if (localPort !== undefined) input.localPort = localPort
  const name = flagStr(flags, 'name')
  if (name) input.name = name
  const appVersion = flagStr(flags, 'app-version')
  if (appVersion) input.appVersion = appVersion
  const enginePath = flagStr(flags, 'engine-path')
  if (enginePath) input.enginePath = enginePath
  const egress = flagStr(flags, 'egress')
  if (egress && !['auto', 'relay', 'direct'].includes(egress)) throw new UsageError('--egress 只认 auto / relay / direct')
  if (egress) input.egress = egress as 'auto' | 'relay' | 'direct'
  const provision = flagStr(flags, 'provision')
  if (provision && !['push', 'reuse'].includes(provision)) throw new UsageError('--provision 只认 push / reuse')
  if (provision) input.provision = provision as 'push' | 'reuse'
  const sshAuth = flagStr(flags, 'ssh-auth')
  if (sshAuth && sshAuth !== 'key' && sshAuth !== 'password') throw new UsageError('--ssh-auth 只认 key / password')
  if (sshAuth === 'password') {
    input.sshAuth = 'password'
    input.sshPassword = await readSshPassword(flags)
  } else if (sshAuth === 'key') {
    input.sshAuth = 'key'
  }

  if (!id && !input.host) throw new UsageError('需要实例 id，或 --target user@host[:port] / --host H')

  const dryRun = flags.has('dry-run')
  const s = store()
  // Same store object, not a second load: `apply/up` resolve the record through
  // the manager's store, and a fresh instance would not see the merge this run
  // just wrote (the write itself is debounced by 100 ms).
  const m = createRemoteInstanceManager({ store: s, forwards: 'detached' })
  let planShown = false
  const showPlan = (plan: NonNullable<Awaited<ReturnType<typeof m.plan>>>): void => {
    if (planShown) return
    planShown = true
    console.log(`将在 ${plan.target} 上执行：`)
    for (const action of plan.actions) console.log(`  · ${action}`)
  }

  try {
    const result = await bootstrapRemoteInstance({
      store: s,
      manager: m,
      input,
      opts: {
        components: flagAll(argv, 'component'),
        componentsFromPins: flags.has('with-components'),
        syncAuth: !flags.has('no-sync-auth'),
        syncConfig: !flags.has('no-sync-config'),
        pairlink: !flags.has('no-pairlink'),
        force: flags.has('force'),
        engineVersion: flagStr(flags, 'engine-version'),
        dryRun,
        onLog: (line) => console.log(`  · ${line}`),
        onStep: (step) => console.log(`  ${stepMark(step)} ${step.name}${step.detail ? ` — ${step.detail}` : ''}`),
        confirm: async (plan) => {
          showPlan(plan)
          if (flags.has('yes')) return true
          if (!process.stdin.isTTY) {
            throw new UsageError('非交互环境：加 --yes 才会写远程机器（或先用 --dry-run 预演）')
          }
          return confirmTty('继续执行？')
        },
      },
    })
    if (result.plan && (result.dryRun || result.cancelled)) showPlan(result.plan)

    if (result.dryRun) {
      console.log(result.ok
        ? `预演通过：${result.id}（只读；加 --yes 才真正执行）`
        : `预演失败：${result.id}——上面 FAIL 的那一步要先解决`)
      if (!result.ok) process.exit(1)
      return
    }
    if (result.cancelled) {
      console.log('已取消（远程机器未改动）。')
      process.exit(1)
    }
    if (!result.ok) {
      const failed = result.steps.filter((step) => step.status === 'failed').map((step) => step.name)
      console.error(`FAIL 接管失败：${result.id}${failed.length ? `（${failed.join(', ')}）` : ''}`)
      process.exit(1)
    }

    const warnings = result.steps.filter((step) => step.status === 'warn')
    console.log('')
    console.log(`完成：${result.id}${warnings.length ? `（${warnings.length} 条告警，见上方 WARN）` : ''}`)
    if (result.link) {
      console.log('配对链接（一次性）：')
      console.log(result.link)
      if (result.expiresAt) console.log(`有效期至 ${result.expiresAt}`)
      console.log('（在 openchamber 桌面版里打开它；这台机器会出现在「其他 OpenChamber 服务器」）')
    }
    const localUrl = result.record ? `http://127.0.0.1:${result.record.localPort}` : result.url
    if (localUrl) console.log(`打开：${localUrl}`)
    if (flags.has('open')) {
      const toOpen = result.link ?? localUrl
      if (toOpen) await openUrl(toOpen)
    }
  } finally {
    m.dispose()
  }
}

export async function main(argv: string[]): Promise<void> {
  const { _: args, flags } = parseFlags(argv)
  const cmd = args[0] ?? 'help'
  const sub = cmd === 'help' || flags.has('help') || cmd === '--help' ? 'help' : cmd

  if (sub === 'help') {
    console.log(HELP)
    return
  }

  if (sub === 'offline-proof') {
    // Structural half of the offline guarantee: every script that would run on
    // the controlled host, asserted free of egress commands. The live half is
    // the acceptance script's poisoned-proxy run.
    const { offlineScriptInventory, findEgressCommands } = await import('../core/remote-instance-push.js')
    const appVersion = flagStr(flags, 'app-version') ?? DEFAULT_APP_VERSION
    let bad = 0
    for (const { what, script } of offlineScriptInventory(appVersion)) {
      const hits = findEgressCommands(script)
      console.log(`  ${hits.length === 0 ? 'OK  ' : 'FAIL'} ${what}${hits.length ? ` — 含联网命令：${hits.join(', ')}` : ''}`)
      if (hits.length) bad += 1
    }
    if (bad > 0) {
      console.error(`FAIL: ${bad} 个远程脚本含联网命令（远程机器无公网，R6）`)
      process.exit(1)
    }
    console.log('OK: 所有远程脚本零联网命令（远程机器离线可装）')
    return
  }

  if (sub === 'prepare') {
    const appVersion = flagStr(flags, 'app-version') ?? DEFAULT_APP_VERSION
    const force = flags.has('force')
    const say = (l: string) => console.log(`  ${l}`)
    const rt = await ensureRuntimePayload({ force, onLog: say })
    console.log(`  runtime: ${runtimePayloadPath()} ${(rt.bytes / 1e6).toFixed(1)}MB sha256 ${rt.sha.slice(0, 16)}…${rt.prepared ? '（新取件）' : '（缓存命中）'}`)
    const app = await ensureAppPayload(appVersion, { force, onLog: say })
    console.log(`  app:     ${appPayloadPath(appVersion)} ${(app.bytes / 1e6).toFixed(1)}MB sha512 ${app.sha.slice(0, 16)}…${app.prepared ? '（新打包）' : '（缓存命中）'}`)
    console.log(`  树：     ${appTreeDir(appVersion)}`)
    // B1: the engine is the third payload, and the one that used to be missing
    // here — a warmed cache without it still stops halfway through an offline
    // `apply`, because the peer cannot fetch it (that is the whole point).
    const engine = await ensureEngineBinary({ version: flagStr(flags, 'engine-version'), force, onLog: say })
    console.log(`  engine:  ${engine.file} opencode v${engine.version} ${(engine.bytes / 1e6).toFixed(1)}MB sha256 ${engine.sha.slice(0, 16)}…${engine.prepared ? '（新取件）' : '（缓存命中）'} → ${engine.target}`)
    const componentSources = [
      ...flagAll(argv, 'component'),
      ...(flags.has('with-components') ? defaultComponentSources() : []),
    ]
    for (const source of componentSources) {
      const c = await prepareComponent(source)
      const size = statSync(c.tarball).size / 1e6
      console.log(`  component: ${c.manifest.name} ${c.manifest.version} ${size.toFixed(1)}MB sha256 ${c.sha256.slice(0, 16)}… → ${c.tarball}`)
    }
    console.log('  备件齐了：离线 apply 不会再半路缺件（远程机器全程零联网）。')
    return
  }

  if (sub === 'bootstrap') {
    try {
      await runBootstrap(args.slice(1), flags, argv)
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(`用法错误：${err.message}`)
        process.exit(2)
      }
      throw err
    }
    return
  }

  if (sub === 'add') {
    const host = flagStr(flags, 'host')
    if (!host) throw new Error('需要 --host')
    const authFlag = flagStr(flags, 'ssh-auth')
    if (authFlag && authFlag !== 'key' && authFlag !== 'password') {
      throw new Error('--ssh-auth 只认 key / password')
    }
    const sshPassword = authFlag === 'password' ? await readSshPassword(flags) : undefined
    const egressFlag = flagStr(flags, 'egress')
    if (egressFlag && !['auto', 'relay', 'direct'].includes(egressFlag)) throw new Error('--egress 只认 auto / relay / direct')
    const provisionFlag = flagStr(flags, 'provision')
    if (provisionFlag && !['push', 'reuse'].includes(provisionFlag)) throw new Error('--provision 只认 push / reuse')
    // C2b: per-peer provider URL rewrites, `id=url,id=url`. A peer without its
    // own egress may only reach a provider through our relay or an internal
    // gateway, so the URL the control side uses is not always the peer's.
    const baseUrlFlag = flagStr(flags, 'provider-baseurl')
    const providerBaseUrl = baseUrlFlag
      ? Object.fromEntries(baseUrlFlag.split(',').map((pair) => {
        const i = pair.indexOf('=')
        if (i <= 0) throw new Error(`--provider-baseurl 要写成 id=url（收到 ${pair}）`)
        return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()]
      }))
      : undefined
    const s = store()
    const saved = s.upsert({
      host,
      user: flagStr(flags, 'user'),
      port: flagNum(flags, 'port', 22),
      name: flagStr(flags, 'name'),
      sshAuth: authFlag === 'password' ? 'password' : undefined,
      sshPassword,
      egress: egressFlag as 'auto' | 'relay' | 'direct' | undefined,
      provision: provisionFlag as 'push' | 'reuse' | undefined,
      providerBaseUrl,
      instancePort: flagNum(flags, 'instance-port', DEFAULT_INSTANCE_PORT),
      localPort: flagNum(flags, 'local-port', DEFAULT_LOCAL_PORT),
      appVersion: flagStr(flags, 'app-version') ?? DEFAULT_APP_VERSION,
      enginePath: flagStr(flags, 'engine-path'),
      enabled: true,
    })
    console.log(`已登记：${saved.id} → ${saved.user ? `${saved.user}@` : ''}${saved.host}:${saved.port}（实例端口 ${saved.instancePort}，本地端口 ${saved.localPort}）`)
    console.log(`登录方式：${saved.sshAuth === 'password' ? '密码（askpass 喂 ssh，密码只落 0600 文件，接口不回显）' : '密钥（BatchMode=yes，用本机 ~/.ssh 与 agent）'}`)
    console.log(`联网方式：${saved.egress ?? 'auto（探测：能直连就直连，不能才经本机转发）'}`)
    console.log(`安装方式：${saved.provision === 'reuse' ? '复用已安装（一个字节都不推，只检查 + pin OpenCode）' : '推送安装（控制端备件推过去，远程机器零联网）'}`)
    console.log(`界面密码：${saved.uiPassword}（只存在 ~/.ocrc/remote-instances.json，0600；接口不回显）`)
    console.log(`下一步：ocrc remote plan ${saved.id}`)
    return
  }

  if (sub === 'list') {
    const list = store().list()
    if (flags.has('json')) {
      console.log(JSON.stringify({ instances: list.map(redactInstance) }, null, 2))
      return
    }
    if (list.length === 0) {
      console.log('（空）ocrc remote add --host <主机> --user <用户> 先添加一台')
      return
    }
    const m = manager()
    for (const i of list) {
      const st = m.status(i.id)
      console.log(`  ${i.id}  ${st?.state ?? 'unknown'}  ${st?.url ?? ''}`)
    }
    m.dispose()
    return
  }

  if (sub === 'plan') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const p = await m.plan(instance.id)
    console.log(`检查 ${p.id}（${p.target}）`)
    if (!p.reachable) {
      console.error(`  FAIL ${p.sshError}`)
      process.exit(1)
    }
    console.log(`  主机     ${p.inspected?.uname ?? '?'} glibc ${p.inspected?.glibc ?? '?'} HOME=${p.inspected?.home ?? '?'}`)
    console.log(`  运行时   ${p.runtime ?? '缺失（会推送）'}`)
    console.log(`  应用     ${p.app ?? '缺失（会推送）'}（目标 ${instance.appVersion}）`)
    console.log(`  OpenCode ${p.engine ? `${p.engine.path} → ${p.engine.version}` : '不满足 v2 门禁'}`)
    for (const c of p.engineCandidates) console.log(`           · ${c.path} → ${c.raw || '（版本未知）'}`)
    if (p.engineError) console.error(`  FAIL ${p.engineError}`)
    console.log('  将要做的：')
    for (const a of p.actions) console.log(`    - ${a}`)
    console.log(`  打开地址 ${p.url}`)
    m.dispose()
    if (p.engineError) process.exit(1)
    return
  }

  if (sub === 'apply') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const r = await m.apply(instance.id, {
      force: flags.has('force'),
      engineVersion: flagStr(flags, 'engine-version'),
      guard: flags.has('offline-guard'),
      trace: flagStr(flags, 'trace'),
      components: flagAll(argv, 'component'),
      componentsFromPins: flags.has('with-components'),
      onLog: (line) => console.log(`  ${line}`),
    })
    console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.detail}`)
    m.dispose()
    if (!r.ok) process.exit(1)
    console.log(`下一步：ocrc remote up ${instance.id}`)
    return
  }

  if (sub === 'trace-check') {
    // §5.3：strace 证据的判读端。装机的「零外联」不靠代理语义，靠 connect() 事实。
    const file = args[1]
    if (!file || !existsSync(file)) throw new Error('需要 strace 输出文件路径')
    const { findOutboundConnects } = await import('../core/remote-instance-push.js')
    const offenders = findOutboundConnects(readFileSync(file, 'utf-8'))
    for (const line of offenders.slice(0, 10)) console.log(`  ${line}`)
    if (offenders.length > 0) {
      console.error(`FAIL: 安装期间有 ${offenders.length} 次非回环 connect()（远程机器应当零外联）`)
      process.exit(1)
    }
    console.log(`OK: ${file} 里没有非回环 connect()（安装零外联）`)
    return
  }

  if (sub === 'up') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    // CLI lifetime ≠ instance lifetime: the relay must outlive this process, so
    // it runs as a detached `proxy-serve` (the panel host keeps it in-process).
    // Started before `up`, so the serve line's proxy URL is already live.
    if (flags.has('no-proxy')) {
      store().update(instance.id, { proxy: { ...(instance.proxy ?? PROXY_DEFAULTS), enabled: false } })
      console.log('（--no-proxy）本次不注入出网代理；已跑着的远程实例要重启才摘掉旧 env')
    } else {
      const relay = await ensureRelay(instance)
      if (relay === 'off') console.log('（代理已关：ocrc remote proxy <id> on 可打开）')
    }
    const r = await m.up(instance.id, { guard: flags.has('offline-guard') })
    console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.detail}`)
    if (!r.ok) {
      for (const l of m.logs(instance.id).slice(-8)) console.log(`  · ${l}`)
      process.exit(1)
    }
    console.log(`打开：${`http://127.0.0.1:${instance.localPort}`}`)
    if (flags.has('open')) await openUrl(`http://127.0.0.1:${instance.localPort}`)
    m.dispose()
    return
  }

  if (sub === 'relay-status') {
    const instance = resolveInstance(args.slice(1), flags)
    const cfg = proxyConfig(instance)
    const alive = await portAccepts(cfg.localPort)
    console.log(`egress relay: ${cfg.enabled ? '开' : '关'} localPort=${cfg.localPort} remotePort=${cfg.remotePort} ${alive ? 'listening' : 'NOT listening'}`)
    const logFile = relayLogPath()
    if (existsSync(logFile)) {
      for (const l of readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).slice(-5)) console.log(`  ${l}`)
    }
    if (!alive && cfg.enabled) process.exit(1)
    return
  }

  if (sub === 'down') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const r = await m.down(instance.id)
    console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.detail}`)
    m.dispose()
    if (!r.ok) process.exit(1)
    return
  }

  if (sub === 'status') {
    const id = args[1]
    const m = manager()
    // 内存状态只在拥有隧道的进程里；换个进程跑 status 时，用一次实测把话说准。
    if (id) {
      // 出口是"决定"，不是内存里的开关：冷进程里先把它探出来，否则状态页永远
      // 显示"尚未探测"，用户看不到自己要的那句"直连/经控制端"。
      await m.egress(id).catch(() => { /* 探测失败不改状态结论，照旧由 status 说 */ })
      const live = await m.probe(id)
      const st = m.status(id)
      if (!st) throw new Error(`没有这台服务器：${id}`)
      if (live.online) printStatus({ ...st, state: 'online', detail: live.version ? `openchamber ${live.version}（实测）` : live.detail ?? st.detail })
      else if (live.remote) printStatus({ ...st, state: 'unknown', detail: live.detail })
      else printStatus({ ...st, state: st.state === 'online' ? 'offline' : st.state, detail: live.detail ?? st.detail })
    } else {
      const all = m.statusAll()
      if (all.length === 0) console.log('（没有登记的实例）')
      for (const st of all) printStatus(st)
    }
    m.dispose()
    return
  }

  if (sub === 'logs') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    for (const l of m.logs(instance.id)) console.log(`  ${l}`)
    m.dispose()
    return
  }

  if (sub === 'config-diff') {
    // C5 的终端形态：先把差异摆出来（两个方向），再决定推不推。
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const d = await m.configDiff(instance.id, {
      components: [...flagAll(argv, 'component'), ...(flags.has('with-components') ? defaultComponentSources() : [])],
    })
    m.dispose()
    console.log(`本地配置 ${d.localDir}`)
    if (d.peerError) console.error(`  FAIL 读远程机器失败：${d.peerError}`)
    const show = (label: string, list: string[]) => console.log(`  ${label} ${list.length}${list.length ? `：${list.slice(0, 8).join(', ')}${list.length > 8 ? ' …' : ''}` : ''}`)
    show('只在本地（会推过去）', d.add)
    show('两边不同（会覆盖，旧件留 .ocrc-bak）', d.change)
    show('两边相同（不动）', d.same)
    show('只在远程机器（不动；要删得显式 --delete）', d.peerOnly)
    show('远程机器算不出哈希（不当作相同）', d.unknown)
    console.log(`  凭据 auth.json：控制端 ${d.auth.local ? '有' : '无'}，远程机器 ${d.auth.peer ? '有' : '无'}`)
    console.log(`  一次同步会：写 ${d.plan.files.length} 个文件${d.plan.deletes.length ? `、删 ${d.plan.deletes.length} 个` : ''}；配置 ${d.plan.configChanged ? `会改（写 ${d.plan.basename}）` : '无变化'}`)
    if (d.plan.keyDeleteCandidates.length > 0) {
      console.log(`  远程机器独有的配置项（要删用 --delete-key）：${d.plan.keyDeleteCandidates.map((c) => c.collection + ':' + c.key).join(', ')}`)
    }
    if (d.plan.shadowed.length > 0) console.log(`  会被远程覆盖层压住的键：${d.plan.shadowed.join('、')}`)
    if (d.plan.managedPlugins.length > 0) console.log(`  组件插件条目：${d.plan.managedPlugins.join('、')}`)
    for (const n of d.plan.notes) console.log(`  · ${n}`)
    return
  }

  if (sub === 'sync-config') {
    const instance = resolveInstance(args.slice(1), flags)
    const deletes = (flagStr(flags, 'delete') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const keyDeletes = (flagStr(flags, 'delete-key') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const m = manager()
    const r = await m.syncConfig(instance.id, {
      deletes,
      keyDeletes,
      dryRun: flags.has('dry-run'),
      // 显式允许重写带注释的对端配置（注释会丢）——默认不碰用户的文档。
      preferCommentedTarget: flags.has('prefer-commented-target'),
      components: [...flagAll(argv, 'component'), ...(flags.has('with-components') ? defaultComponentSources() : [])],
    })
    m.dispose()
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.detail}`)
    if (!r.ok) process.exit(1)
    return
  }

  if (sub === 'sync-auth') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const r = await m.syncAuth(instance.id)
    m.dispose()
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.detail}`)
    if (!r.ok) process.exit(1)
    return
  }

  if (sub === 'pairlink') {
    // 上游的配对路径：对端自己的 CLI 发一张一次性链接，桌面版确认后换成**每设备**
    // 的 token（可撤销、无过期）——我们不存任何凭据，只保证链接里的 URL 可达
    // （转发 + 出网腿 + 监护），这正好是面板那个按钮调的东西。
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const r = await m.pairLink(instance.id)
    m.dispose()
    if (!r.ok) {
      console.error(`FAIL ${r.detail}`)
      process.exit(1)
    }
    if (flags.has('json')) {
      console.log(JSON.stringify(r, null, 2))
      return
    }
    console.log(r.detail)
    if (r.link) console.log(r.link)
    if (r.expiresAt) console.log(`有效期至 ${r.expiresAt}`)
    console.log('（在 openchamber 桌面版里打开这个链接并确认；这台机器会出现在「其他 OpenChamber 服务器」，不在「远程实例」）')
    if (flags.has('open') && r.link) {
      // Windows 上 start 会走注册表里的 openchamber:// 处理器；Linux/macOS 用 xdg-open/open。
      const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', r.link] : [r.link]
      try {
        spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref()
      } catch (err) {
        console.log(`（打开失败：${(err as Error).message}——手动复制上面那行）`)
      }
    }
    return
  }

  if (sub === 'upgrade') {
    // D5：版本是 pin 不是选项，所以只有这一个升级动作——对端落后于控制端的 pin 时才动。
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const r = await m.upgrade(instance.id)
    m.dispose()
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.detail}`)
    if (!r.ok) process.exit(1)
    return
  }

  if (sub === 'peerlog') {
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const r = await m.peerLogs(instance.id, { lines: flagNum(flags, 'lines', 40) })
    m.dispose()
    if (!r.ok) {
      console.error(`FAIL 取远程日志失败：${r.error ?? '原因未知'}`)
      process.exit(1)
    }
    console.log(`远程实例日志 ${r.paths.instance}`)
    console.log(r.instance.length ? r.instance.join('\n') : '  （空——实例可能没起过）')
    console.log(`远程机器的 OpenChamber 日志 ${r.paths.app}`)
    console.log(r.app.length ? r.app.join('\n') : '  （空）')
    return
  }

  if (sub === 'connect') {
    // 「一键 external」：桌面版 Remote Instances 要的三项一次算好；--json 给脚本/面板，
    // --open 直接打开浏览器/PWA 那一档（本机 UI 就在这个 URL 上）。
    const instance = resolveInstance(args.slice(1), flags)
    const m = manager()
    const st = m.status(instance.id)
    // 实测优先：内存状态在别的进程里是 unknown，不能拿它说「不在线」
    const live = await m.probe(instance.id)
    const handoff = buildDesktopHandoff(instance, {
      state: live.online ? 'online' : (st?.state === 'online' ? 'online' : (st?.state ?? 'unknown')),
      engine: st?.engine,
    })
    m.dispose()
    if (flags.has('json')) {
      const { lines: _lines, ...rest } = handoff
      console.log(JSON.stringify(rest, null, 2))
    } else {
      console.log(handoff.lines.join('\n'))
      if (handoff.engine) console.log(`OpenCode : ${handoff.engine.version} @ ${handoff.engine.path}`)
      console.log('（浏览器/手动路径用：把地址与密码填进去。装进官方 app 请用 ocrc remote pairlink——身份在上游，我们不写它的 settings.json）')
    }
    if (flags.has('open')) {
      if (!handoff.running) console.error('注意：实例当前不在线，打开会失败——先 ocrc remote up')
      await openUrl(handoff.url)
    }
    return
  }

  if (sub === 'open') {
    const instance = resolveInstance(args.slice(1), flags)
    const url = `http://127.0.0.1:${instance.localPort}`
    console.log(url)
    await openUrl(url)
    return
  }

  if (sub === 'switches') {
    // R10 三个开关（默认 开/开/关）。落盘，重启后仍按它跑。
    const id = args[1]
    if (!id) throw new Error('用法：ocrc remote switches <id> [--reconnect on|off] [--restore on|off] [--replay on|off]')
    const s = store()
    const cur = s.get(id)
    if (!cur) throw new Error(`没有这台服务器：${id}`)
    const tri = (name: string): boolean | undefined => {
      const v = flagStr(flags, name)
      if (v === undefined) return undefined
      if (v !== 'on' && v !== 'off') throw new Error(`--${name} 只能是 on|off`)
      return v === 'on'
    }
    const patch = {
      reconnect: tri('reconnect') ?? cur.reconnect ?? RECONNECT_DEFAULTS.reconnect,
      restoreOnStart: tri('restore') ?? cur.restoreOnStart ?? RECONNECT_DEFAULTS.restoreOnStart,
      replayQueued: tri('replay') ?? cur.replayQueued ?? RECONNECT_DEFAULTS.replayQueued,
    }
    const updated = s.update(id, patch)
    console.log(`R10 开关（${id}）：`)
    console.log(`  ① 掉线自动重连 + 重订阅：${patch.reconnect ? '开' : '关'}${patch.reconnect ? `（退避 ${2}s→60s）` : '（掉线就停在那，等你手动 up）'}`)
    console.log(`  ② 控制端重启后自恢复：    ${patch.restoreOnStart ? '开' : '关'}${patch.restoreOnStart ? '（面板/ocrc start 起来就把隧道拉回）' : '（启动时不自动拉）'}`)
    console.log(`  ③ 断线期间操作排队补发：  ${patch.replayQueued ? '开' : '关'}（补发由实例自己的队列决定，我们只持久化这个口径）`)
    if (updated?.proxy) console.log(`  出网转发（R9）：${updated.proxy.enabled ? '开' : '关'} localPort=${updated.proxy.localPort} remotePort=${updated.proxy.remotePort}`)
    return
  }

  if (sub === 'supervise') {
    // 前台跑「隧道监督」（R10 ①②）。`ocrc start`（面板宿主）里是同一份实现，
    // 这个子命令给无面板/纯 CLI 的机器用：Ctrl-C 退出，隧道交给它盯着。
    const m = supervisedManager()
    const lastState = new Map<string, string>()
    console.log('转发监督中（R10 ①②按记录里的开关跑；Ctrl-C 退出）')
    const ids = store().list().map((i) => i.id)
    for (const inst of store().list()) {
      const st = m.status(inst.id)
      console.log(`  ${inst.id}: ${st?.state ?? 'unknown'} 重连=${inst.reconnect !== false ? '开' : '关'} 自恢复=${inst.restoreOnStart !== false ? '开' : '关'}`)
    }
    m.ensureAll()
    // 监督的意义就是"你在旁边能看见它做了什么"：每秒把新日志与状态变化打到终端。
    // （manager 的日志在内存里；没有这一步，重连/退避都只能靠事后翻文件。）
    const seen = new Map<string, number>()
    const ticker = setInterval(() => {
      for (const id of ids) {
        const lines = m.logs(id)
        const from = seen.get(id) ?? 0
        for (const line of lines.slice(from)) console.log(`  [${new Date().toISOString().slice(11, 19)}] ${line}`)
        seen.set(id, lines.length)
        const st = m.status(id)
        if (st && st.state !== lastState.get(id)) {
          lastState.set(id, st.state)
          console.log(`  [${new Date().toISOString().slice(11, 19)}] state=${st.state}${st.detail ? ` — ${st.detail}` : ''}`)
        }
      }
    }, 1_000)
    // 刻意不 unref：这个 ticker 是监督进程的心跳。unref 过一次的后果是——隧道一死，
    // 事件循环就空了，进程正好在「该重连」的时刻自己退出（真踩过）。
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearInterval(ticker)
        m.dispose()
        resolve()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
    return
  }

  if (sub === 'remove') {
    const id = args[1]
    if (!id) throw new Error('需要实例 id')
    const s = store()
    if (!s.get(id)) throw new Error(`没有这台服务器：${id}`)
    const m = manager()
    await m.down(id).catch((err: unknown) => console.error(`停止时出错（继续删记录）：${cleanSshNoise((err as Error).message)}`))
    m.dispose()
    // Only the record: what we pushed to the host is the host's business —
    // removing it is an explicit `--purge` on the acceptance script's side.
    if (!s.remove(id)) throw new Error(`删除失败：${id}`)
    console.log(`已移除服务器：${id}（远程机器上的 ~/.ocrc/remote 未动）`)
    return
  }

  if (sub === 'guard-env') {
    // Printed so scripts can reuse the exact same poisoning the CLI uses.
    process.stdout.write(buildOfflineGuardExports())
    return
  }

  if (sub === 'proxy-serve') {
    // Long-lived egress relay (R9). `up` spawns this detached so a CLI-launched
    // instance keeps its egress after the CLI exits; the panel host instead runs
    // the same server in-process (see core/remote-instance-bridge.ts).
    const port = flagNum(flags, 'port', 4711)
    const logFile = flagStr(flags, 'log')
    const { createInstanceProxy } = await import('../core/remote-instance-proxy.js')
    const proxy = await createInstanceProxy({
      port,
      allowLocal: flags.has('allow-local'),
      allow: (flagStr(flags, 'allow') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      onLog: (line) => {
        const stamped = `${new Date().toISOString()} ${line}`
        console.log(stamped)
        if (logFile) appendFileSync(logFile, `${stamped}\n`)
      },
    })
    console.log(`egress relay on 127.0.0.1:${proxy.port}${logFile ? `（日志 ${logFile}）` : ''}`)
    process.on('SIGINT', () => { void proxy.close().then(() => process.exit(0)) })
    process.on('SIGTERM', () => { void proxy.close().then(() => process.exit(0)) })
    return
  }

  if (sub === 'proxy') {
    // 开关落盘（R9）：`proxy off` 之后下一次 up 就不注入代理了。
    const id = args[1]
    const mode = args[2]
    if (!id || (mode !== 'on' && mode !== 'off' && mode !== 'allow' && mode !== 'allow-clear')) {
      throw new Error('用法：ocrc remote proxy <id> on|off|allow <csv>|allow-clear')
    }
    const s = store()
    const cfg = s.get(id)
    if (!cfg) throw new Error(`没有这台服务器：${id}`)
    const base = { ...PROXY_DEFAULTS, ...(cfg.proxy ?? {}) }
    const allow = mode === 'allow'
      ? [...new Set((args[3] ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))]
      : mode === 'allow-clear' ? [] : base.allow
    if (mode === 'allow' && allow.length === 0) throw new Error('allow 需要至少一个域名，例如：ocrc remote proxy <id> allow api.deepseek.com,*.openai.com')
    const updated = s.update(id, { proxy: { ...base, enabled: mode === 'on' ? true : mode === 'off' ? false : base.enabled, allow } })
    const onoff = updated?.proxy?.enabled ? '开' : '关'
    const allowTxt = updated?.proxy?.allow?.length ? updated.proxy.allow.join(', ') : '（不限制，仅拒回环）'
    console.log(`出网转发：${updated?.id} 开关=${onoff} localPort=${updated?.proxy?.localPort} → 远程机器 127.0.0.1:${updated?.proxy?.remotePort}`)
    console.log(`白名单：${allowTxt}`)
    console.log(mode === 'on' ? '下次 `ocrc remote up` 会重新注入；远程实例需要重启才生效' : '注意：已经跑着的实例仍带着代理 env，重启才摘掉')
    return
  }

  if (sub === 'proxy-log') {
    // 判读远端出网证据：relay 日志里应出现模型主机的 CONNECT。
    const file = args[1]
    if (!file || !existsSync(file)) throw new Error('需要 relay 日志文件路径')
    const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('CONNECT ') || l.includes('GET '))
    for (const l of lines.slice(-10)) console.log(`  ${l}`)
    if (lines.length === 0) {
      console.error('FAIL: 转发日志里没有任何出网记录（远程机器没走我们的代理）')
      process.exit(1)
    }
    console.log(`OK: relay 记录了 ${lines.length} 次出网`)
    return
  }

  if (sub === 'payload-sha') {
    const file = args[1]
    if (!file || !existsSync(file)) throw new Error('需要载荷文件路径')
    const size = statSync(file).size
    console.log(JSON.stringify({ file, bytes: size, sha512: sha512Base64(file), sha256: sha256Hex(file) }))
    return
  }

  console.error(`未知子命令：${cmd}`)
  console.log(HELP)
  process.exit(2)
}

async function openUrl(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: 'ignore', detached: true })
  child.unref()
  log.info(`opened ${url}`)
}

export { HELP as remoteHelp }
