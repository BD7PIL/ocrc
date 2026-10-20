import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// D2 unit coverage for the bin-cache module (offline bundle contract, PRODUCT
// 第零点六条). Network-dependent paths (fetchIntegrity/cacheArtifact against
// registry.npmjs.org) are covered by the E1 lab run + CI smoke, not here —
// these tests pin the pure logic: layout, target mapping, integrity compare,
// manifest/pin resolution.

const home = mkdtempSync(join(tmpdir(), 'ocrc-bincache-'))
process.env.OCRC_HOME = home

const {
  binCacheRoot, npmTargetFor, verifyIntegrity, readManifest, resolveV2Pin,
} = await import('../../src/core/bin-cache.js')

afterEach(() => {
  delete process.env.OCRC_V2_PIN
  rmSync(join(home, 'bin-cache'), { recursive: true, force: true })
})

describe('bin-cache layout', () => {
  it('resolves the cache root under OCRC_HOME', () => {
    expect(binCacheRoot()).toBe(join(home, 'bin-cache'))
  })
})

describe('npmTargetFor', () => {
  it('maps controlled-host platforms to npm target suffixes', () => {
    expect(npmTargetFor('linux', 'x64')).toBe('linux-x64')
    expect(npmTargetFor('linux', 'x86_64')).toBe('linux-x64')
    expect(npmTargetFor('linux', 'arm64')).toBe('linux-arm64')
    expect(npmTargetFor('linux', 'aarch64')).toBe('linux-arm64')
    expect(npmTargetFor('darwin', 'x64')).toBe('darwin-x64')
    expect(npmTargetFor('win32', 'x64')).toBe('win32-x64')
  })
})

describe('verifyIntegrity (registry sha512-base64 contract)', () => {
  it('accepts a file matching dist.integrity', () => {
    const f = join(home, 'a.tgz')
    const body = Buffer.from('artifact-bytes')
    writeFileSync(f, body)
    const integrity = 'sha512-' + createHash('sha512').update(body).digest('base64')
    expect(verifyIntegrity(f, integrity)).toBe(true)
  })
  it('rejects a corrupted download', () => {
    const f = join(home, 'b.tgz')
    writeFileSync(f, Buffer.from('artifact-bytes'))
    const integrity = 'sha512-' + createHash('sha512').update(Buffer.from('other-bytes')).digest('base64')
    expect(verifyIntegrity(f, integrity)).toBe(false)
  })
  it('accepts an integrity without the sha512- prefix', () => {
    const f = join(home, 'c.tgz')
    const body = Buffer.from('x')
    writeFileSync(f, body)
    const integrity = createHash('sha512').update(body).digest('base64')
    expect(verifyIntegrity(f, integrity)).toBe(true)
  })
})

describe('pin resolution (manifest declarative > env > dynamic-follow)', () => {
  it('returns undefined with no manifest and no env (dynamic-follow legacy)', () => {
    expect(resolveV2Pin()).toBeUndefined()
  })
  it('honors OCRC_V2_PIN without a manifest', () => {
    process.env.OCRC_V2_PIN = '2.0.27'
    expect(resolveV2Pin()).toBe('2.0.27')
  })
  it('manifest wins over env', () => {
    process.env.OCRC_V2_PIN = '2.0.27'
    const dir = join(home, 'bin-cache')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      opencodePin: '2.0.28',
      integrity: { 'linux-x64': 'sha512-xxx' },
      createdAt: new Date().toISOString(),
    }))
    expect(resolveV2Pin()).toBe('2.0.28')
    expect(readManifest()?.integrity['linux-x64']).toBe('sha512-xxx')
  })
  it('readManifest survives a corrupt manifest file', () => {
    const dir = join(home, 'bin-cache')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), '{not json')
    expect(readManifest()).toBeUndefined()
  })
})
