import { describe, expect, it } from 'vitest'
import {
  buildDetectScript, compareVersions, nodeMajorOk, normalizeVersion, parseDetectOutput, parseGlibc,
  resolveTarget, toDetectReport, toReadiness,
} from './detect.js'

/** 真机（V93000VM / RHEL 7.9）探测输出，逐字抄自批次 6 的取证。 */
const EL7_OUTPUT = [
  'OS=Red Hat Enterprise Linux Server 7.9 (Maipo)',
  'ONLY_OS=Linux',
  'KERNEL=3.10.0-1160.el7.x86_64',
  'MACHINE=x86_64',
  'GLIBC=ldd (GNU libc) 2.17',
  'HOME_DIR=/home/demo',
  'HOME_WRITABLE=yes',
  'HAS_SH=yes',
  'HAS_TAR=yes',
  'CONTAINER=none',
  'AVX2=yes',
  'NODE=v22.11.0',
  'NPM=10.9.0',
  'ENGINE_PATH=/home/demo/.opencode/bin/opencode',
  'ENGINE_VERSION=opencode v2.0.27',
  'LEGACY_PATH=/home/demo/.local/bin/opencode',
  'LEGACY_VERSION=1.18.34',
  'OUTBOUND=yes',
  'DETECT_DONE=1',
].join('\n')

describe('探测脚本', () => {
  it('一条 ssh 探完全部档位，且没有一条失败能吃掉整份报告', () => {
    const script = buildDetectScript()
    for (const key of ['OS=', 'GLIBC=', 'HOME_WRITABLE=', 'HAS_TAR=', 'CONTAINER=', 'AVX2=', 'ENGINE_PATH=', 'LEGACY_PATH=', 'OUTBOUND=', 'NPM=']) {
      expect(script).toContain(key)
    }
    // `set -e` 会让一条探测失败就吞掉后面所有输出——报告必须永远跑到底。
    expect(script).not.toContain('set -e')
    expect(script.trimEnd().endsWith('echo "DETECT_DONE=1"')).toBe(true)
    // 每条探测自带兜底，而不是靠全局容错。
    expect(script).toContain('|| echo unknown')
    expect(script).toContain('2>/dev/null')
  })

  it('键名允许数字——AVX2 是这条探测里最要紧的一项', () => {
    expect(parseDetectOutput('AVX2=no\n').AVX2).toBe('no')
  })
})

describe('parseDetectOutput', () => {
  it('按第一个 = 切分，保留带空格的值', () => {
    const fields = parseDetectOutput('OS=Red Hat Enterprise Linux Server 7.9 (Maipo)\nHOME_DIR=/home/demo\n')
    expect(fields.OS).toBe('Red Hat Enterprise Linux Server 7.9 (Maipo)')
    expect(fields.HOME_DIR).toBe('/home/demo')
  })

  it('忽略没有 = 的行与非大写键', () => {
    const fields = parseDetectOutput('login banner\nlower=case\n\nDETECT_DONE=1\n')
    expect(fields).toEqual({ DETECT_DONE: '1' })
  })

  it('容忍 CRLF（面板侧读到的远端输出可能带 \\r）', () => {
    expect(parseDetectOutput('OS=Linux\r\nDETECT_DONE=1\r\n').DETECT_DONE).toBe('1')
  })
})

