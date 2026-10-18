import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvisioner, type ProvisionDeps } from './provision.js'
import { cacheFileName, sha512Of } from './artifact.js'
import { BACKUP_SUFFIX } from './install.js'
import { normalizeProfile } from '../shared/protocol.js'
import type { ProvisionPlan } from '../shared/provision.js'

const PROFILE = normalizeProfile({ id: 'vm1', name: 'vm', host: '192.168.26.101', user: 'demo', remotePort: 4096, localPort: 4096 })

const DETECT_V2 = [
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
  'ENGINE_PATH=none',
  'LEGACY_PATH=/home/demo/.local/bin/opencode',
  'LEGACY_VERSION=1.18.34',
  'OUTBOUND=direct',
  'DETECT_DONE=1',
].join('\n')

const tarball = Buffer.from('pretend artifact bytes')
const INTEGRITY = sha512Of(tarball)
const ARTIFACT_BODY = {
  dist: {
    tarball: 'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.27.tgz',
    integrity: INTEGRITY,
    unpackedSize: 210_368_204,
  },
}

/** 一个会说两种话的 exec：探测脚本回探测输出，身份脚本回身份输出，其余回队列。 */
function makeDeps(overrides: Partial<ProvisionDeps> & { detect?: string; identity?: string; install?: string; home?: string } = {}) {
  const calls: string[] = []
  const exec: ProvisionDeps['exec'] = async (_profile, script) => {
    calls.push(script)
    if (script.includes('DETECT_DONE=1')) return { code: 0, stdout: overrides.detect ?? DETECT_V2, stderr: '' }
    if (script.includes('IDENTITY_DONE=1')) return { code: 0, stdout: overrides.identity ?? 'PRESENT=no\nEXECUTABLE=no\nIDENTITY_DONE=1\n', stderr: '' }
    if (script.includes('OCRC_UPLOADED=1')) return { code: 0, stdout: 'OCRC_UPLOADED=1\n', stderr: '' }
    return { code: 0, stdout: overrides.install ?? 'OCRC_OK=1\nOCRC_PATH=/home/demo/.opencode/bin/opencode\nOCRC_VERSION=2.0.27\n', stderr: '' }
  }
  return {
    calls,
    deps: {
      exec,
      execLocal: async () => '2.0.27\n',
      fetchImpl: (async (url: string) => (String(url).endsWith('.tgz')
        ? new Response(tarball, { status: 200 })
        : new Response(JSON.stringify(ARTIFACT_BODY), { status: 200 }))) as unknown as typeof fetch,
      ...overrides,
    } as ProvisionDeps,
  }
}

describe('版本锚点（D6：镜像面板宿主，不 follow latest）', () => {
  it('读面板宿主的 ~/.opencode/bin/opencode --version', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    const anchor = await provisioner.anchorVersion()
    expect(anchor.version).toBe('2.0.27')
    expect(anchor.source).toContain('面板宿主')
  })

  it('面板宿主没有 v2 引擎时如实说读不到，不退化到 latest', async () => {
    const { deps } = makeDeps()
    const provisioner = createProvisioner({ ...deps, execLocal: async () => { throw new Error('ENOENT') } })
    const anchor = await provisioner.anchorVersion()
    expect(anchor.version).toBeUndefined()
    expect(anchor.source).toContain('没有可用的 opencode v2')
  })

  it('面板宿主装的是 1.x 时不算锚点（版本源必须是 v2）', async () => {
    const { deps } = makeDeps()
    const provisioner = createProvisioner({ ...deps, execLocal: async () => '1.18.34\n' })
    expect((await provisioner.anchorVersion()).version).toBeUndefined()
  })

  it('档案里显式写了版本就用它（面板宿主可以不是被控端的镜像源）', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    expect((await provisioner.anchorVersion('2.1.0')).version).toBe('2.1.0')
  })
})

describe('inspect：一次探测 + 四档就绪', () => {
  it('真机输出 → 四档里第③档差引擎，并给出锚点版本', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    const report = await provisioner.inspect(normalizeProfile({ ...PROFILE, projects: [{ path: '/home/demo/project' }] }))
    expect(report.detect.platform).toBe('linux-x64')
    expect(report.detect.legacyEngine?.version).toBe('1.18.34')
    expect(report.anchor).toBe('2.0.27')
    expect(report.readiness.ready).toBe(false)
    expect(report.readiness.steps.find((s) => s.id === 'engine')?.ok).toBe(false)
  })
})

