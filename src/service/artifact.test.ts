import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cacheFileName, cachedArtifactPath, defaultCacheDir, describeArtifact, fetchArtifactToCache,
  resolveArtifact, sha512Of, verifyIntegrity,
} from './artifact.js'
import { platformPackage } from '../shared/provision.js'

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

const tarball = Buffer.from('pretend this is a 60MB binary')
const INTEGRITY = sha512Of(tarball)

describe('平台包选择（D4：绝不用 musl / 面板平台无关）', () => {
  it('按目标平台拼包名，baseline 是变体而不是另一个平台', () => {
    expect(platformPackage('linux-x64', 'default')).toBe('@opencode/cli-linux-x64')
    expect(platformPackage('linux-x64', 'baseline')).toBe('@opencode/cli-linux-x64-baseline')
    expect(platformPackage('linux-arm64', 'default')).toBe('@opencode/cli-linux-arm64')
    expect(platformPackage('win32-x64', 'default')).toBe('@opencode/cli-windows-x64')
  })

  it('解析用的是目标平台，不是面板自己的 process.platform', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain('cli-linux-x64') // 面板在 Windows 上跑也必须是 linux 包
      return jsonResponse({ dist: { tarball: 'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.27.tgz', integrity: INTEGRITY, unpackedSize: 210368204 } })
    })
    const ref = await resolveArtifact('linux-x64', 'default', '2.0.27', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(ref.package).toBe('@opencode/cli-linux-x64')
    expect(ref.version).toBe('2.0.27')
    expect(ref.integrity).toBe(INTEGRITY)
    // 确认框里要说清要传多少——四舍五入到 MB 就够，但必须有。
    expect(describeArtifact(ref)).toContain('201 MB')
  })

  it('版本不存在时给出可操作的话（换版本或换变体）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Not found' }, 404))
    await expect(resolveArtifact('linux-x64', 'default', '9.9.9', { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/换一个版本或换 baseline 变体/)
  })

  it('integrity 不是 sha512 时拒绝（没有校验的工件不装）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ dist: { tarball: 'https://registry.npmjs.org/x/-/x.tgz', integrity: 'sha1-abc' } }))
    await expect(resolveArtifact('linux-x64', 'default', '2.0.27', { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/不是 sha512/)
  })

  it('tarball 指向别处时拒绝（那串 integrity 校验的不是这个 URL）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ dist: { tarball: 'https://evil.example/x.tgz', integrity: INTEGRITY } }))
    await expect(resolveArtifact('linux-x64', 'default', '2.0.27', { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/不在 npm registry 上/)
  })
})

describe('sha512 校验', () => {
  it('校验失败必须抛，且带上期望与实得', () => {
    expect(() => verifyIntegrity(Buffer.from('tampered'), INTEGRITY)).toThrow(/工件校验失败/)
    expect(() => verifyIntegrity(tarball, INTEGRITY)).not.toThrow()
  })
})

describe('面板侧工件缓存', () => {
  it('首次下载 → 落盘 → 二次命中不再联网', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocrc-art-'))
    const fetchImpl = vi.fn(async () => new Response(tarball, { status: 200 }))
    const ref = { package: '@opencode/cli-linux-x64', version: '2.0.27', integrity: INTEGRITY, tarballUrl: 'https://registry.npmjs.org/x/-/x.tgz' }

    const first = await fetchArtifactToCache(ref, { dir, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await readFile(first)).toEqual(tarball)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const second = await fetchArtifactToCache(ref, { dir, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(second).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cacheFileName(ref)).toBe('@opencode__cli-linux-x64-2.0.27.tgz')
  })

  it('缓存被篡改 → 丢掉并重新下载（air-gapped 推送不能把脏件送过去）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocrc-art-'))
    const ref = { package: '@opencode/cli-linux-x64', version: '2.0.27', integrity: INTEGRITY, tarballUrl: 'https://registry.npmjs.org/x/-/x.tgz' }
    await writeFile(join(dir, cacheFileName(ref)), 'tampered')
    expect(await cachedArtifactPath(ref, dir)).toBeNull()

    const fetchImpl = vi.fn(async () => new Response(tarball, { status: 200 }))
    const path = await fetchArtifactToCache(ref, { dir, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await readFile(path)).toEqual(tarball)
  })

  it('下载内容与 integrity 不符 → 不落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocrc-art-'))
    const ref = { package: '@opencode/cli-linux-x64', version: '2.0.27', integrity: INTEGRITY, tarballUrl: 'https://registry.npmjs.org/x/-/x.tgz' }
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('not the artifact'), { status: 200 }))
    await expect(fetchArtifactToCache(ref, { dir, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/校验失败/)
    expect(await cachedArtifactPath(ref, dir)).toBeNull()
  })
})

describe('缓存目录只在自己的命名空间里', () => {
  it('是 `~/.ocrc/artifacts`——面板宿主上的路径，分隔符随宿主平台', () => {
    expect(defaultCacheDir('/Users/me')).toBe(join('/Users/me', '.ocrc', 'artifacts'))
    expect(defaultCacheDir('/Users/me/')).toBe(join('/Users/me', '.ocrc', 'artifacts'))
  })
})
