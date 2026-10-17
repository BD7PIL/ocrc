import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appPackManifestUrl, appPackName, appPackPath, appPackTierForGlibc,
  ensureAppPack, ensureAppPayload, parseAppPackManifest,
} from '../../src/core/remote-instance-push.js'

/**
 * CI compat packs: the tier follows the *target's* glibc, and a verified pack
 * is preferred over the control-side `npm install --os=linux` cross-build.
 * These tests never touch the network — the release path is driven through a
 * fake fetch.
 */

let home = ''
let packDir = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ocrc-pack-home-'))
  packDir = mkdtempSync(join(tmpdir(), 'ocrc-pack-dir-'))
  process.env.OCRC_HOME = home
  delete process.env.OCRC_PACK_DIR
})

afterEach(() => {
  delete process.env.OCRC_HOME
  delete process.env.OCRC_PACK_DIR
  rmSync(home, { recursive: true, force: true })
  rmSync(packDir, { recursive: true, force: true })
})

function makePack(version: string, tier: string, body = `pack-${version}-${tier}`): { file: string; sha: string } {
  const file = join(packDir, appPackName(version, tier as never))
  writeFileSync(file, body)
  const sha = createHash('sha512').update(body).digest('base64')
  writeFileSync(`${file}.sha512`, `${sha}\n`)
  return { file, sha }
}

describe('app pack tier + naming', () => {
  it('legacy for glibc below 2.31 (official prebuilds need 2.28 anyway)', () => {
    expect(appPackTierForGlibc('2.17')).toBe('legacy-glibc217')
    expect(appPackTierForGlibc('ldd (GNU libc) 2.28')).toBe('legacy-glibc217')
    expect(appPackTierForGlibc('2.30')).toBe('legacy-glibc217')
    expect(appPackTierForGlibc('2.31')).toBe('modern')
    expect(appPackTierForGlibc('2.35')).toBe('modern')
    expect(appPackTierForGlibc(undefined)).toBe('modern')
  })

  it('names are stable and tier-scoped', () => {
    expect(appPackName('2.3.3', 'legacy-glibc217')).toBe('ocrc-remote-pack-2.3.3-linux-x64-legacy-glibc217.tar.gz')
    expect(appPackPath('2.3.3', 'modern').endsWith('ocrc-remote-pack-2.3.3-linux-x64-modern.tar.gz')).toBe(true)
    expect(appPackManifestUrl('2.3.3')).toContain('ocrc-remote-pack-2.3.3/ocrc-remote-pack-manifest.json')
  })

  it('manifest parsing rejects entries without an asset or digest', () => {
    const manifest = { tiers: { modern: { asset: 'a.tgz', sha512Base64: 'sha' }, legacy: {} } }
    expect(parseAppPackManifest(manifest, 'modern')).toEqual({ asset: 'a.tgz', sha512Base64: 'sha' })
    expect(parseAppPackManifest(manifest, 'legacy-glibc217')).toBeUndefined()
    expect(parseAppPackManifest({}, 'modern')).toBeUndefined()
  })
})

describe('ensureAppPack', () => {
  it('copies and verifies a pack from a local directory', async () => {
    const { sha } = makePack('2.3.3', 'modern')
    const pack = await ensureAppPack('2.3.3', 'modern', { packDir })
    expect(pack?.tier).toBe('modern')
    expect(pack?.sha).toBe(sha)
    expect(existsSync(appPackPath('2.3.3', 'modern'))).toBe(true)
    // Second call takes the cache path (no directory needed).
    const cached = await ensureAppPack('2.3.3', 'modern')
    expect(cached?.sha).toBe(sha)
    expect(cached?.prepared).toBe(false)
  })

  it('downloads through the release manifest and verifies the digest', async () => {
    const body = Buffer.from('remote-pack-bytes')
    const sha = createHash('sha512').update(body).digest('base64')
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('ocrc-remote-pack-manifest.json')) {
        return new Response(JSON.stringify({ tiers: { modern: { asset: 'ocrc-remote-pack-2.3.3-linux-x64-modern.tar.gz', sha512Base64: sha } } }), { status: 200 })
      }
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const pack = await ensureAppPack('2.3.3', 'modern', { fetchImpl })
    expect(pack?.sha).toBe(sha)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a digest mismatch is not installed', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('ocrc-remote-pack-manifest.json')) {
        return new Response(JSON.stringify({ tiers: { modern: { asset: 'x.tgz', sha512Base64: 'not-the-digest' } } }), { status: 200 })
      }
      return new Response('tampered', { status: 200 })
    }) as unknown as typeof fetch
    expect(await ensureAppPack('2.3.3', 'modern', { fetchImpl })).toBeUndefined()
    expect(existsSync(appPackPath('2.3.3', 'modern'))).toBe(false)
  })

  it('no pack anywhere returns undefined so the caller can cross-install', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    expect(await ensureAppPack('9.9.9', 'modern', { fetchImpl })).toBeUndefined()
  })
})

describe('ensureAppPayload fast path', () => {
  it('uses the pack without touching the cross-install path', async () => {
    const { sha } = makePack('2.3.3', 'legacy-glibc217')
    const payload = await ensureAppPayload('2.3.3', { tier: 'legacy-glibc217', packDir })
    expect(payload.tier).toBe('legacy-glibc217')
    expect(payload.sha).toBe(sha)
    expect(payload.file).toBe(appPackPath('2.3.3', 'legacy-glibc217'))
    // The cross-install tree must not have been created.
    expect(existsSync(join(home, 'bin-cache', 'remote-app', '2.3.3', 'tree'))).toBe(false)
  })
})
