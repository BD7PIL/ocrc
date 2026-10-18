import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_CANDIDATES,
  MIN_ENGINE_VERSION,
  NODE_RUNTIME,
  RECONNECT_DEFAULTS,
  buildEngineProbeCommand,
  buildForwardArgs,
  buildInstanceServeCommand,
  buildInstanceStatusCommand,
  buildInstanceStopCommand,
  buildSshExecArgs,
  buildTerminalProbeCommand,
  instancePaths,
  judgeEngineCompat,
  isSupportedEngineVersion,
  judgeInstanceVersion,
  normalizeEngineVersion,
  parseEngineProbe,
  parseTerminalProbe,
  quoteRemotePath,
  pickV2Engine,
  renderExports,
} from '../../src/core/remote-instance.js'

/** Dev plan §5.1: pin the decisions and the shell lines; the ssh transport and
 *  the real-host walk live in the plan's acceptance script. The two failures
 *  these tests exist for are both silent in production: a v1 engine sneaking in
 *  (openchamber dies on its own gate) and a PATH-resolved binary (we point at
 *  the wrong opencode). */

describe('引擎 v2 门禁（R12）', () => {
  it('只认 major=2 且 ≥ 2.0.20（与 openchamber compatibility.js 同判据）', () => {
    expect(isSupportedEngineVersion('2.0.20')).toBe(true)
    expect(isSupportedEngineVersion('2.0.27')).toBe(true)
    expect(isSupportedEngineVersion('2.1.0')).toBe(true)
    expect(isSupportedEngineVersion('2.0.19')).toBe(false)
    expect(isSupportedEngineVersion('1.18.32')).toBe(false)
    expect(isSupportedEngineVersion('3.0.0')).toBe(false)
    expect(isSupportedEngineVersion('')).toBe(false)
    expect(isSupportedEngineVersion('opencode v2.0.27')).toBe(true)
  })

  it('版本归一化能吃 `opencode v2.0.27` / `v2.0.27` / 裸版本号', () => {
    expect(normalizeEngineVersion('opencode v2.0.27')).toBe('2.0.27')
    expect(normalizeEngineVersion('v2.0.27')).toBe('2.0.27')
    expect(normalizeEngineVersion('2.0.27')).toBe('2.0.27')
    expect(normalizeEngineVersion('(no output)')).toBe('')
  })

  it('探针命令只看候选绝对路径，不靠 PATH', () => {
    const cmd = buildEngineProbeCommand()
    for (const candidate of DEFAULT_ENGINE_CANDIDATES) {
      // $HOME 必须留给对端 shell 展开（只引住其余部分）
      const rendered = candidate.startsWith('$HOME/') ? `"$HOME"'${candidate.slice('$HOME'.length)}'` : `'${candidate}'`
      expect(cmd).toContain(rendered)
    }
    expect(cmd).toContain('[ -x "$c" ]')
    expect(cmd).toContain('--version 2>/dev/null | head -1')
    // 命令里除了那些候选路径，不许再出现裸的 opencode（PATH 上那个 v1 就是这么混进来的）
    let rest = cmd
    for (const candidate of DEFAULT_ENGINE_CANDIDATES) {
      const rendered = candidate.startsWith('$HOME/') ? `"$HOME"'${candidate.slice('$HOME'.length)}'` : `'${candidate}'`
      rest = rest.replaceAll(rendered, '')
    }
    expect(rest.includes('opencode')).toBe(false)
  })

  it('候选路径的引法：$HOME 展开、其余部分不可被 shell 重读、用户 pin 原样', () => {
    expect(quoteRemotePath('$HOME/.local/bin/opencode')).toBe(`"$HOME"'/.local/bin/opencode'`)
    expect(quoteRemotePath('~/bin/x')).toBe(`"$HOME"'/bin/x'`)
    expect(quoteRemotePath('~')).toBe('"$HOME"')
    expect(quoteRemotePath('/opt/x/opencode')).toBe(`'/opt/x/opencode'`)
    // 用户 pin 里的元字符不得穿越到远端 shell
    expect(quoteRemotePath('/tmp/a;rm -rf b')).toBe(`'/tmp/a;rm -rf b'`)
    expect(quoteRemotePath("/tmp/it's")).toBe(`'/tmp/it'\\''s'`)
    // 真 bug 回归：单引住整个 $HOME 路径 → 对端测的是字面量路径，
    // 结果「机器上明明有 v1」却报「一个引擎都没有」。
    const cmd = buildEngineProbeCommand(['$HOME/.local/bin/opencode'])
    expect(cmd).not.toContain(`'$HOME/.local/bin/opencode'`)
  })

  it('探针输出解析：path<TAB>version，容忍 CRLF 与空版本', () => {
    const stdout = [
      '/home/demo/.ocrc/remote/engine/opencode\topencode v2.0.27',
      '/home/demo/.opencode/bin/opencode\t',
      '',
      'garbage-without-tab',
      '/usr/bin/opencode\t1.18.32\r',
    ].join('\n')
    const parsed = parseEngineProbe(stdout)
    expect(parsed.map((c) => [c.path, c.version])).toEqual([
      ['/home/demo/.ocrc/remote/engine/opencode', '2.0.27'],
      ['/home/demo/.opencode/bin/opencode', ''],
      ['/usr/bin/opencode', '1.18.32'],
    ])
  })

  it('EL7 的真实形态：v1 与 v2 并存时选 v2（与顺序无关）', () => {
    const v1 = { path: '/home/demo/.local/bin/opencode', version: '1.18.32', raw: '1.18.32' }
    const v2 = { path: '/home/demo/.ocrc-accept/package/bin/opencode', version: '2.0.27', raw: 'opencode v2.0.27' }
    expect(pickV2Engine([v1, v2])).toEqual({ ok: true, candidate: v2 })
    expect(pickV2Engine([v2, v1])).toEqual({ ok: true, candidate: v2 })
  })

  it('只有 v1 时是硬拒绝，并把版本与路径都摆出来（不许静默回落）', () => {
    const pick = pickV2Engine([{ path: '/home/demo/.local/bin/opencode', version: '1.18.32', raw: '1.18.32' }])
    expect(pick.ok).toBe(false)
    if (!pick.ok) {
      expect(pick.error).toContain(`≥ ${MIN_ENGINE_VERSION}`)
      expect(pick.error).toContain('/home/demo/.local/bin/opencode')
      expect(pick.error).toContain('1.18.32')
    }
  })

  it('一个都没有时指向「部署引擎」而不是报个空错', () => {
    const pick = pickV2Engine([])
    expect(pick.ok).toBe(false)
    if (!pick.ok) expect(pick.error).toContain('检查并安装')
  })
})

