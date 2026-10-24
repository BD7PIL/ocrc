import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareSemver, decideEngineTarget, latestEngineVersion, latestPublishedPack, packReleaseAssets,
  packReleaseAvailable, parsePackReleases, planUpgradeRun,
} from '../../src/core/app-pack-registry.js'

const asJson = (v: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(v) }) as unknown as Response

function release(tag: string, assets: string[]) {
  return { tag_name: tag, assets: assets.map((name) => ({ name })) }
}

const full = (v: string) => release(`ocrc-openchamber-pack-${v}`, packReleaseAssets(v))

describe('parsePackReleases（渠道最新的纯解析）', () => {
  it('资产清单与线上真实命名一致（回归：per-tier json 不带 .tar.gz）', () => {
    // 逐字取自 ocrc-openchamber-pack-2.5.1 release 的实际资产名——别再用
    // packReleaseAssets 自己造夹具自证清白（第一版就是这么漏的）。
    expect(packReleaseAssets('2.5.1')).toEqual([
      'ocrc-openchamber-pack-2.5.1-linux-x64-modern.tar.gz',
      'ocrc-openchamber-pack-2.5.1-linux-x64-modern.tar.gz.sha512',
      'ocrc-openchamber-pack-2.5.1-linux-x64-modern.json',
      'ocrc-openchamber-pack-2.5.1-linux-x64-legacy-glibc217.tar.gz',
      'ocrc-openchamber-pack-2.5.1-linux-x64-legacy-glibc217.tar.gz.sha512',
      'ocrc-openchamber-pack-2.5.1-linux-x64-legacy-glibc217.json',
      'ocrc-openchamber-pack-manifest.json',
    ])
  })

  it('取最大 semver，乱序输入也稳', () => {
    const out = parsePackReleases([full('2.5.0'), full('2.3.3'), full('2.4.0')])
    expect(out.map((p) => p.version)).toEqual(['2.3.3', '2.4.0', '2.5.0'])
  })

  it('七项资产不全的 release 不算可安装版本（detect 门禁的同款判据）', () => {
    const incomplete = release('ocrc-openchamber-pack-9.9.9', packReleaseAssets('9.9.9').slice(1))
    const out = parsePackReleases([incomplete, full('2.5.0')])
    expect(out.map((p) => p.version)).toEqual(['2.5.0'])
  })

  it('非 pack 的 release 一律忽略（扩展 zip、latest tag、老命名）', () => {
    const out = parsePackReleases([
      release('ocrc-0.9.4', ['ocrc.zip']),
      release('ocrc-latest', ['ocrc.zip']),
      release('ocrc-remote-pack-2.3.3', ['whatever']),
      release('ocrc-openchamber-pack-2.5.1-rc1', packReleaseAssets('2.5.1')), // 非纯 semver tag
      full('2.5.1'),
    ])
    expect(out.map((p) => p.version)).toEqual(['2.5.1'])
  })

  it('垃圾输入返回空数组而不是抛错', () => {
    expect(parsePackReleases(undefined)).toEqual([])
    expect(parsePackReleases('nope')).toEqual([])
    expect(parsePackReleases([null, 3, {}])).toEqual([])
  })
})

describe('compareSemver', () => {
  it('主/次/补丁逐位比较', () => {
    expect(compareSemver('2.3.3', '2.4.0')).toBe(-1)
    expect(compareSemver('2.10.0', '2.9.9')).toBe(1)
    expect(compareSemver('2.5.0', '2.5.0')).toBe(0)
  })
})

