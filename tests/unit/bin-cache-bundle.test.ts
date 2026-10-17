import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleArtifactPath, bundleDir, readBundleManifest, takeBundleArtifact,
} from '../../src/core/bin-cache.js'

/**
 * B2 — the CI offline bundle, consumed instead of re-downloaded.
 *
 * `ocrc-follow.yml` has always produced `cli-<target>-<version>.tgz` + a
 * manifest, and no code ever read them: every install went to the registry even
 * with the bytes on disk. These tests pin the two rules that make consuming it
 * safe — a bundle file without a digest is ignored, and a mismatching digest is
 * an error (not a quiet fallback to the network).
 */

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-bundle-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  delete process.env.OCRC_BUNDLE_DIR
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sha512 = (buf: Buffer) => `sha512-${createHash('sha512').update(buf).digest('base64')}`

function bundle(files: Record<string, Buffer>, manifest: unknown): string {
  const dir = tmp()
  mkdirSync(dir, { recursive: true })
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}

describe('offline bundle consumption', () => {
  it('uses a bundle artifact whose digest matches the manifest', () => {
    const tgz = Buffer.from('pretend-tgz-bytes')
    const dir = bundle({ 'cli-linux-x64-2.0.27.tgz': tgz }, {
      opencodePin: '2.0.27',
      digests: { 'linux-x64': { sha512: sha512(tgz), bytes: tgz.length } },
    })
    const hit = takeBundleArtifact('2.0.27', 'linux-x64', dir)
    expect(hit?.file).toBe(join(dir, 'cli-linux-x64-2.0.27.tgz'))
    expect(hit?.sha512).toBe(sha512(tgz).slice(7))
  })

  it('ignores a bundle file the manifest cannot vouch for', () => {
    const dir = bundle({ 'cli-linux-x64-2.0.27.tgz': Buffer.from('x') }, { opencodePin: '2.0.27' })
    // No digest → the caller falls back to the registry rather than installing
    // bytes nobody verified.
    expect(takeBundleArtifact('2.0.27', 'linux-x64', dir)).toBeUndefined()
  })

  it('refuses a tampered bundle loudly instead of re-downloading quietly', () => {
    const dir = bundle({ 'cli-linux-x64-2.0.27.tgz': Buffer.from('tampered') }, {
      digests: { 'linux-x64': { sha512: sha512(Buffer.from('the-real-one')) } },
    })
    expect(() => takeBundleArtifact('2.0.27', 'linux-x64', dir)).toThrow(/digest mismatch/)
  })

  it('reports nothing for a version or target the bundle does not carry', () => {
    const dir = bundle({ 'cli-linux-arm64-2.0.27.tgz': Buffer.from('arm') }, {
      digests: { 'linux-arm64': { sha512: sha512(Buffer.from('arm')) } },
    })
    expect(takeBundleArtifact('2.0.27', 'linux-x64', dir)).toBeUndefined()
    expect(takeBundleArtifact('2.0.26', 'linux-arm64', dir)).toBeUndefined()
  })

  it('an unreadable manifest is "no bundle", not a crash', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'manifest.json'), '{not json')
    expect(readBundleManifest(dir)).toBeUndefined()
  })

  it('defaults to <bin-cache>/bundle and honours OCRC_BUNDLE_DIR', () => {
    process.env.OCRC_HOME = tmp()
    expect(bundleDir().endsWith(join('bin-cache', 'bundle'))).toBe(true)
    process.env.OCRC_BUNDLE_DIR = join(tmp(), 'from-env')
    expect(bundleDir()).toBe(process.env.OCRC_BUNDLE_DIR)
    expect(bundleArtifactPath('2.0.27', 'linux-x64')).toBe(join(process.env.OCRC_BUNDLE_DIR, 'cli-linux-x64-2.0.27.tgz'))
  })
})
