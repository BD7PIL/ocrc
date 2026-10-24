import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_CLI_REL, DEFAULT_ENGINE_PIN, NODE_RUNTIME, instancePaths } from '../../src/core/remote-instance.js'
import {
  APP_PACKAGE,
  appCacheDir,
  appPayloadPath,
  appTreeDir,
  assertOfflineSafe,
  buildAppProbeCommand,
  buildAppPushScript,
  buildCrossInstallInvocation,
  buildDeployedEngineProbeCommand,
  buildEnginePushScript,
  buildOfflineGuardExports,
  buildPackInvocation,
  buildRuntimeProbeCommand,
  buildWindowsCommandLine,
  buildRuntimePushScript,
  engineBinaryPath,
  engineCacheDir,
  findAppPackageDir,
  findEgressCommands,
  findOutboundConnects,
  normalizeTreeLayout,
  npmBinary,
  offlineScriptInventory,
  parseShasumsLine,
  resolveEnginePin,
  runtimeCacheDir,
  runtimePayloadPath,
  sha512Base64,
  sha512Hex,
  wrapForTrace,
} from '../../src/core/remote-instance-push.js'

/**
 * P2：对端没有公网（R6），所以「能离线装」必须是被断言的性质，而不是祈祷：
 *   · 送出去的每一行远程脚本都不许出现联网命令（`assertOfflineSafe`）；
 *   · 落位必须原子且不静默覆盖（`.ocrc-bak` + 同盘 mv）；
 *   · 控制端交叉装的树要归一到 Linux 前缀形状，否则对端路径随控制端平台漂。
 */