describe('plan：预演的就是将要执行的（D3/D4）', () => {
  it('未装 + 出网 → install，从被控端直取', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    if ('error' in planned) throw new Error(planned.error)
    expect(planned.plan.action).toBe('install')
    expect(planned.plan.source).toBe('remote')
    expect(planned.plan.package).toBe('@opencode/cli-linux-x64')
    expect(planned.plan.installDir).toBe('/home/demo/.opencode/bin')
    expect(planned.plan.home).toBe('/home/demo')
    expect(planned.plan.reason).toContain('被控端自己下载')
  })

  it('不出网 → push（air-gapped），并说明是从面板推送', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, { ...detect, outbound: false })
    if ('error' in planned) throw new Error(planned.error)
    expect(planned.plan.source).toBe('push')
    expect(planned.plan.reason).toContain('面板推送')
  })

  it('无 AVX2 的 VM → baseline 变体（老 VM 的正解）', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, { ...detect, baseline: true })
    if ('error' in planned) throw new Error(planned.error)
    expect(planned.plan.variant).toBe('baseline')
    expect(planned.plan.package).toBe('@opencode/cli-linux-x64-baseline')
  })

  it('在位且工件一致 → none（不重复推 200MB）', async () => {
    const provisioner = createProvisioner(makeDeps({
      identity: `PRESENT=yes\nEXECUTABLE=yes\nVERSION=2.0.27\nMARKER_BEGIN\n{"integrity":"${INTEGRITY}","version":"2.0.27"}\nMARKER_END\nIDENTITY_DONE=1\n`,
    }).deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    if ('error' in planned) throw new Error(planned.error)
    expect(planned.plan.action).toBe('none')
    expect(planned.plan.currentVersion).toBe('2.0.27')
  })

  it('面板宿主没有锚点版本时拒绝规划，而不是猜一个', async () => {
    const { deps } = makeDeps()
    const provisioner = createProvisioner({ ...deps, execLocal: async () => '' })
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    expect('error' in planned && planned.error).toContain('版本源')
  })

  it('glibc 过旧的机器直接拒绝，不做「装上去试试」', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, { ...detect, unsupportedReason: '目标机 glibc 2.5 低于官方 2.x 的下限 2.17' })
    expect('error' in planned && planned.error).toContain('2.17')
  })

  it('官方没有那个版本的包时把 registry 的原话传回来', async () => {
    const { deps } = makeDeps()
    const provisioner = createProvisioner({
      ...deps,
      fetchImpl: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    })
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    expect('error' in planned && planned.error).toContain('换一个版本或换 baseline 变体')
  })
})