describe('toDetectReport', () => {
  it('EL7 真机输出 → 平台 linux-x64、glibc 2.17、引擎在位、用户既有安装单独记', () => {
    const report = toDetectReport(EL7_OUTPUT)
    expect(report.reachable).toBe(true)
    expect(report.platform).toBe('linux-x64')
    expect(report.glibc).toBe('2.17')
    expect(report.baseline).toBe(false)
    expect(report.os).toContain('7.9')
    expect(report.container).toBe('none')
    expect(report.engine).toEqual({ path: '/home/demo/.opencode/bin/opencode', version: '2.0.27' })
    expect(report.legacyEngine).toEqual({ path: '/home/demo/.local/bin/opencode', version: '1.18.34' })
    expect(report.unsupportedReason).toBeUndefined()
  })

  it('无 AVX2 的 VM → 必须选 baseline 变体', () => {
    const report = toDetectReport(EL7_OUTPUT.replace('AVX2=yes', 'AVX2=no'))
    expect(report.baseline).toBe(true)
    // baseline 是「变体」而不是另一个平台：目标三元组不变。
    expect(report.platform).toBe('linux-x64')
  })

  it('glibc 低于 2.17 时如实说不可用，而不是硬装', () => {
    const report = toDetectReport(EL7_OUTPUT.replace('ldd (GNU libc) 2.17', 'ldd (GNU libc) 2.5'))
    expect(report.unsupportedReason).toContain('2.5')
    expect(report.unsupportedReason).toContain('2.17')
  })

  it('ARM 目标也在官方矩阵内', () => {
    expect(resolveTarget('aarch64', 'Linux', false)).toBe('linux-arm64')
    expect(resolveTarget('arm64', 'Darwin', false)).toBe('darwin-arm64')
  })

  it('不支持的架构不猜（riscv64 没有官方 2.x 构建）', () => {
    expect(resolveTarget('riscv64', 'Linux', false)).toBeUndefined()
    const report = toDetectReport(EL7_OUTPUT.replace('MACHINE=x86_64', 'MACHINE=riscv64'))
    expect(report.unsupportedReason).toContain('riscv64')
  })

  it('容器伪装要看得见（探测不纠偏，只如实报）', () => {
    expect(toDetectReport(EL7_OUTPUT.replace('CONTAINER=none', 'CONTAINER=docker')).container).toBe('docker')
  })

  it('没跑完的探测不算报告：ssh 通了也如实说脚本没跑完', () => {
    const report = toDetectReport('bash: command not found', { reachable: true, stderr: 'ssh: connect to host x port 22: Connection timed out' })
    // reachable 说的是「ssh 到了那台机器」，脚本没跑完是另一件事——两者都留在报告里。
    expect(report.reachable).toBe(true)
    expect(report.error).toContain('Connection timed out')
    expect(report.platform).toBeUndefined()
  })

  it('ssh 都没通时 reachable=false', () => {
    const report = toDetectReport('', { reachable: false, stderr: 'ssh: Could not resolve hostname' })
    expect(report.reachable).toBe(false)
    expect(report.error).toContain('Could not resolve')
  })

  it('出网未知时不假装知道', () => {
    expect(toDetectReport(EL7_OUTPUT.replace('OUTBOUND=yes', 'OUTBOUND=unknown')).outbound).toBeUndefined()
  })
})

describe('版本与 glibc 解析', () => {
  it('opencode --version 的两种写法', () => {
    expect(normalizeVersion('opencode v2.0.27')).toBe('2.0.27')
    expect(normalizeVersion('2.0.27\n')).toBe('2.0.27')
  })

  it('ldd 的三种写法', () => {
    expect(parseGlibc('ldd (GNU libc) 2.17')).toBe('2.17')
    expect(parseGlibc('ldd (Ubuntu GLIBC 2.35-0ubuntu3.1) 2.35')).toBe('2.35')
    expect(parseGlibc('musl libc (x86_64)')).toBeUndefined()
  })

  it('版本比较按三段，预发布后缀不参与', () => {
    expect(compareVersions('2.0.17', '2.0.20')).toBeLessThan(0)
    expect(compareVersions('2.1.0', '2.0.99')).toBeGreaterThan(0)
    expect(compareVersions('2.0.20', '2.0.20')).toBe(0)
  })
})