describe('控制端交叉装树（npm 平台选择 + 归一）', () => {
  it('npm 二进制按平台取名（Windows 是 npm.cmd，免 shell 往返）', () => {
    expect(npmBinary('win32')).toBe('npm.cmd')
    expect(npmBinary('linux')).toBe('npm')
    expect(npmBinary('darwin')).toBe('npm')
  })

  it('交叉安装显式选 linux-x64/glibc，并 pin 版本', () => {
    const inv = buildCrossInstallInvocation('2.3.3', '/cache/tree', 'linux')
    expect(inv.cmd).toBe('npm')
    expect(inv.args).toEqual([
      'install', '-g', '--prefix', '/cache/tree',
      '--os=linux', '--cpu=x64', '--libc=glibc',
      '--no-audit', '--no-fund', '--loglevel=error',
      `${APP_PACKAGE}@2.3.3`,
    ])
    // 不许出现 `latest`/裸包名这类「跟随上游」的写法
    expect(inv.args.join(' ')).not.toContain(`${APP_PACKAGE} `)
    expect(inv.args.join(' ')).not.toMatch(/@latest\b/)
    // npm.cmd 只能靠 shell 起（直接 spawn 一个 .cmd 在 Windows 上是 EINVAL）
    expect(inv.needsShell).toBe(false)
    expect(buildCrossInstallInvocation('2.3.3', 'C:\\cache\\tree', 'win32').needsShell).toBe(true)
    expect(buildPackInvocation('tree', 'x.tgz').needsShell).toBe(false)
  })

  it('Windows 命令行只给「可能带空格」的参数加引号', () => {
    expect(buildWindowsCommandLine('npm.cmd', ['install', '-g', '--prefix', 'C:\\a b\\tree', '@openchamber/web@2.3.3']))
      .toBe('npm.cmd install -g --prefix "C:\\a b\\tree" @openchamber/web@2.3.3')
    expect(buildWindowsCommandLine('npm.cmd', ['install', '--prefix', 'C:\\plain\\tree']))
      .toBe('npm.cmd install --prefix C:\\plain\\tree')
    // 元字符不穿越到 cmd
    expect(buildWindowsCommandLine('npm.cmd', ['a&del x'])).toContain('"a&del x"')
  })

  it('打包把前缀内容放在包根（相对名 + cwd，避开 GNU tar 的 C: 主机解析）', () => {
    const inv = buildPackInvocation('tree', 'app-2.3.3.tar.gz')
    expect(inv.cmd).toBe('tar')
    expect(inv.args).toEqual(['-czf', 'app-2.3.3.tar.gz', '-C', 'tree', '.'])
  })

  it('Windows 布局（<prefix>/node_modules）被归一到 lib/node_modules，shim 清掉', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocrc-push-'))
    try {
      const tree = join(root, 'tree')
      const app = join(tree, 'node_modules', '@openchamber', 'web')
      mkdirSync(join(app, 'bin'), { recursive: true })
      mkdirSync(join(app, 'node_modules', 'dep'), { recursive: true })
      writeFileSync(join(app, 'package.json'), '{"name":"@openchamber/web","version":"2.3.3"}')
      writeFileSync(join(app, 'bin', 'cli.js'), '// cli')
      writeFileSync(join(tree, 'openchamber.cmd'), '@echo off')
      writeFileSync(join(tree, 'openchamber'), '#!/bin/sh')
      writeFileSync(join(tree, 'openchamber.ps1'), '# ps')

      const r = normalizeTreeLayout(tree)
      expect(r.moved).toBe(true)
      expect(r.appPackageDir).toBe(join(tree, 'lib', 'node_modules', '@openchamber', 'web'))
      // 依赖在包内一起搬家，Node 从 cli.js 向上找得到 lib/node_modules
      expect(findAppPackageDir(tree)).toBe(join(tree, 'lib', 'node_modules', '@openchamber', 'web'))
      expect(findAppPackageDir(tree)!.startsWith(join(tree, 'lib'))).toBe(true)
      // 幂等：已经归一过就再不动手
      expect(normalizeTreeLayout(tree).moved).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('树里没有 app 包时如实报错，而不是打出一个空包', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocrc-push-'))
    try {
      expect(() => normalizeTreeLayout(root)).toThrow(/app package not found/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缓存落在 OCRC_HOME 的 bin-cache 下（与既有取件约定同一棵树）', () => {
    const norm = (p: string) => p.replaceAll('\\', '/')
    expect(norm(appCacheDir('2.3.3'))).toMatch(/bin-cache\/remote-app\/2\.3\.3$/)
    expect(norm(appTreeDir('2.3.3'))).toMatch(/bin-cache\/remote-app\/2\.3\.3\/tree$/)
    expect(norm(appPayloadPath('2.3.3'))).toMatch(/bin-cache\/remote-app\/2\.3\.3\/app-2\.3\.3\.tar\.gz$/)
    expect(norm(runtimeCacheDir())).toMatch(new RegExp(`bin-cache/remote-runtime/${NODE_RUNTIME.version}$`))
    expect(norm(runtimePayloadPath())).toMatch(new RegExp(`${NODE_RUNTIME.tarball}$`))
  })
})

describe('SHASUMS256 解析（官方清单格式）', () => {
  const text = [
    '41753a26a2a2b9cabbfae4bc9d7d0f1b9a4d4e6a3b4b74df2f0a1a0d2b1c0e5f  node-v24.22.0-linux-x64.tar.xz',
    '',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *node-v24.22.0-linux-x64-glibc-217.tar.xz',
    '# comment line',
  ].join('\n')

  it('普通行与 `*`（二进制）行都认', () => {
    expect(parseShasumsLine(text, 'node-v24.22.0-linux-x64.tar.xz')).toBe('41753a26a2a2b9cabbfae4bc9d7d0f1b9a4d4e6a3b4b74df2f0a1a0d2b1c0e5f')
    expect(parseShasumsLine(text, 'node-v24.22.0-linux-x64-glibc-217.tar.xz')).toBe('a'.repeat(64))
  })

  it('没有的条目返回 undefined（不许用兜底哈希糊过去）', () => {
    expect(parseShasumsLine(text, 'node-v24.22.0-linux-arm64.tar.xz')).toBeUndefined()
    expect(parseShasumsLine('', NODE_RUNTIME.tarball)).toBeUndefined()
  })
})

describe('远程脚本：零联网 + 原子落位', () => {
  it('运行时脚本只吃 stdin：校验 sha256 → 解包 → 短名改名 → 验版本', () => {
    const sha = 'b'.repeat(64)
    const s = buildRuntimePushScript(sha)
    expect(s).toContain('set -e')
    expect(s).toContain('cat > "$S/payload.tar.xz"')
    expect(s).toContain(`printf '%s  %s\\n' '${sha}' "$S/payload.tar.xz" | sha256sum -c -`)
    expect(s).toContain('sha256 mismatch')
    expect(s).toContain(`tar xf "$S/payload.tar.xz"`)
    expect(s).toContain(`mv ${NODE_RUNTIME.unpackedDir} node-v${NODE_RUNTIME.version}`)
    expect(s).toContain(`${instancePaths('x').node} --version`)
    // 暂存目录必须和目标同盘（$HOME/.ocrc/remote 下），否则 mv 不是原子重命名
    expect(s).toContain('$R/.staging/runtime-node-')
    expect(sha).toHaveLength(64)
  })

  it('推给远端 `-c` 的摘要必须是 hex（真 bug 回归：给 base64 会让完好载荷校验失败）', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocrc-push-'))
    try {
      const f = join(root, 'payload.bin')
      writeFileSync(f, 'x'.repeat(1000))
      const b64 = sha512Base64(f)
      const hex = sha512Hex(f)
      expect(hex).toMatch(/^[0-9a-f]{128}$/)
      expect(b64).toMatch(/^[A-Za-z0-9+/]{86}==$/)
      expect(hex).not.toBe(b64)
      // 远端脚本里的校验行只接受 hex——把 base64 塞进去，字节再对也过不了
      const script = buildAppPushScript('2.3.3', hex)
      expect(script).toContain(hex)
      expect(script).not.toContain(b64)
      expect(findEgressCommands(script)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('应用脚本：先验 sha 与包形，再换前缀（旧树 → .ocrc-bak）', () => {
    const s = buildAppPushScript('2.3.3', 'a'.repeat(128))
    expect(s).toContain('cat > "$S/payload.tar.gz"')
    expect(s).toContain(`printf '%s  %s\\n' '${'a'.repeat(128)}' "$S/payload.tar.gz" | sha512sum -c -`)
    expect(s).toContain('sha512 mismatch')
    // 形状检查必须在动既有前缀之前——坏包不该以毁掉可用安装为代价
    const shape = s.indexOf('payload shape unexpected')
    const backup = s.indexOf('.ocrc-bak')
    expect(shape).toBeGreaterThan(-1)
    expect(backup).toBeGreaterThan(shape)
    expect(s).toContain(`rm -rf "$P.ocrc-bak"; mv "$P" "$P.ocrc-bak"`)
    expect(s).toContain('mv "$S/unpacked" "$P"')
    // 验证用的是我们推的运行时 + 钉死的 cli.js 绝对路径
    expect(s).toContain(`"$N" "$P/${APP_CLI_REL}" --version`)
  })

  it('应用脚本没有运行时就直接拒绝（不许悄悄落到系统 node 上）', () => {
    const s = buildAppPushScript('2.3.3', 'x')
    expect(s).toContain('if [ ! -x "$N" ]')
    expect(s).toContain('exit 6')
  })

  it('cli.js 相对路径是唯一事实来源（推送落点 = 后续启动用的路径）', () => {
    expect(instancePaths('2.3.3').cli).toBe(`$HOME/.ocrc/remote/openchamber/2.3.3/${APP_CLI_REL}`)
    expect(buildAppPushScript('2.3.3', 'x')).toContain(APP_CLI_REL)
  })

  it('探针缺件时报 MISSING（不是错误码），调用方据此决定推不推', () => {
    expect(buildRuntimeProbeCommand()).toBe('if [ -x $HOME/.ocrc/remote/runtime/node-v24.22.0/bin/node ]; then $HOME/.ocrc/remote/runtime/node-v24.22.0/bin/node --version; else echo MISSING; fi')
    expect(buildAppProbeCommand('2.3.3')).toContain('else echo MISSING; fi')
    expect(buildDeployedEngineProbeCommand()).toBe('if [ -x $HOME/.ocrc/remote/engine/opencode ]; then $HOME/.ocrc/remote/engine/opencode --version; else echo MISSING; fi')
  })
})

describe('引擎推送（R12：pin 死、落在我们命名空间、绝不碰用户的 ~/.local/bin）', () => {
  it('pin 优先级：显式 > manifest/OCRC_V2_PIN > 声明默认；永远不是 latest（upgrade 语境里整条链只是渠道发现之下的兜底）', () => {
    expect(resolveEnginePin('2.0.30')).toBe('2.0.30')
    expect(resolveEnginePin()).toBe(DEFAULT_ENGINE_PIN)
    expect(DEFAULT_ENGINE_PIN).toMatch(/^2\./)
    expect(DEFAULT_ENGINE_PIN).not.toBe('latest')
  })

  it('引擎缓存按 pin+target 分目录（同一台机器可以并存两个 pin）', () => {
    const norm = (p: string) => p.replaceAll('\\', '/')
    expect(norm(engineBinaryPath('2.0.27'))).toMatch(/bin-cache\/remote-engine\/2\.0\.27-linux-x64\/package\/bin\/opencode$/)
    expect(engineCacheDir('2.0.27')).not.toBe(engineCacheDir('2.0.30'))
  })

  it('落点是 ~/.ocrc/remote/engine/opencode，且版本门禁在换掉在用引擎之前跑', () => {
    const s = buildEnginePushScript('2.0.27', 'd'.repeat(64))
    expect(s).toContain('E="$HOME/.ocrc/remote/engine/opencode"')
    expect(s).not.toContain('.local/bin')
    expect(s).toContain(`printf '%s  %s\\n' '${'d'.repeat(64)}' "$S/opencode" | sha256sum -c -`)
    const gate = s.indexOf('engine version gate failed')
    const backup = s.indexOf('$E.ocrc-bak')
    const swap = s.indexOf('mv "$S/opencode" "$E"')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(backup)
    expect(backup).toBeLessThan(swap)
    expect(s).toContain('chmod 755')
  })

  it('引擎推送脚本也是零联网的（对端装引擎不走 curl | bash）', () => {
    expect(findEgressCommands(buildEnginePushScript('2.0.27', 'e'.repeat(64)))).toEqual([])
  })
})

describe('离线性是被断言的性质，不是祈祷', () => {
  it('结构性断言能抓住每一种出网写法', () => {
    expect(findEgressCommands('curl -fsSL https://x | bash')).toContain('curl')
    expect(findEgressCommands('npm install -g foo')).toContain('npm')
    expect(findEgressCommands('wget https://x')).toContain('wget')
    expect(findEgressCommands('git clone https://git/x')).toContain('git')
    expect(findEgressCommands('npx something')).toContain('npx')
    expect(findEgressCommands('curl -fsSL https://opencode.ai/install | bash')).toContain('upstream installer')
    expect(findEgressCommands('tar xzf - -C "$D"')).toEqual([])
    expect(() => assertOfflineSafe('npm i', '测试')).toThrow(/联网命令.*npm/)
  })

  it('清单里的每个远程脚本都离线安全（新脚本进来会被这条测试拦住）', () => {
    const inventory = offlineScriptInventory('2.3.3')
    expect(inventory).toHaveLength(6)
    for (const { what, script } of inventory) {
      expect({ what, hits: findEgressCommands(script) }).toEqual({ what, hits: [] })
    }
  })

  it('毒代理前缀把 http/https 与 npm registry 指向死端口，但回环留在 NO_PROXY 里', () => {
    const g = buildOfflineGuardExports()
    expect(g).toContain(`http_proxy='http://127.0.0.1:1'`)
    expect(g).toContain(`HTTPS_PROXY='http://127.0.0.1:1'`)
    expect(g).toContain(`npm_config_registry='http://127.0.0.1:1/'`)
    // 回环必须免代理：实例要和自己的引擎在本机 127.0.0.1 上说话，
    // 代理把这段也吞掉就是把被测对象自己弄坏了（与 buildProxyExports 同规）。
    expect(g).toContain(`no_proxy='127.0.0.1,localhost'`)
    expect(g).toContain(`NO_PROXY='127.0.0.1,localhost'`)
    expect(buildOfflineGuardExports(9999)).toContain(`https_proxy='http://127.0.0.1:9999'`)
  })

  it('trace 包装把脚本变成文件执行并 base64 传输（stdin 留给载荷）', () => {
    const s = wrapForTrace("set -e\nprintf '%s\\n' 'x'\ncat > \"$S/p\"", '/tmp/t.strace')
    expect(s).toContain('base64 -d > "$HOME/.ocrc/remote/.staging/traced.sh"')
    expect(s).toContain("strace -f -e trace=connect -o '/tmp/t.strace' sh \"$HOME/.ocrc/remote/.staging/traced.sh\"")
    expect(s).toContain('exit $rc')
    // 原脚本不再原样出现（它被编码进 base64 了，引号不再可能被外层 shell 吃掉）
    expect(s).not.toContain("printf '%s\\n'")
  })

  it('只有非回环 connect() 才算外联（AF_UNIX/127.0.0.1/::1 都不算）', () => {
    const trace = [
      '1234  connect(3, {sa_family=AF_FILE, path="/var/run/nscd/socket"}, 110) = -1 ENOENT',
      '1234  connect(4, {sa_family=AF_INET, sin_port=htons(2610), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
      '1234  connect(5, {sa_family=AF_INET6, sin6_port=htons(443), sin6_addr=inet_pton(AF_INET6, "::1")}, 28) = 0',
      '1234  connect(6, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("140.82.121.4")}, 16) = 0',
      '1234  connect(7, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("10.1.2.3")}, 16) = -1 ENETUNREACH',
    ].join('\n')
    const out = findOutboundConnects(trace)
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('140.82.121.4')
    expect(out[1]).toContain('htons(53)')
  })
})
