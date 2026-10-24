import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareSemver, latestPublishedPack, packReleaseAssets, packReleaseAvailable, parsePackReleases,
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
