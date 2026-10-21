import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildArtifactProbeCommand, buildArtifactPushScript, buildComponentUnpackScript,
  buildExtensionInstallScript, defaultComponentSources, parseComponentManifest, pluginEntryFor,
  prepareComponent, sourcesFromPins,
} from '../../src/core/components.js'

const base = {
  schema: 1,
  name: 'reeve',
  version: '0.1.2',
  enginePlugin: { spec: '@bd7pil/reeve@0.1.2', kind: 'package' as const },
}

describe('provision.json', () => {
  it('accepts the documented shape', () => {
    const m = parseComponentManifest({
      ...base,
      artifacts: [{
        id: 'bifrost', version: '2.3.0', url: 'https://example.test/bifrost', sha256: 'a'.repeat(64),
        size: 10, dest: '~/.reeve/proxy/bifrost-http', mode: '0755',
      }],
      extension: { apiVersion: 1, id: 'reeve', zip: 'https://example.test/reeve.zip', capabilities: ['sessions'] },
      verify: [
        { kind: 'file', path: '~/.reeve/proxy/bifrost-http', mode: '0755' },
        { kind: 'engine-plugin-loaded', spec: '@bd7pil/reeve' },
        { kind: 'guest-installed', id: 'reeve' },
      ],
    })
    expect(m.name).toBe('reeve')
    expect(m.artifacts?.[0]?.dest).toBe('~/.reeve/proxy/bifrost-http')
    expect(m.verify).toHaveLength(3)
  })

  it('rejects a wrong schema, a malformed digest and a non-zip extension', () => {
    expect(() => parseComponentManifest({ ...base, schema: 2 })).toThrow(/schema/)
    expect(() => parseComponentManifest({
      ...base,
      artifacts: [{ id: 'x', version: '1', url: 'https://e/x', sha256: 'nope', dest: '~/x' }],
    })).toThrow(/sha256/)
    expect(() => parseComponentManifest({
      ...base,
      extension: { apiVersion: 1, id: 'x', zip: 'https://e/x.tar.gz' },
    })).toThrow(/\.zip/)
  })

  it('requires an absolute or ~/ artifact destination (a relative path would land in cwd)', () => {
    expect(() => parseComponentManifest({
      ...base,
      artifacts: [{ id: 'x', version: '1', url: 'https://e/x', sha256: 'a'.repeat(64), dest: 'x' }],
    })).toThrow(/dest/)
  })
})

describe('plugin entry', () => {
  it('uses the package spec online and the installed directory offline', () => {
    const pkg = parseComponentManifest(base)
    expect(pluginEntryFor(pkg, '/home/user')).toBe('@bd7pil/reeve@0.1.2')
    const dir = parseComponentManifest({ ...base, enginePlugin: { ...base.enginePlugin, kind: 'directory' } })
    expect(pluginEntryFor(dir, '/home/user')).toBe('/home/user/.ocrc/components/reeve/package')
    // ocrc's own install always uses the directory it pushed, even when the
    // manifest's preferred shape is a registry package.
    expect(pluginEntryFor(pkg, '/home/user', 'directory')).toBe('/home/user/.ocrc/components/reeve/package')
  })

  it('returns undefined for a component with no engine plugin', () => {
    expect(pluginEntryFor(parseComponentManifest({ schema: 1, name: 'x', version: '1' }), '/home/user')).toBeUndefined()
  })
})

describe('remote scripts', () => {
  it('unpack keeps the previous tree as .ocrc-bak', () => {
    const script = buildComponentUnpackScript(parseComponentManifest(base), 'reeve-0.1.2.tgz')
    expect(script).toContain('mv "$D" "$D.bak"')
    expect(script).toContain('tar xzf "$T" -C "$D.next"')
    expect(script.indexOf('mv "$D" "$D.bak"')).toBeLessThan(script.indexOf('mv "$D.next" "$D"'))
  })

  it('artifact push verifies the digest before and after the move', () => {
    const sha = 'b'.repeat(64)
    const script = buildArtifactPushScript('~/.reeve/proxy/bifrost-http', sha, '0755')
    expect(script).toContain('$HOME/.reeve/proxy/bifrost-http') // ~ expanded inside the remote shell
    expect(script.match(new RegExp(sha, 'g'))).toHaveLength(2)
    expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('mv "$F.part" "$F"'))
    expect(script).toContain('chmod 0755')
    expect(script).toContain('.ocrc-bak')
  })

  it('artifact probe reports MISSING rather than failing', () => {
    expect(buildArtifactProbeCommand('~/.reeve/proxy/bifrost-http')).toContain('echo MISSING')
  })

  it('extension install logs in, then posts path + grants exactly the declared capabilities', () => {
    const script = buildExtensionInstallScript({ port: 2610, zipPath: '/home/user/.ocrc/components/reeve/reeve.zip', id: 'reeve', capabilities: ['sessions', 'filesystem'] })
    expect(script).toContain('/auth/session')
    expect(script).toContain('/home/user/.ocrc/components/reeve/reeve.zip')
    expect(script).toContain('"granted":["sessions","filesystem"]')
    expect(script).toContain('grep -q \'"id":"reeve"\'')
  })
})

