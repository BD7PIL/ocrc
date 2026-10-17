import { createLogger } from '../utils/logger.js'
import { ocrcHome } from '../utils/paths.js'
import { join } from 'node:path'
import { createRemoteInstancesStore, redactInstance, remoteInstancesPath } from '../core/remote-instances.js'
import { createRemoteInstanceManager, cleanSshNoise, proxyConfig, type InstanceStatus } from '../core/remote-instance-bridge.js'
import { DEFAULT_APP_VERSION, DEFAULT_INSTANCE_PORT, DEFAULT_LOCAL_PORT, PROXY_DEFAULTS, RECONNECT_DEFAULTS, buildDesktopHandoff, instanceIdFor, type RemoteInstance } from '../core/remote-instance.js'
import { appPayloadPath, buildOfflineGuardExports, ensureAppPayload, ensureRuntimePayload, runtimePayloadPath, sha512Base64, sha256Hex, appTreeDir } from '../core/remote-instance-push.js'
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
  console.error(`警告：egress relay 没起来（127.0.0.1:${cfg.localPort}）——对端引擎将没有出网`)
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
                  [--instance-port ${DEFAULT_INSTANCE_PORT}] [--local-port ${DEFAULT_LOCAL_PORT}]
                  [--engine-path /abs/path] [--app-version ${DEFAULT_APP_VERSION}]
  ocrc remote list [--json]
  ocrc remote plan <id>            只读预演：ssh/环境/引擎门禁/装机动作，不写对端
  ocrc remote apply <id> [--force] 推运行时 + 引擎(v2 pin) + 应用（控制端备件，对端零联网）
                  [--engine-version V] [--offline-guard] [--trace <远端前缀>]
  ocrc remote up <id> [--offline-guard] [--no-proxy] [--open]   启动/复用实例 + 转发 + 出网中继
  ocrc remote relay-status <id>    中继端口与日志尾（R9 证据）
  ocrc remote down <id>            停实例 + 撤转发（保留档案）
  ocrc remote status [id]          状态（含对端引擎路径与版本）
  ocrc remote connect <id> [--json] [--open]
                                   一键 external：桌面版要的三项（地址/密码/端口）+ 可选直接打开
  ocrc remote open <id>            打印 URL（并尝试用系统浏览器打开）
  ocrc remote logs <id>            本端隧道/隧道重连日志尾
  ocrc remote remove <id>          删档案（不动对端文件）
  ocrc remote proxy <id> on|off           开关对端引擎的出网代理（R9，落盘）
  ocrc remote proxy <id> allow <a,b>      目标白名单（点边界后缀匹配；空=只拒回环）
  ocrc remote proxy <id> allow-clear      清空白名单
  ocrc remote proxy-serve [--port 4711] [--log F]  前台跑出网中继（up 会自动拉起它）
  ocrc remote proxy-log <file>            判读中继日志：对端是否真的走了我们的代理
  ocrc remote prepare [--app-version V]  只在控制端取件并备好载荷（离线部署前预热）
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
  if (s.runtime) console.log(`    runtime ${s.runtime}`)
  if (s.app) console.log(`    app     ${s.app}`)
  console.log(`    engine  ${engine}`)
  if (s.inspected) console.log(`    host    ${s.inspected.uname ?? '?'} glibc ${s.inspected.glibc ?? '?'}`)
}

