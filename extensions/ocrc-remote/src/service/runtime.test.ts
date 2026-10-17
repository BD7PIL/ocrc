import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { RuntimeNeed } from '../shared/provision.js'
import { runtimeDirFor, runtimeRootFor } from '../shared/provision.js'
import {
  ENTRY_RESOLVER_SOURCE, LATEST_SLOT, buildRuntimeDiscoverScript, buildRuntimeInstallScript,
  buildRuntimePlan, buildRuntimeRemoveScript, decideRuntime, factsFromDetect, parseRuntimeDiscoverOutput,
  parseRuntimeInstallOutput, parseRuntimeMarker, runtimeSlot, runtimeSpec,
  type RuntimeFacts,
} from './runtime.js'

const NPM_NEED: RuntimeNeed = { raw: 'mcp-searxng', kind: 'npm', name: 'mcp-searxng' }
const PINNED: RuntimeNeed = { raw: '@playwright/mcp@next', kind: 'npm', name: '@playwright/mcp', version: 'next' }
const PATH_NEED: RuntimeNeed = { raw: '/usr/local/bin/foo', kind: 'path', name: '/usr/local/bin/foo' }

const HEALTHY: RuntimeFacts = { home: '/home/demo', node: 'v20.20.2', npm: '10.8.2', nodeOk: true, outbound: true }
const noDiscovery = new Map()

const temps: string[] = []
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('运行时落点约定', () => {
  it('版本 → 槽位名；没版本落 latest；不安全字符折成 _', () => {
    expect(runtimeSlot('1.2.3')).toBe('1.2.3')
    expect(runtimeSlot(undefined)).toBe(LATEST_SLOT)
    expect(runtimeSlot('next')).toBe('next')
    expect(runtimeSlot('^1.0.0')).toBe('_1.0.0')
    expect(runtimeSlot('..')).toBe(LATEST_SLOT)
    expect(runtimeSlot('   ')).toBe(LATEST_SLOT)
  })

  it('scoped 包名进目录时不留斜杠层级', () => {
    expect(runtimeDirFor('/home/demo', '@playwright/mcp', 'next')).toBe('/home/demo/.ocrc/runtime/playwright__mcp/next')
    expect(runtimeRootFor('/home/demo/')).toBe('/home/demo/.ocrc/runtime')
  })

  it('npm 规格：钉了版本就带上去', () => {
    expect(runtimeSpec(NPM_NEED)).toBe('mcp-searxng')
    expect(runtimeSpec({ ...PINNED, version: '1.2.3' })).toBe('@playwright/mcp@1.2.3')
  })
})