describe('落点与安装脚本（我们的命名空间，绝不碰用户既有安装）', () => {
  it('路径全部钉死且落在 ~/.ocrc/remote 下', () => {
    const p = instancePaths('2.3.3')
    expect(p.root).toBe('$HOME/.ocrc/remote')
    expect(p.node).toBe(`$HOME/.ocrc/remote/runtime/node-v${NODE_RUNTIME.version}/bin/node`)
    expect(p.cli).toBe('$HOME/.ocrc/remote/openchamber/2.3.3/lib/node_modules/@openchamber/web/bin/cli.js')
    // 绝不指向 .opencode/bin 或 .local/bin 这些用户目录
    expect(p.node.startsWith('$HOME/.ocrc/remote/')).toBe(true)
    expect(p.cli.startsWith('$HOME/.ocrc/remote/')).toBe(true)
  })

  it('运行时与应用都走「控制端预备 + 推送」，对端脚本里没有取件与装包', async () => {
    // P1 的 `curl … | sha256sum -c` 与 `npm -g --prefix …` 已由 P2 取代：
    // 对端无出网（R6），所以远程脚本必须零联网命令。清单即真相。
    const { offlineScriptInventory, assertOfflineSafe } = await import('../../src/core/remote-instance-push.js')
    const inventory = offlineScriptInventory('2.3.3')
    expect(inventory.map((i) => i.what)).toEqual(['runtime-probe', 'app-probe', 'engine-probe', 'runtime-push', 'engine-push', 'app-push'])
    for (const { what, script } of inventory) expect(() => assertOfflineSafe(script, what)).not.toThrow()
  })
})

