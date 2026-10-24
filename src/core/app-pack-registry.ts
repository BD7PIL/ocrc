import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appPackManifestUrl, appPackName, appPackPath, parseAppPackManifest, type AppPackTier } from './remote-instance-push.js'

/**
 * 渠道最新的发现（裁决 2026-10-24：升级目标 = 我们自己的供给渠道里最新已发布的
 * pack，不再跟随代码里的构建期常量）。"最新"只认 `ocrc-openchamber-pack-<semver>`
 * release 且七项核心资产齐全——`ocrc-pack.yml` 的 detect 门禁定义的那七项。一个
 * 不完整的 release 不是可安装的版本，永远不该被当成"最新"推荐给用户。
 *
 * 失败必须诚实：网络不通/限流/没有 release 都返回 `{ok:false, error}`，调用方
 * 原样呈现，绝不猜一个版本号。
 */

export interface PublishedPack {
  version: string
  tag: string
}

const PACK_TAG = /^ocrc-openchamber-pack-(\d+\.\d+\.\d+)$/
const TIERS: AppPackTier[] = ['modern', 'legacy-glibc217']
/** The 7 core assets a complete pack release carries (`ocrc-pack.yml` detect gate). */
export function packReleaseAssets(version: string): string[] {
  const out: string[] = []
  for (const tier of TIERS) {
    const base = appPackName(version, tier)
    out.push(base, `${base}.sha512`, `${base}.json`)
  }
  out.push('ocrc-openchamber-pack-manifest.json')
  return out
}

/** `1.2.3` 语义比较：-1/0/1（解析失败按 0，调用方只对已过 PACK_TAG 的版本用）。 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

/** 纯函数：GitHub releases API 的 JSON → 完整 pack 的升序列表。 */
export function parsePackReleases(raw: unknown): PublishedPack[] {
  if (!Array.isArray(raw)) return []
  const found: PublishedPack[] = []
  for (const rel of raw as Array<{ tag_name?: unknown; assets?: unknown }>) {
    const tag = rel?.tag_name
    if (typeof tag !== 'string') continue
    const m = PACK_TAG.exec(tag)
    if (!m) continue
    const assets = Array.isArray(rel.assets)
      ? (rel.assets as Array<{ name?: unknown }>).map((a) => a?.name).filter((n): n is string => typeof n === 'string')
      : []
    const need = packReleaseAssets(m[1]!)
    if (!need.every((n) => assets.includes(n))) continue
    found.push({ version: m[1]!, tag })
  }
  return found.sort((a, b) => compareSemver(a.version, b.version))
}

export type LatestPackResult = { ok: true; pack: PublishedPack } | { ok: false; error: string }

let cache: { at: number; value: LatestPackResult } | undefined
const CACHE_TTL_MS = 60_000

/**
 * 渠道里最新已发布（且完整）的 pack。60s 进程内缓存；注入 `fetchImpl`（测试）
 * 或 `bust: true` 时绕过缓存。永不抛错——失败就是 `{ok:false, error}`。
 */
export async function latestPublishedPack(
  opts: { fetchImpl?: typeof fetch; now?: () => number; bust?: boolean; ttlMs?: number } = {},
): Promise<LatestPackResult> {
  const now = opts.now?.() ?? Date.now()
  if (!opts.bust && !opts.fetchImpl && cache && now - cache.at < (opts.ttlMs ?? CACHE_TTL_MS)) return cache.value
  const api = (process.env.OCRC_PACK_API_BASE ?? 'https://api.github.com/repos/BD7PIL/ocrc').replace(/\/+$/, '')
  let value: LatestPackResult
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${api}/releases?per_page=100`, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const packs = parsePackReleases(await res.json())
    if (!packs.length) throw new Error('渠道里没有完整的 ocrc-openchamber-pack release')
    value = { ok: true, pack: packs[packs.length - 1]! }
  } catch (err) {
    value = { ok: false, error: (err as Error).message }
  }
  if (!opts.fetchImpl) cache = { at: now, value }
  return value
}

/**
 * `<version>` 的 pack 现在能不能装：本地缓存已验证 / `OCRC_PACK_DIR` 镜像目录有货 /
 * release manifest 能取到且含任一档。升级前的一道诚实闸——没有包就明说，不悄悄
 * 退化成控制端跨装（upgrade 是用户点"升级到 X"的动作，交付的就必须是 X 的 pack）。
 */
export async function packReleaseAvailable(
  version: string,
  opts: { fetchImpl?: typeof fetch; packDir?: string } = {},
): Promise<boolean> {
  for (const dir of [opts.packDir, process.env.OCRC_PACK_DIR].filter((d): d is string => !!d?.trim())) {
    for (const tier of TIERS) {
      if (existsSync(join(dir, appPackName(version, tier)))) return true
    }
  }
  for (const tier of TIERS) {
    const file = appPackPath(version, tier)
    if (existsSync(file) && existsSync(`${file}.sha512`)) return true
  }
  try {
    const url = appPackManifestUrl(version)
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return false
    const raw: unknown = await res.json()
    for (const tier of TIERS) {
      if (parseAppPackManifest(raw, tier)) return true
    }
    return false
  } catch {
    return false
  }
}