describe('就绪四档（D8）', () => {
  it('引擎在位 + 项目绑定 = 四档全绿', () => {
    const readiness = toReadiness(toDetectReport(EL7_OUTPUT), { projectPath: '/home/demo/project', anchorVersion: '2.0.27' })
    expect(readiness.ready).toBe(true)
    expect(readiness.steps.map((s) => s.id)).toEqual(['ssh', 'shell', 'engine', 'project'])
    expect(readiness.steps.every((s) => s.action === undefined)).toBe(true)
  })

  it('引擎缺失时第③档不绿，并给出可执行动作', () => {
    const report = toDetectReport(EL7_OUTPUT.replace('ENGINE_PATH=/home/demo/.opencode/bin/opencode', 'ENGINE_PATH=none'))
    const readiness = toReadiness(report, { projectPath: '/home/demo/project' })
    const engine = readiness.steps.find((s) => s.id === 'engine')
    expect(readiness.ready).toBe(false)
    expect(engine?.ok).toBe(false)
    expect(engine?.action).toContain('部署引擎')
    // 既有安装要出现在 detail 里，让用户知道我们看见了它、且不会动它。
    expect(engine?.detail).toContain('1.18.34')
    expect(engine?.detail).toContain('不会动它')
  })

  it('版本漂移（在位 ≠ 面板宿主）单独算不绿', () => {
    const readiness = toReadiness(toDetectReport(EL7_OUTPUT), { projectPath: '/p', anchorVersion: '2.1.0' })
    const engine = readiness.steps.find((s) => s.id === 'engine')
    expect(engine?.ok).toBe(false)
    expect(engine?.detail).toContain('不一致')
  })

  it('没有项目绑定时第④档如实报缺', () => {
    const readiness = toReadiness(toDetectReport(EL7_OUTPUT), {})
    expect(readiness.steps.find((s) => s.id === 'project')?.detail).toContain('还没有绑定')
  })

  it('连不上时前三档都不假装通过', () => {
    const readiness = toReadiness({ reachable: false, error: 'ssh 超时' }, {})
    expect(readiness.steps.find((s) => s.id === 'ssh')?.ok).toBe(false)
    expect(readiness.steps.find((s) => s.id === 'shell')?.ok).toBe(false)
    expect(readiness.steps.find((s) => s.id === 'engine')?.ok).toBe(false)
  })

  it('$HOME 不可写 → 第②档不绿（官方安装路径的最低要求）', () => {
    const readiness = toReadiness(toDetectReport(EL7_OUTPUT.replace('HOME_WRITABLE=yes', 'HOME_WRITABLE=no')))
    expect(readiness.steps.find((s) => s.id === 'shell')?.ok).toBe(false)
  })
})

describe('node/npm —— 运行时补齐的前置条件', () => {
  it('报出两者的版本（有没有 npm 决定能不能装）', () => {
    const report = toDetectReport(EL7_OUTPUT)
    expect(report.node).toBe('v22.11.0')
    expect(report.npm).toBe('10.9.0')
    expect(report.nodeOk).toBe(true)
  })

  it('没有 npm 时不编一个版本出来', () => {
    const report = toDetectReport(EL7_OUTPUT.replace('NPM=10.9.0', 'NPM=none'))
    expect(report.npm).toBeUndefined()
  })

  it('node 大版本低于 20 → nodeOk=false（老 EL7 上装不动现代包）', () => {
    expect(toDetectReport(EL7_OUTPUT.replace('NODE=v22.11.0', 'NODE=v16.20.2')).nodeOk).toBe(false)
    expect(toDetectReport(EL7_OUTPUT.replace('NODE=v22.11.0', 'NODE=v20.0.0')).nodeOk).toBe(true)
    expect(toDetectReport(EL7_OUTPUT.replace('NODE=v22.11.0', 'NODE=none')).nodeOk).toBe(false)
  })

  it('nodeMajorOk 只认大版本（v 前缀、非数字都处理掉）', () => {
    expect(nodeMajorOk('v20.20.2')).toBe(true)
    expect(nodeMajorOk('22.11.0')).toBe(true)
    expect(nodeMajorOk('18.20.4')).toBe(false)
    expect(nodeMajorOk(undefined)).toBe(false)
    expect(nodeMajorOk('v22.11.0-nightly20240101')).toBe(true)
    expect(nodeMajorOk('unknown')).toBe(false)
  })
})