describe('启动/停止脚本与 R9 代理注入', () => {
  const base = {
    appVersion: '2.3.3',
    port: 2610,
    enginePath: '/home/demo/.ocrc/remote/engine/opencode',
    uiPassword: 'pw',
  }

  it('引擎与运行时都是绝对路径（R12：不靠 PATH 解析）', () => {
    const line = buildInstanceServeCommand(base)
    expect(line).toContain("OPENCODE_BINARY='/home/demo/.ocrc/remote/engine/opencode'")
    expect(line).toContain(`$HOME/.ocrc/remote/runtime/node-v${NODE_RUNTIME.version}/bin/node`)
    expect(line).toContain('serve --hostname 127.0.0.1 --port 2610')
    // 没有 `export PATH=` 这种把 PATH 上 v1 放进来的做法
    expect(line).not.toContain('export PATH=')
  })

  it('配了代理就注入 HTTPS_PROXY，且 NO_PROXY 永远带上 127.0.0.1/localhost（隧道流量不被劫持）', () => {
    const line = buildInstanceServeCommand({ ...base, proxy: { httpsProxy: 'http://127.0.0.1:7890', noProxy: '10.0.0.0/8' } })
    expect(line).toContain("HTTPS_PROXY='http://127.0.0.1:7890'")
    expect(line).toContain("NO_PROXY='10.0.0.0/8,127.0.0.1,localhost'")
    // 没配 CA 就不出现
    expect(line).not.toContain('NODE_EXTRA_CA_CERTS')

    const withCa = buildInstanceServeCommand({ ...base, proxy: { httpsProxy: 'http://127.0.0.1:7890', caPath: '/home/demo/.ocrc/ca.pem' } })
    expect(withCa).toContain("NODE_EXTRA_CA_CERTS='/home/demo/.ocrc/ca.pem'")
  })

  it('没配代理就一个字都不注入', () => {
    const line = buildInstanceServeCommand(base)
    expect(line).not.toContain('HTTP_PROXY')
    expect(line).not.toContain('NO_PROXY')
    expect(line).not.toContain('NODE_EXTRA_CA_CERTS')
  })

  it('R9 的离线前提：默认关掉对上游 relay 的外联', () => {
    expect(buildInstanceServeCommand(base)).toContain("OPENCHAMBER_RELAY_HOST='off'")
  })

  it('detached 形态写日志并后台化（面板/CLI 用）', () => {
    const line = buildInstanceServeCommand({ ...base, detached: true })
    expect(line).toContain('nohup sh -c')
    // stdin 也要脱开：否则后台进程会攥着 ssh 通道不放，ssh 不返回
    expect(line).toContain('>> $HOME/.ocrc/remote/instance.log 2>&1 < /dev/null &')
  })

  it('停止/状态都走它自己的 CLI，且容忍「本来就没跑」', () => {
    expect(buildInstanceStopCommand('2.3.3', 2610)).toContain('stop --port 2610')
    expect(buildInstanceStopCommand('2.3.3', 2610)).toContain('|| true')
    expect(buildInstanceStatusCommand('2.3.3', 2610)).toContain('status --port 2610 --json')
  })
})