describe('latestPublishedPack（发现与缓存）', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('成功：返回最大版本', async () => {
    const fetchImpl = vi.fn(async () => asJson([full('2.5.0'), full('2.4.0')]))
    const r = await latestPublishedPack({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toEqual({ ok: true, pack: { version: '2.5.0', tag: 'ocrc-openchamber-pack-2.5.0' } })
  })

  it('HTTP 失败与空渠道都是诚实错误，不猜版本', async () => {
    const http500 = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response)
    expect((await latestPublishedPack({ fetchImpl: http500 as unknown as typeof fetch })).ok).toBe(false)
    const empty = vi.fn(async () => asJson([release('ocrc-0.9.4', ['ocrc.zip'])]))
    const r = await latestPublishedPack({ fetchImpl: empty as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('没有完整的')
  })

  it('OCRC_PACK_API_BASE 可换（离线镜像/企业代理）', async () => {
    vi.stubEnv('OCRC_PACK_API_BASE', 'https://mirror.internal/api/')
    const fetchImpl = vi.fn(async (url: unknown) => asJson([full('2.5.0')]))
    await latestPublishedPack({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://mirror.internal/api/releases?per_page=100')
  })
})

describe('packReleaseAvailable（升级前的诚实闸）', () => {
  it('OCRC_PACK_DIR 里有该版本的任一档就算可用（离线镜像）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-packdir-'))
    writeFileSync(join(dir, 'ocrc-openchamber-pack-2.5.0-linux-x64-modern.tar.gz'), 'x')
    expect(await packReleaseAvailable('2.5.0', { packDir: dir })).toBe(true)
  })

  it('manifest 有任一档就算可用；404 就不可用（"包还没发布"）', async () => {
    const ok = vi.fn(async (url: unknown) => asJson({
      tiers: { modern: { asset: 'ocrc-openchamber-pack-2.5.0-linux-x64-modern.tar.gz', sha512Base64: 'x' } },
    }))
    expect(await packReleaseAvailable('2.5.0', { fetchImpl: ok as unknown as typeof fetch })).toBe(true)
    const missing = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response)
    expect(await packReleaseAvailable('9.9.9', { fetchImpl: missing as unknown as typeof fetch })).toBe(false)
  })
})