describe('planRuntime 的决策——每一种「装不了」都有自己的理由', () => {
  const decide = (need: RuntimeNeed, facts = HEALTHY, discovery = noDiscovery, neededBy = ['mcp:x']) =>
    decideRuntime(need, facts, discovery.get(need.raw), neededBy)

  it('PATH 里已经有命令 → 用它，不另装一份', () => {
    const d = new Map([[NPM_NEED.raw, { raw: NPM_NEED.raw, inPath: '/usr/local/bin/mcp-searxng' }]])
    const item = decide(NPM_NEED, HEALTHY, d)
    expect(item.action).toBe('present')
    expect(item.found?.path).toBe('/usr/local/bin/mcp-searxng')
    expect(item.reason).toContain('PATH 里已经有')
  })

  it('我们装过的槽位 → 已就位（入口与版本来自 marker）', () => {
    const d = new Map([[NPM_NEED.raw, { raw: NPM_NEED.raw, installed: { dir: '/home/demo/.ocrc/runtime/mcp-searxng/latest', entry: '/home/demo/.ocrc/runtime/mcp-searxng/latest/node_modules/.bin/mcp-searxng', version: '1.2.3' } }]])
    const item = decide(NPM_NEED, HEALTHY, d)
    expect(item.action).toBe('present')
    expect(item.found).toMatchObject({ version: '1.2.3' })
  })

  it('目录在但不是我们装的 → 不覆盖，如实报装不了', () => {
    const d = new Map([[NPM_NEED.raw, { raw: NPM_NEED.raw, unmanagedDir: '/home/demo/.ocrc/runtime/mcp-searxng/latest' }]])
    const item = decide(NPM_NEED, HEALTHY, d)
    expect(item.action).toBe('impossible')
    expect(item.reason).toContain('不是 ocrc 装的')
  })

  it('干净的目标机 → 待安装，落点是 .ocrc/runtime/<name>/latest', () => {
    const item = decide(NPM_NEED)
    expect(item.action).toBe('install')
    expect(item.package).toBe('mcp-searxng')
    expect(item.dir).toBe('/home/demo/.ocrc/runtime/mcp-searxng/latest')
    expect(item.entry).toBeUndefined()
  })

  it('钉了版本就落到那个槽位', () => {
    expect(decide(PINNED).dir).toBe('/home/demo/.ocrc/runtime/playwright__mcp/next')
  })

  it('没有 node / node 太老 / 没有 npm 是三种不同的理由', () => {
    expect(decide(NPM_NEED, { ...HEALTHY, node: undefined, nodeOk: false }).reason).toContain('没有 node')
    expect(decide(NPM_NEED, { ...HEALTHY, node: 'v18.20.4', nodeOk: false }).reason).toContain('v18.20.4 低于')
    expect(decide(NPM_NEED, { ...HEALTHY, npm: undefined }).reason).toContain('没有 npm')
  })

  it('目标机不出网 → 本轮如实报装不了（面板推送留到下一轮）', () => {
    const item = decide(NPM_NEED, { ...HEALTHY, outbound: false })
    expect(item.action).toBe('impossible')
    expect(item.reason).toContain('不出网')
  })

  it('绝对路径形态：在就说在，不在就说我们只装 npm 形态', () => {
    const present = decide(PATH_NEED, HEALTHY, new Map([[PATH_NEED.raw, { raw: PATH_NEED.raw, pathExists: true }]]))
    expect(present.action).toBe('present')
    expect(present.found?.path).toBe('/usr/local/bin/foo')

    const missing = decide(PATH_NEED)
    expect(missing.action).toBe('impossible')
    expect(missing.reason).toContain('只装 npm 形态')
  })

  it('计划带上判断依据（node/npm 现状）与根目录', () => {
    const plan = buildRuntimePlan([{ need: NPM_NEED, neededBy: ['mcp:searxng'] }], HEALTHY, noDiscovery)
    expect(plan.root).toBe('/home/demo/.ocrc/runtime')
    expect(plan.node).toBe('v20.20.2')
    expect(plan.npm).toBe('10.8.2')
    expect(plan.nodeOk).toBe(true)
    expect(plan.items[0].neededBy).toEqual(['mcp:searxng'])
  })

  it('factsFromDetect 只取与运行时有关的那几项', () => {
    expect(factsFromDetect({ reachable: true, node: 'v22.1.0', npm: '10.0.0', nodeOk: true, outbound: false }, '/home/demo'))
      .toEqual({ home: '/home/demo', node: 'v22.1.0', npm: '10.0.0', nodeOk: true, outbound: false })
    // 老 detect 报告（没有 nodeOk 字段）不能当成「够用」。
    expect(factsFromDetect({ reachable: true, node: 'v22.1.0' }, '/home/demo').nodeOk).toBe(false)
  })
})

describe('发现脚本与解析', () => {
  it('一条 ssh 问完所有需求，逐项 R<idx>_ 前缀', () => {
    const script = buildRuntimeDiscoverScript('/home/demo', [NPM_NEED, PATH_NEED])
    expect(script).toContain('ROOT=\'/home/demo/.ocrc/runtime\'')
    expect(script).toContain('command -v \'mcp-searxng\'')
    expect(script).toContain('echo "R0_KIND=in-path"')
    expect(script).toContain('echo "R0_KIND=installed"')
    expect(script).toContain('echo "R0_KIND=unmanaged"')
    expect(script).toContain('[ -x \'/usr/local/bin/foo\' ]')
    expect(script).toContain('echo "R1_KIND=path"')
    // 没钉版本时挑最新槽位；钉了就直接用那个槽位。
    expect(script).toContain('sort -V | tail -1')
    expect(buildRuntimeDiscoverScript('/home/demo', [PINNED])).toContain('S=\'next\'')
    expect(script.trim().endsWith('echo "RUNTIME_DISCOVER_DONE=1"')).toBe(true)
  })

  it('把 key=value 行读回现场（含 PATH 命中与坏 marker 的目录）', () => {
    const stdout = [
      'ROOT=/home/demo/.ocrc/runtime',
      'R0_KIND=in-path',
      'R0_INPATH=/usr/local/bin/mcp-searxng',
      'R1_KIND=installed',
      'R1_DIR=/home/demo/.ocrc/runtime/playwright__mcp/next',
      'R1_ENTRY=/home/demo/.ocrc/runtime/playwright__mcp/next/node_modules/.bin/mcp',
      'R1_VERSION=0.0.9',
      'R1_SPEC=@playwright/mcp@next',
      'RUNTIME_DISCOVER_DONE=1',
    ].join('\n')
    const parsed = parseRuntimeDiscoverOutput(stdout, [NPM_NEED, PINNED])
    expect(parsed.get(NPM_NEED.raw)?.inPath).toBe('/usr/local/bin/mcp-searxng')
    expect(parsed.get(PINNED.raw)?.installed).toEqual({
      dir: '/home/demo/.ocrc/runtime/playwright__mcp/next',
      entry: '/home/demo/.ocrc/runtime/playwright__mcp/next/node_modules/.bin/mcp',
      version: '0.0.9',
      spec: '@playwright/mcp@next',
    })
  })

  it('目标机什么都没说时不留半截结论', () => {
    const parsed = parseRuntimeDiscoverOutput('ROOT=/home/x/.ocrc/runtime\n', [NPM_NEED])
    expect(parsed.get(NPM_NEED.raw)).toEqual({ raw: NPM_NEED.raw })
  })

  it('marker 是 key=value，值里的空格不会被切开', () => {
    const marker = parseRuntimeMarker('SPEC=mcp-searxng\nENTRY=/home/John Doe/.ocrc/runtime/x/latest/node_modules/.bin/x\n')
    expect(marker.ENTRY).toBe('/home/John Doe/.ocrc/runtime/x/latest/node_modules/.bin/x')
  })
})