/** The record the command should act on: an id from the store, or `--target`. */
function resolveInstance(args: string[], flags: Map<string, string | true>): RemoteInstance {
  const id = args[0]
  if (id) {
    const found = store().get(id)
    if (!found) throw new Error(`没有这个实例档案：${id}（ocrc remote list 看看）`)
    return found
  }
  const adhoc = targetFromFlags(flags)
  if (!adhoc) throw new Error('需要实例 id 或 --target user@host[:port]')
  return adhoc
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
      console.error(`FAIL: ${bad} 个远程脚本含联网命令（对端无公网，R6）`)
      process.exit(1)
    }
    console.log('OK: 所有远程脚本零联网命令（对端离线可装）')
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
    return
  }

  if (sub === 'add') {
    const host = flagStr(flags, 'host')
    if (!host) throw new Error('需要 --host')
    const s = store()
    const saved = s.upsert({
      host,
      user: flagStr(flags, 'user'),
      port: flagNum(flags, 'port', 22),
      name: flagStr(flags, 'name'),
      instancePort: flagNum(flags, 'instance-port', DEFAULT_INSTANCE_PORT),
      localPort: flagNum(flags, 'local-port', DEFAULT_LOCAL_PORT),
      appVersion: flagStr(flags, 'app-version') ?? DEFAULT_APP_VERSION,
      enginePath: flagStr(flags, 'engine-path'),
      enabled: true,
    })
    console.log(`已登记：${saved.id} → ${saved.user ? `${saved.user}@` : ''}${saved.host}:${saved.port}（实例端口 ${saved.instancePort}，本地端口 ${saved.localPort}）`)
    console.log(`UI 密码：${saved.uiPassword}（只存在 ~/.ocrc/remote-instances.json，0600；接口不回显）`)
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
      console.log('（空）ocrc remote add --host <对端> --user <用户> 先登记一台')
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
    console.log(`预演 ${p.id}（${p.target}）`)
    if (!p.reachable) {
      console.error(`  FAIL ${p.sshError}`)
      process.exit(1)
    }
    console.log(`  主机     ${p.inspected?.uname ?? '?'} glibc ${p.inspected?.glibc ?? '?'} HOME=${p.inspected?.home ?? '?'}`)
    console.log(`  运行时   ${p.runtime ?? '缺失（会推送）'}`)
    console.log(`  应用     ${p.app ?? '缺失（会推送）'}（目标 ${instance.appVersion}）`)
    console.log(`  引擎     ${p.engine ? `${p.engine.path} → ${p.engine.version}` : '不满足 v2 门禁'}`)
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
      console.error(`FAIL: 安装期间有 ${offenders.length} 次非回环 connect()（对端应当零外联）`)
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
      console.log('（--no-proxy）本次不注入出网代理；已跑着的对端实例要重启才摘掉旧 env')
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
    if (id) await m.probe(id)
    if (id) {
      const st = m.status(id)
      if (!st) throw new Error(`没有这个实例档案：${id}`)
      printStatus(st)
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
      if (handoff.engine) console.log(`引擎 : ${handoff.engine.version} @ ${handoff.engine.path}`)
      console.log('（openchamber 桌面版 → Remote Instances：把地址与密码填进去，端口填上面那个）')
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
    if (!cur) throw new Error(`没有这个实例档案：${id}`)
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
    if (updated?.proxy) console.log(`  出网中继（R9）：${updated.proxy.enabled ? '开' : '关'} localPort=${updated.proxy.localPort} remotePort=${updated.proxy.remotePort}`)
    return
  }

  if (sub === 'supervise') {
    // 前台跑「隧道监督」（R10 ①②）。`ocrc start`（面板宿主）里是同一份实现，
    // 这个子命令给无面板/纯 CLI 的机器用：Ctrl-C 退出，隧道交给它盯着。
    const m = supervisedManager()
    const lastState = new Map<string, string>()
    console.log('隧道监督中（R10 ①②按档案里的开关跑；Ctrl-C 退出）')
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
    if (!s.get(id)) throw new Error(`没有这个实例档案：${id}`)
    const m = manager()
    await m.down(id).catch((err: unknown) => console.error(`停止时出错（继续删档案）：${cleanSshNoise((err as Error).message)}`))
    m.dispose()
    // Only the record: what we pushed to the host is the host's business —
    // removing it is an explicit `--purge` on the acceptance script's side.
    if (!s.remove(id)) throw new Error(`删除失败：${id}`)
    console.log(`已删档案：${id}（对端 ~/.ocrc/remote 未动）`)
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
    if (!cfg) throw new Error(`没有这个实例档案：${id}`)
    const base = { ...PROXY_DEFAULTS, ...(cfg.proxy ?? {}) }
    const allow = mode === 'allow'
      ? [...new Set((args[3] ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))]
      : mode === 'allow-clear' ? [] : base.allow
    if (mode === 'allow' && allow.length === 0) throw new Error('allow 需要至少一个域名，例如：ocrc remote proxy <id> allow api.deepseek.com,*.openai.com')
    const updated = s.update(id, { proxy: { ...base, enabled: mode === 'on' ? true : mode === 'off' ? false : base.enabled, allow } })
    const onoff = updated?.proxy?.enabled ? '开' : '关'
    const allowTxt = updated?.proxy?.allow?.length ? updated.proxy.allow.join(', ') : '（不限制，仅拒回环）'
    console.log(`egress relay：${updated?.id} 开关=${onoff} localPort=${updated?.proxy?.localPort} → 对端 127.0.0.1:${updated?.proxy?.remotePort}`)
    console.log(`白名单：${allowTxt}`)
    console.log(mode === 'on' ? '下次 ocrc remote up 会重新注入；对端实例需要重启才生效' : '注意：已经跑着的实例仍带着代理 env，重启才摘掉')
    return
  }

  if (sub === 'proxy-log') {
    // 判读远端出网证据：relay 日志里应出现模型主机的 CONNECT。
    const file = args[1]
    if (!file || !existsSync(file)) throw new Error('需要 relay 日志文件路径')
    const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('CONNECT ') || l.includes('GET '))
    for (const l of lines.slice(-10)) console.log(`  ${l}`)
    if (lines.length === 0) {
      console.error('FAIL: relay 日志里没有任何出网记录（对端没走我们的代理）')
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