describe('控制端转发与实例探活', () => {
  it('转发就是一条 -N -L（+ R9 的 -R）：失败要响、掉线要能发现', () => {
    const args = buildForwardArgs({ host: '192.168.26.101', user: 'demo', port: 22, localPort: 4610, remotePort: 2610 })
    expect(args).toContain('-N')
    expect(args.join(' ')).toContain('-L 127.0.0.1:4610:127.0.0.1:2610')
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args[args.length - 1]).toBe('demo@192.168.26.101')
    // 本地端口默认 4096 是用户既有隧道——转发必须能换端口
    expect(buildForwardArgs({ host: 'h', port: 22, localPort: 4610, remotePort: 2610 })).toContain('127.0.0.1:4610:127.0.0.1:2610')
  })

  it('R9：出网反向转发挂同一条 ssh（-R 对端 loopback → 控制端中继）', () => {
    const withRelay = buildForwardArgs({
      host: 'h', port: 22, localPort: 4610, remotePort: 2610,
      reverse: { remotePort: 2711, localPort: 4711 },
    })
    expect(withRelay.join(' ')).toContain('-R 127.0.0.1:2711:127.0.0.1:4711')
    // 一条连接两个方向：掉线时 UI 与出网一起失效、一起重连，监督只盯一处
    expect(withRelay.join(' ')).toContain('-L 127.0.0.1:4610:127.0.0.1:2610')
    expect(withRelay.filter((a) => a === '-N')).toHaveLength(1)
    // 关掉代理时不许留 -R
    const noRelay = buildForwardArgs({ host: 'h', port: 22, localPort: 4610, remotePort: 2610 })
    expect(noRelay.some((a) => a === '-R')).toBe(false)
  })

  it('/api/version 的判定与上游同款：缺 api.runtime-url.v1 或 major<2 都拒', () => {
    const ok = judgeInstanceVersion({
      status: 'ok',
      openchamberVersion: '2.3.3',
      compatibility: { apiVersion: 1, minClientApiVersion: 1, capabilities: ['api.health.v1', 'api.runtime-url.v1'] },
      serverId: 'abc',
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.version).toBe('2.3.3')

    const noCap = judgeInstanceVersion({ status: 'ok', openchamberVersion: '2.3.3', compatibility: { capabilities: ['api.health.v1'] } })
    expect(noCap.ok).toBe(false)
    if (!noCap.ok) expect(noCap.error).toContain('api.runtime-url.v1')

    const old = judgeInstanceVersion({ status: 'ok', openchamberVersion: '1.9.0', compatibility: { capabilities: ['api.runtime-url.v1'] } })
    expect(old.ok).toBe(false)

    const wrong = judgeInstanceVersion({ status: 'ok', message: 'nope' } as never)
    expect(wrong.ok).toBe(false)
    expect(judgeInstanceVersion(undefined).ok).toBe(false)
  })

  it('重连三级默认值：重连/自恢复开，排队补发关（Q15）', () => {
    expect(RECONNECT_DEFAULTS).toEqual({ reconnect: true, restoreOnStart: true, replayQueued: false })
  })

  it('引擎兼容性判定（R12 ③）：实例自报的 binary+version 才是证据', () => {
    const ok = judgeEngineCompat({ state: 'compatible', version: '2.0.27', binary: '/home/demo/.ocrc/remote/engine/opencode' })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.version).toBe('2.0.27')
      expect(ok.binary).toBe('/home/demo/.ocrc/remote/engine/opencode')
    }
    // 复用到 leftover 实例时，引擎在别处也算数——只要它真的过门禁
    const adopted = judgeEngineCompat({ state: 'compatible', version: '2.0.27', binary: '/home/demo/.ocrc-accept/package/bin/opencode' })
    expect(adopted.ok).toBe(true)

    const v1 = judgeEngineCompat({ state: 'compatible', version: '1.18.32', binary: '/home/demo/.local/bin/opencode' })
    expect(v1.ok).toBe(false)
    if (!v1.ok) expect(v1.error).toContain('1.18.32')

    const bad = judgeEngineCompat({ state: 'not-installed', version: '2.0.27', binary: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('state=not-installed')

    // 相对路径 = 靠 PATH 解析，R12 不许
    const rel = judgeEngineCompat({ state: 'compatible', version: '2.0.27', binary: 'opencode' })
    expect(rel.ok).toBe(false)
    if (!rel.ok) expect(rel.error).toContain('绝对路径')
    expect(judgeEngineCompat(undefined).ok).toBe(false)
  })

  it('export 渲染是确定序、丢空值、单引号安全', () => {
    expect(renderExports({ B: '2', A: '1', C: undefined, D: '' })).toBe("export A='1' B='2'; ")
    expect(renderExports({ X: "it's" })).toBe("export X='it'\\''s'; ")
    expect(renderExports({})).toBe('')
  })

  it('一次性 ssh 执行：无 -N、无转发，命令原样作为单个 argv 传出', () => {
    const args = buildSshExecArgs({ host: '10.0.0.9', port: 2222, user: 'demo' }, 'echo "hi there"')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
    expect(args).not.toContain('-N')
    expect(args.some((a) => a.startsWith('-L'))).toBe(false)
    expect(args).toContain('demo@10.0.0.9')
    // 命令是最后一个 argv：调用方不经过任何本地 shell，注入面只剩远端自己的 shell
    expect(args[args.length - 1]).toBe('echo "hi there"')
    expect(buildSshExecArgs({ host: 'h' }, 'true')[buildSshExecArgs({ host: 'h' }, 'true').length - 1]).toBe('true')
    expect(buildSshExecArgs({ host: 'h' }, 'true')).toContain('22')
  })

  it('终端探测（P6）：直连 .node 取真错，并把可用性如实转成一句人能读的话', () => {
    const cmd = buildTerminalProbeCommand('2.3.3')
    // 直接 require 那个 .node，并按平台/架构拼路径（node-pty 加载器那句
    // "Cannot find module ./prebuilds/linux-x64/pty.node" 是误导信息——
    // 文件就在那儿，真错是 dlopen 时的 GLIBC/GLIBCXX 版本不符）
    expect(cmd).toContain("process.platform+'-'+process.arch+'/pty.node'")
    expect(cmd).toContain('node-pty')
    // $HOME 必须留给远端展开（单引住整条路径 = 测一个不存在的字面量）
    expect(cmd).toContain(`"$HOME"'/.ocrc/remote/openchamber/2.3.3/lib/node_modules/@openchamber/web/node_modules/node-pty'`)
    expect(cmd).not.toContain("'$HOME/.ocrc/remote")
    expect(cmd).toContain("console.log('terminal-ok')")
    expect(cmd).toContain('terminal-unavailable: ')
    expect(cmd).toContain('运行时不在位')

    expect(parseTerminalProbe('terminal-ok\n')).toEqual({ ok: true })
    expect(parseTerminalProbe('')).toEqual({ ok: false, reason: '（无输出）' })
    const bad = parseTerminalProbe('terminal-unavailable: /lib64/libc.so.6: version `GLIBC_2.28\' not found\n')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('GLIBC_2.28')
    // 别的输出（比如 node 自己的报错）也当成不可用，原话带出来
    const noise = parseTerminalProbe('some other failure\n')
    expect(noise.ok).toBe(false)
    if (!noise.ok) expect(noise.reason).toBe('some other failure')
  })
})