describe('安装脚本', () => {
  it('幂等短路、npm 参数、入口解析、marker 写入都在脚本里', () => {
    const script = buildRuntimeInstallScript({ home: '/home/demo', need: NPM_NEED })
    expect(script).toContain("D='/home/demo/.ocrc/runtime/mcp-searxng/latest'")
    expect(script).toContain('if ! command -v npm >/dev/null 2>&1; then echo "OCRC_ERR=no-npm"')
    // 参数写在命令行上（`--prefix "$D"` 是真引用，不是字面量引号）——`$D` 带空格也不会被拆开。
    expect(script).toContain('if ! npm install --prefix "$D" --no-save --no-package-lock --no-audit --no-fund --loglevel=error "$SPEC"')
    expect(script).toContain('echo "OCRC_SKIPPED=1"')
    expect(script).toContain('node "$HELPER" "$D" "$PKG"')
    expect(script).toContain('fail_runtime no-bin')
    expect(script).toMatch(/cat > "\$D\/\.ocrc-marker\.tmp" <<OCRC_RUNTIME_MARKER/)
    expect(script).toContain('mv "$D/.ocrc-marker.tmp" "$M"')
    expect(script).toContain('echo "OCRC_ENTRY=$ENTRY"')
  })

  it('失败时不留半截目录：只删这次刚建出来的槽位，别人早有的目录一个字节都不动', () => {
    const script = buildRuntimeInstallScript({ home: '/home/demo', need: NPM_NEED })
    // 先记住「进来之前这个槽位在不在」——清理只针对自己新建的。
    expect(script).toContain('if [ -d "$D" ]; then PRE_EXISTING=1; else PRE_EXISTING=0; fi')
    expect(script).toContain('if [ "$PRE_EXISTING" = "0" ] && [ ! -f "$M" ]; then rm -rf "$D" && rmdir "$(dirname "$D")" 2>/dev/null; fi')
    // 旧 marker 还原：失败之后 marker 只反映真实装好的状态。
    expect(script).toContain('[ -f "$M.ocrc-bak" ] && [ ! -f "$M" ]; then mv "$M.ocrc-bak" "$M"')
    // 每一条失败都走同一个收尾（不留半截目录）。
    for (const code of ['root', 'dir', 'install', 'helper', 'no-bin', 'entry-missing', 'marker']) {
      expect(script.includes(`fail_runtime ${code}`) || (code === 'entry-missing' && script.includes('fail_runtime entry-missing'))).toBe(true)
    }
  })

  it('force 时不写幂等短路（用户主动要求重装）', () => {
    expect(buildRuntimeInstallScript({ home: '/home/demo', need: NPM_NEED, force: true })).not.toContain('OCRC_SKIPPED=1')
  })

  it('验收用 fixture registry 时只改 registry，不改别处', () => {
    const script = buildRuntimeInstallScript({ home: '/home/demo', need: NPM_NEED, registry: 'http://127.0.0.1:4599/' })
    expect(script).toContain('--registry \'http://127.0.0.1:4599/\'')
  })

  it('scoped 包名原样进 npm 规格，目录名不留斜杠', () => {
    const script = buildRuntimeInstallScript({ home: '/home/demo', need: PINNED })
    expect(script).toContain("D='/home/demo/.ocrc/runtime/playwright__mcp/next'")
    expect(script).toContain('SPEC=\'@playwright/mcp@next\'')
    expect(script).toContain('PKG=\'@playwright/mcp\'')
  })

  it('入口解析器写的是 .cjs（不被 type=module 影响）', () => {
    expect(buildRuntimeInstallScript({ home: '/home/demo', need: NPM_NEED })).toContain('.ocrc-entry-resolver.cjs')
  })
})