describe('apply：两条路都过同一套校验，失败不留半截（D4/D17）', () => {
  it('直取路：装好后如实回报版本', async () => {
    const { deps, calls } = makeDeps()
    const provisioner = createProvisioner(deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    if ('error' in planned) throw new Error(planned.error)

    const outcome = await provisioner.apply(PROFILE, planned.plan, planned.artifact)
    expect(outcome.ok).toBe(true)
    expect(outcome.version).toContain('2.0.27')
    const installScript = calls.find((c) => c.includes('EXPECT_B64') && c.includes('DETECT_DONE') === false)
    expect(installScript).toContain('curl -fsSL')
  })

  it('推送路：先确认缓存里有校验过的工件，再 base64 管道上传', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocrc-prov-'))
    const { deps, calls } = makeDeps({ home, cacheDir: join(home, 'cache') })
    const provisioner = createProvisioner(deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, { ...detect, outbound: false })
    if ('error' in planned) throw new Error(planned.error)

    // 缓存空 → 明说要去联网取一次，绝不偷偷下载。
    const cold = await provisioner.apply(PROFILE, planned.plan, planned.artifact)
    expect(cold.ok).toBe(false)
    expect(cold.error).toContain('先在面板侧联网执行一次')

    // 备好缓存后推送成功。
    await provisioner.prefetch(planned.artifact)
    expect(await import('node:fs').then((fs) => fs.existsSync(join(join(home, 'cache'), cacheFileName(planned.artifact))))).toBe(true)
    const warm = await provisioner.apply(PROFILE, planned.plan, planned.artifact)
    expect(warm.ok).toBe(true)
    const upload = calls.find((c) => c.includes('OCRC_UPLOADED=1'))
    expect(upload).toContain('base64 -d >')
  })

  it('none 动作不碰被控端', async () => {
    const { deps, calls } = makeDeps()
    const provisioner = createProvisioner(deps)
    const before = calls.length
    const plan: ProvisionPlan = {
      action: 'none', target: 'linux-x64', variant: 'default', package: '@opencode/cli-linux-x64',
      version: '2.0.27', integrity: INTEGRITY, source: 'remote', installDir: '/home/demo/.opencode/bin',
      home: '/home/demo', currentVersion: '2.0.27', reason: '已是 2.0.27', anchorVersion: '2.0.27',
    }
    const outcome = await provisioner.apply(PROFILE, plan, { package: plan.package, version: plan.version, integrity: INTEGRITY, tarballUrl: 'https://registry.npmjs.org/x/-/x.tgz' })
    expect(outcome.ok).toBe(true)
    expect(calls.length).toBe(before)
  })

  it('安装脚本报校验失败时，期望与实得都回到面板', async () => {
    const { deps } = makeDeps({ install: 'OCRC_ERR=integrity\nOCRC_GOT=sha512-other\n' })
    const provisioner = createProvisioner(deps)
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    if ('error' in planned) throw new Error(planned.error)
    const outcome = await provisioner.apply(PROFILE, planned.plan, planned.artifact)
    expect(outcome.ok).toBe(false)
    expect(outcome.expected).toBe(INTEGRITY)
    expect(outcome.got).toBe('sha512-other')
  })

  it('安装报错时带上 ssh 的最后一句话，而不是空错误', async () => {
    const { deps } = makeDeps({ install: '' })
    const provisioner = createProvisioner({
      ...deps,
      exec: async (_p, script) => (script.includes('DETECT_DONE') || script.includes('IDENTITY_DONE')
        ? deps.exec(_p, script)
        : { code: 255, stdout: '', stderr: 'ssh: connect to host 192.168.26.101 port 22: Connection timed out\n' }),
    })
    const { detect } = await provisioner.inspect(PROFILE)
    const planned = await provisioner.plan(PROFILE, detect)
    if ('error' in planned) throw new Error(planned.error)
    const outcome = await provisioner.apply(PROFILE, planned.plan, planned.artifact)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('Connection timed out')
  })
})

describe('回滚与卸载都只动我们自己的命名空间', () => {
  it('回滚如实回报有没有成功', async () => {
    const provisioner = createProvisioner(makeDeps().deps)
    expect(await provisioner.rollback(PROFILE, 'linux-x64', '/home/demo')).toBe(false)
    const ok = createProvisioner({ ...makeDeps().deps, exec: async () => ({ code: 0, stdout: 'OCRC_ROLLED_BACK=1\n', stderr: '' }) })
    expect(await ok.rollback(PROFILE, 'linux-x64', '/home/demo')).toBe(true)
    expect(BACKUP_SUFFIX).toBe('.ocrc-bak')
  })

  it('卸载脚本只删 ~/.opencode/bin 里的东西', async () => {
    const { deps, calls } = makeDeps()
    const provisioner = createProvisioner({
      ...deps,
      exec: async (_p, script) => {
        calls.push(script)
        return { code: 0, stdout: 'OCRC_UNINSTALLED=1\n', stderr: '' }
      },
    })
    expect(await provisioner.uninstall(PROFILE, '/home/demo')).toBe(true)
    const script = calls.at(-1) ?? ''
    expect(script).toContain('/home/demo/.opencode/bin')
    expect(script).not.toContain('.local/bin')
  })

  it('prefetch 把工件落进面板缓存（air-gapped 前的一次联网）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocrc-prov-'))
    const provisioner = createProvisioner({ ...makeDeps().deps, home, cacheDir: join(home, 'cache') })
    const ref = { package: '@opencode/cli-linux-x64', version: '2.0.27', integrity: INTEGRITY, tarballUrl: 'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.27.tgz' }
    const { path } = await provisioner.prefetch(ref)
    expect(await import('node:fs').then((fs) => fs.readFileSync(path, 'utf-8'))).toBe(tarball.toString())
  })
})