describe('latestEngineVersion（引擎渠道最新，裁决之二）', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('成功：取 dist-tags.latest，剥掉 prerelease 尾巴', async () => {
    const fetchImpl = vi.fn(async () => asJson({ 'dist-tags': { latest: '2.1.4-beta.3' } }))
    const r = await latestEngineVersion({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toEqual({ ok: true, version: '2.1.4' })
  })

  it('URL 打到 @opencode/cli-<target>（与 bin-cache 同一个包）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => asJson({ 'dist-tags': { latest: '2.1.4' } }))
    await latestEngineVersion({ fetchImpl: fetchImpl as unknown as typeof fetch, npmTarget: 'linux-arm64' })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(encodeURIComponent('@opencode/cli-linux-arm64'))
  })

  it('缺 dist-tags.latest 是诚实错误，不猜版本', async () => {
    const fetchImpl = vi.fn(async () => asJson({ versions: {} }))
    const r = await latestEngineVersion({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('latest')
  })

  it('HTTP 失败 / 垃圾 latest 同样诚实失败', async () => {
    const http500 = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response)
    expect((await latestEngineVersion({ fetchImpl: http500 as unknown as typeof fetch })).ok).toBe(false)
    const garbage = vi.fn(async () => asJson({ 'dist-tags': { latest: 'not-a-version' } }))
    expect((await latestEngineVersion({ fetchImpl: garbage as unknown as typeof fetch })).ok).toBe(false)
  })

  it('OCRC_NPM_REGISTRY 可换（私有镜像），尾斜杠容忍', async () => {
    vi.stubEnv('OCRC_NPM_REGISTRY', 'https://npm.mirror.internal/')
    const fetchImpl = vi.fn(async (_url: unknown) => asJson({ 'dist-tags': { latest: '2.1.4' } }))
    await latestEngineVersion({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`https://npm.mirror.internal/${encodeURIComponent('@opencode/cli-linux-x64')}`)
    vi.unstubAllEnvs()
  })
})

describe('decideEngineTarget（只升不降）', () => {
  it('取 max(已装, 渠道最新)', () => {
    expect(decideEngineTarget({ current: '2.0.32', latest: '2.1.4' })).toBe('2.1.4')
    expect(decideEngineTarget({ current: '2.2.0', latest: '2.1.4' })).toBe('2.2.0')
  })

  it('渠道探测失败（缺 latest）→ 沿用现状', () => {
    expect(decideEngineTarget({ current: '2.0.32' })).toBe('2.0.32')
  })

  it('垃圾输入被忽略；全垃圾返回 undefined（调用方不许瞎动）', () => {
    expect(decideEngineTarget({ current: 'v2.x', latest: 'garbage' })).toBeUndefined()
    expect(decideEngineTarget({})).toBeUndefined()
    expect(decideEngineTarget({ current: '2.1.4', latest: 'junk' })).toBe('2.1.4')
  })
})

describe('planUpgradeRun（app 决策 × 引擎跟随的编排骨架）', () => {
  const base = { enginePin: '2.1.4' }

  it('回归：app no-op 不许短路引擎跟随——app 已渠道最新、引擎落后 → engine-only', () => {
    // 真机场景：app 2.5.1 已是渠道最新，引擎 2.0.32 被 2.5.1 的门禁拦下，
    // 老 upgrade 在这里提前 return "已经是这一版"，引擎永远补不上。
    const run = planUpgradeRun({
      decision: { action: 'noop', to: '2.5.1', detail: '已经是这一版：2.5.1' },
      engineCurrent: '2.0.32',
      engineLatest: '2.1.4',
      ...base,
    })
    expect(run).toEqual({ kind: 'engine-only', to: '2.5.1', engineTo: '2.1.4' })
  })

  it('app 与引擎都已是渠道最新 → 纯 noop（不制造重装噪音）', () => {
    const run = planUpgradeRun({
      decision: { action: 'noop', to: '2.5.1', detail: '已经是这一版：2.5.1' },
      engineCurrent: '2.1.4',
      engineLatest: '2.1.4',
      ...base,
    })
    expect(run.kind).toBe('noop')
  })

  it('app 升级且引擎落后 → app+engine（一次 apply 带两个目标）', () => {
    const run = planUpgradeRun({
      decision: { action: 'upgrade', to: '2.5.1' },
      engineCurrent: '2.0.32',
      engineLatest: '2.1.4',
      ...base,
    })
    expect(run).toEqual({ kind: 'app+engine', to: '2.5.1', engineTo: '2.1.4' })
  })

  it('app 升级但引擎已是最新/渠道查不到 → 只升 app，引擎延续现状', () => {
    expect(planUpgradeRun({ decision: { action: 'upgrade', to: '2.5.1' }, engineCurrent: '2.1.4', engineLatest: '2.1.4', ...base }).kind).toBe('app')
    // 引擎渠道探测失败：engineTo 回落为已装 pin → 与 current 相等 → 不动引擎
    expect(planUpgradeRun({ decision: { action: 'upgrade', to: '2.5.1' }, engineCurrent: '2.0.32', ...base }).kind).toBe('app')
  })

  it('refuse 一票否决（渠道都查不到时不写任何东西，引擎也不动）', () => {
    const run = planUpgradeRun({
      decision: { action: 'refuse', to: '2.3.3', detail: '查不到渠道最新包' },
      engineCurrent: '2.0.32',
      engineLatest: '2.1.4',
      ...base,
    })
    expect(run).toEqual({ kind: 'refuse', to: '2.3.3', detail: '查不到渠道最新包' })
  })

  it('没装过引擎的机器（engineCurrent 空）：即使 app no-op 也按生效 pin 补引擎', () => {
    const run = planUpgradeRun({
      decision: { action: 'noop', to: '2.5.1', detail: '已经是这一版：2.5.1' },
      engineLatest: '2.1.4',
      ...base,
    })
    expect(run).toEqual({ kind: 'engine-only', to: '2.5.1', engineTo: '2.1.4' })
  })

  it('渠道比已装还旧（registry 回退）→ 只升不降，保持已装引擎', () => {
    const run = planUpgradeRun({
      decision: { action: 'upgrade', to: '2.5.1' },
      engineCurrent: '2.2.0',
      engineLatest: '2.1.4',
      ...base,
    })
    expect(run.kind).toBe('app')
  })
})