describe('安装结果解析', () => {
  it('成功：入口、版本、目录都带回来', () => {
    const outcome = parseRuntimeInstallOutput([
      'OCRC_OK=1',
      'OCRC_ENTRY=/home/demo/.ocrc/runtime/mcp-searxng/latest/node_modules/.bin/mcp-searxng',
      'OCRC_VERSION=1.2.3',
      'OCRC_DIR=/home/demo/.ocrc/runtime/mcp-searxng/latest',
      'OCRC_BACKUP=/home/demo/.ocrc/runtime/mcp-searxng/latest/.ocrc-runtime.ocrc-bak',
      'RUNTIME_DONE=1',
    ].join('\n'), 'mcp-searxng')
    expect(outcome).toMatchObject({ ok: true, skipped: false, version: '1.2.3' })
    expect(outcome.entry).toContain('node_modules/.bin/mcp-searxng')
    expect(outcome.backup).toContain('.ocrc-bak')
  })

  it('幂等短路是一次成功，但能看出来没写东西', () => {
    expect(parseRuntimeInstallOutput('OCRC_SKIPPED=1\nOCRC_ENTRY=/x\nRUNTIME_DONE=1', 'mcp-searxng')).toMatchObject({ ok: true, skipped: true })
  })

  it('每种错误码都有能照着做的人话', () => {
    expect(parseRuntimeInstallOutput('OCRC_ERR=no-npm', 'x').error).toContain('没有 npm')
    expect(parseRuntimeInstallOutput('OCRC_ERR=no-node', 'x').error).toContain('没有 node')
    expect(parseRuntimeInstallOutput('OCRC_ERR=no-bin', 'x').error).toContain('没有可执行入口')
    const npmFail = parseRuntimeInstallOutput('OCRC_ERR=install\nOCRC_GOT=npm error 404 Not Found', 'x')
    expect(npmFail.ok).toBe(false)
    expect(npmFail.error).toContain('npm 安装失败：npm error 404 Not Found')
    // 未知错误码也不能吞掉。
    expect(parseRuntimeInstallOutput('OCRC_ERR=weird', 'x').error).toContain('weird')
  })

  it('脚本一个字都没说 → 明说是没结果，不说装好了', () => {
    const outcome = parseRuntimeInstallOutput('', 'mcp-searxng')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('没有给出结果')
  })
})

describe('移除只动我们的槽位', () => {
  it('marker 在才删', () => {
    const script = buildRuntimeRemoveScript('/home/demo/.ocrc/runtime/mcp-searxng/latest')
    expect(script).toContain('[ -f "$D/.ocrc-runtime" ]')
    expect(script).toContain('rm -rf "$D"')
    expect(script).toContain('OCRC_REMOVED=0')
  })
})

describe('入口解析器（在真 node 上跑一遍）', () => {
  const run = (dir: string, pkg: string) => {
    const helper = join(dir, 'resolver.cjs')
    writeFileSync(helper, ENTRY_RESOLVER_SOURCE)
    return execFileSync(process.execPath, [helper, dir, pkg], { encoding: 'utf-8' })
  }

  it('对象形态的 bin：优先 .bin 垫片，并报出版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-rt-'))
    temps.push(dir)
    mkdirSync(join(dir, 'node_modules', 'mcp-searxng', 'dist'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'mcp-searxng', 'package.json'), JSON.stringify({
      name: 'mcp-searxng', version: '1.2.3', bin: { 'mcp-searxng': 'dist/index.js' },
    }))
    writeFileSync(join(dir, 'node_modules', '.bin', 'mcp-searxng'), '#!/bin/sh\n')
    const [entry, version] = run(dir, 'mcp-searxng').trim().split('\n')
    expect(entry).toBe(join(dir, 'node_modules', '.bin', 'mcp-searxng'))
    expect(version).toBe('OCRC_VERSION=1.2.3')
  })

  it('没有 .bin 垫片时退到包内的相对入口', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-rt-'))
    temps.push(dir)
    mkdirSync(join(dir, 'node_modules', 'pkg', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({ name: 'pkg', version: '0.1.0', bin: 'bin/run.js' }))
    expect(run(dir, 'pkg').trim().split('\n')[0]).toBe(join(dir, 'node_modules', 'pkg', 'bin', 'run.js'))
  })

  it('纯库（没有 bin）如实报 NO_BIN，不猜一个 index.js', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-rt-'))
    temps.push(dir)
    mkdirSync(join(dir, 'node_modules', 'libpkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'libpkg', 'package.json'), JSON.stringify({ name: 'libpkg', version: '2.0.0' }))
    expect(run(dir, 'libpkg').trim()).toBe('NO_BIN')
  })

  it('包没装上（package.json 读不到）也是 NO_BIN，不抛栈', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-rt-'))
    temps.push(dir)
    expect(run(dir, 'ghost').trim()).toBe('NO_BIN')
  })
})