describe('component pins', () => {
  it('reads ops/components.json and lets OCRC_<NAME>_PIN win', () => {
    // Derive the expectation from the pin file: bumping a component version
    // must not require touching this test.
    const pins = JSON.parse(readFileSync(new URL('../../ops/components.json', import.meta.url), 'utf-8')) as {
      components: Record<string, { spec: string }>
    }
    const expected = Object.values(pins.components).map((pin) => pin.spec)
    expect(expected.length).toBeGreaterThan(0)
    expect(defaultComponentSources({})).toEqual(expected)
    expect(defaultComponentSources({ OCRC_REEVE_PIN: '/tmp/reeve.tgz' })[0]).toBe('/tmp/reeve.tgz')
  })

  it('prefers pin.tarball over pin.spec, and pin.spec over name@version', () => {
    // 优先级逐分支（sourcesFromPins 是 defaultComponentSources 的解释规则本体）：
    const pins = {
      components: {
        mixed: { tarball: '/cache/mixed-1.0.0.tgz', spec: '@bd7pil/mixed@1.0.0' },
        pkg: { spec: '@bd7pil/pkg@2.0.0' },
        named: { version: '3.0.0' },
      },
    }
    expect(sourcesFromPins(pins, {})).toEqual([
      '/cache/mixed-1.0.0.tgz',
      '@bd7pil/pkg@2.0.0',
      'named@3.0.0',
    ])
  })

  it('reads ops/components.json and lets OCRC_<NAME>_PIN win', () => {
    // Derive the expectation from the pin file: bumping a component version
    // must not require touching this test.
    const pins = JSON.parse(readFileSync(new URL('../../ops/components.json', import.meta.url), 'utf-8')) as {
      components: Record<string, { spec: string }>
    }
    const expected = Object.values(pins.components).map((pin) => pin.spec)
    expect(expected.length).toBeGreaterThan(0)
    expect(defaultComponentSources({})).toEqual(expected)
    expect(defaultComponentSources({ OCRC_REEVE_PIN: '/tmp/reeve.tgz' })[0]).toBe('/tmp/reeve.tgz')
  })

  it('an env override wins over any pin shape, and a whitespace-only override is not an override', () => {
    const pins = { components: { mixed: { tarball: '/cache/mixed.tgz' } } }
    expect(sourcesFromPins(pins, { OCRC_MIXED_PIN: '  /tmp/override.tgz  ' })).toEqual(['/tmp/override.tgz'])
    expect(sourcesFromPins(pins, { OCRC_MIXED_PIN: '   ' })).toEqual(['/cache/mixed.tgz'])
  })

  it('a pin with no source at all contributes nothing (not a broken empty entry)', () => {
    expect(sourcesFromPins({ components: { hollow: {} } }, {})).toEqual([])
    expect(sourcesFromPins({}, {})).toEqual([])
    expect(defaultComponentSources({})[0]).toBeTruthy()
  })
})

describe('prepareComponent', () => {
  const manifestJson = JSON.stringify(base)

  it('keeps the caller\'s own tarball and deletes the packed one (temporary tracking)', async () => {
    const ocrcHome = mkdtempSync(join(tmpdir(), 'ocrc-comp-home-'))
    const saved = process.env.OCRC_HOME
    process.env.OCRC_HOME = ocrcHome
    const work = mkdtempSync(join(tmpdir(), 'ocrc-comp-work-'))
    // A directory input (provision.json at its root)…
    const dirInput = join(work, 'comp')
    mkdirSync(dirInput, { recursive: true })
    writeFileSync(join(dirInput, 'provision.json'), manifestJson)
    // …and an equivalent user tarball, laid out exactly like `npm pack` and
    // packDirectory both do it: a staging dir with `package/` holding the tree.
    const tar = process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
    const { execFileSync } = await import('node:child_process')
    const staging = join(work, 'stage')
    const pkgDir = join(staging, 'package')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'provision.json'), manifestJson)
    const userTarball = join(work, 'mine.tgz')
    execFileSync(tar, ['-czf', userTarball, '-C', staging, 'package'])
    try {
      // A directory input is packed (the pack is temporary — deleted), the
      // caller's directory stays.
      const fromDir = await prepareComponent(dirInput)
      expect(fromDir.manifest.name).toBe('reeve')
      expect(fromDir.directory).toBe(dirInput)
      expect(existsSync(dirInput)).toBe(true)

      // A user tarball input: the file survives preparation (it is the
      // caller's, not ours to clean up).
      const fromTarball = await prepareComponent(userTarball)
      expect(fromTarball.manifest.version).toBe(base.version)
      expect(existsSync(userTarball)).toBe(true)

      // Both land in the cache under the manifest's name+version.
      const cached = join(ocrcHome, 'component-cache', `reeve-${base.version}.tgz`)
      expect(existsSync(cached)).toBe(true)
      expect(fromDir.tarball).toBe(cached)
      expect(fromTarball.tarball).toBe(cached)
      expect(fromTarball.sha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      process.env.OCRC_HOME = saved
      rmSync(ocrcHome, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects a directory without provision.json and a tarball without package/provision.json', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ocrc-comp-empty-'))
    try {
      await expect(prepareComponent(empty)).rejects.toThrow(/provision\.json/)
      const junk = join(empty, 'junk.tgz')
      writeFileSync(junk, 'not a tarball')
      await expect(prepareComponent(junk)).rejects.toThrow(/provision\.json/)
      expect(existsSync(junk)).toBe(true)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
