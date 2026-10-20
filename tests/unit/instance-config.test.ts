import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthPushScript, buildConfigApplyScript, buildPeerConfigReadScript, diffConfig, parsePeerConfigRead,
  findShadowedKeys, planConfigSync, readLocalConfig, stageConfigTree,
} from '../../src/core/instance-config.js'
import { mergeSticky, renderConfig, stripLiteralSecrets } from '../../src/core/config-merge.js'

/**
 * C1–C4 — the rules a config sync to a peer has to keep, pinned where they can
 * be checked without a peer:
 *   · the peer's own keys survive (deep merge, never a whole-file overwrite);
 *   · v2 `plugins` is a union of peer + local + component entries, while the v1
 *     `plugin` key stays exactly as the peer's own openchamber left it;
 *   · deletions happen only when named, and are reversible (`.ocrc-bak`);
 *   · a hash we could not compute is "cannot tell", never "identical".
 */

const tmp = () => mkdtempSync(join(tmpdir(), 'ocrc-cfg-'))

function localTree(files: Record<string, string>): { dir: string; authPath: string } {
  const dir = tmp()
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return { dir, authPath: join(dir, 'auth.json') }
}

const B64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64').replace(/(.{60})/g, '$1\n')

/** Build a peer state through the real parser (so the wire format is exercised). */
function peerRead(opts: { json?: string; jsonc?: string; auth?: boolean; files?: Array<[string, string]> } = {}) {
  const lines = ['B64_JSON_BEGIN', opts.json ? B64(opts.json) : '', 'B64_JSON_END',
    'B64_JSONC_BEGIN', opts.jsonc ? B64(opts.jsonc) : '', 'B64_JSONC_END',
    `AUTH=${opts.auth ? 'present' : 'missing'}`, 'LIST_BEGIN']
  for (const [hash, rel] of opts.files ?? []) lines.push(`${hash} ${rel}`)
  lines.push('LIST_END')
  return parsePeerConfigRead(lines.join('\n'))
}

/** A peer state for the diff-only tests (no config layers involved). */
function peerPlain(files: Array<[string, string]>, auth = false) {
  return {
    layers: [], effective: {}, layerErrors: [], targetBasename: 'opencode.json',
    authPresent: auth, files: files.map(([hash, rel]) => ({ hash, rel })),
  }
}

describe('peer config read', () => {
  it('parses both layers, the auth flag and the file hashes', () => {
    const state = peerRead({
      json: '{"model":"json-layer"}',
      jsonc: '{"theme":"jsonc-layer"}',
      auth: true,
      files: [['aaaaaaaaaaaaaaaa', 'opencode.json'], ['bbbbbbbbbbbbbbbb', 'skill/local.md'], ['?', 'agent/weird.md']],
    })
    expect(state.authPresent).toBe(true)
    expect(state.layers.map((l) => l.basename)).toEqual(['opencode.json', 'opencode.jsonc'])
    // Source-verified load order: the .jsonc overrides the .json.
    expect(state.effective).toEqual({ model: 'json-layer', theme: 'jsonc-layer' })
    // …and that is why the merged document must be written to the .jsonc.
    expect(state.targetBasename).toBe('opencode.jsonc')
    expect(state.files.map((f) => f.rel)).toEqual(['agent/weird.md', 'opencode.json', 'skill/local.md'])
  })

  it('targets the .json when the peer has no overriding .jsonc', () => {
    expect(peerRead({ json: '{}' }).targetBasename).toBe('opencode.json')
    expect(peerRead({ jsonc: '{}' }).targetBasename).toBe('opencode.jsonc')
  })

  it('reports a missing config and a missing auth file as missing, not as empty', () => {
    const state = peerRead()
    expect(state.layers).toEqual([])
    expect(state.effective).toEqual({})
    expect(state.authPresent).toBe(false)
    expect(state.files).toEqual([])
  })

  it('a layer that does not parse is reported, not silently dropped', () => {
    const state = peerRead({ json: '{oops', jsonc: '{"theme":"t"}' })
    expect(state.layerErrors.join('\n')).toContain('opencode.json')
    expect(state.effective).toEqual({ theme: 't' })
  })

  it('the read script is one round trip and hashes with coreutils', () => {
    const script = buildPeerConfigReadScript()
    expect(script).toContain('sha256sum')
    expect(script).toContain('base64')
    expect(script).toContain('opencode.jsonc')
    expect(script).toContain('B64_JSON_BEGIN')
    expect(script).toContain('B64_JSONC_BEGIN')
  })
})

describe('diff', () => {
  const local = {
    dir: '/l', authPath: '/l/auth.json', authPresent: true,
    layers: [], effective: {}, layerErrors: [],
    files: [
      { rel: 'opencode.json', hash: '1111111111111111' },
      { rel: 'skill/new.md', hash: '2222222222222222' },
      { rel: 'skill/same.md', hash: '3333333333333333' },
    ],
  }

  it('classifies both directions and never guesses at an unknown hash', () => {
    const d = diffConfig(local, peerPlain([
      ['9999999999999999', 'opencode.json'],
      ['3333333333333333', 'skill/same.md'],
      ['4444444444444444', 'agent/old.md'],
    ]))
    expect(d.add).toEqual(['skill/new.md'])
    expect(d.change).toEqual(['opencode.json'])
    expect(d.same).toEqual(['skill/same.md'])
    expect(d.peerOnly).toEqual(['agent/old.md'])
    expect(d.auth).toEqual({ local: true, peer: false })
  })

  it('treats an uncomputable peer hash as unknown, not as identical', () => {
    const d = diffConfig(local, peerPlain([
      ['?', 'opencode.json'],
      ['?', 'skill/new.md'],
      ['3333333333333333', 'skill/same.md'],
    ], true))
    expect(d.unknown.sort()).toEqual(['opencode.json', 'skill/new.md'])
    expect(d.same).toEqual(['skill/same.md'])
    expect(d.change).toEqual([])
  })
})

describe('sync plan', () => {
  it('deep-merges: the peer keeps keys we never mention', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({ provider: { deepseek: { options: { baseURL: 'https://local' } } }, model: 'a/b' }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({
        provider: { deepseek: { options: { baseURL: 'https://peer', apiKey: 'peer-own' } }, ollama: { options: {} } },
        permission: { edit: 'ask' },
      }),
    })
    const plan = planConfigSync(local, peer)
    const merged = plan.merged as Record<string, any>
    expect(merged.model).toBe('a/b')
    expect(merged.permission).toEqual({ edit: 'ask' })            // peer-only key survives
    expect(merged.provider.ollama).toEqual({ options: {} })        // peer-only provider survives
    expect(merged.provider.deepseek.options.baseURL).toBe('https://local') // ours wins on conflict
    expect(merged.provider.deepseek.options.apiKey).toBe('peer-own')       // untouched by us
    expect(plan.configChanged).toBe(true)
    expect(plan.files[0]).toBe('opencode.json')
  })

  it('unions v2 plugins (peer + local + component) and preserves the peer v1 plugin key', () => {
    const managedPlugin = { '@openchamber/managed-tools': [{ tools: ['websearch'] }] }
    const { dir, authPath } = localTree({ 'opencode.json': JSON.stringify({ plugins: ['/ours'], theme: 'dark' }) })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({ json: JSON.stringify({ plugins: ['/peer'], plugin: managedPlugin, model: 'peer-model' }) })
    const plan = planConfigSync(local, peer, { componentPlugins: ['/component'] })
    const merged = plan.merged as Record<string, unknown>
    expect(plan.preservedPluginKey).toBe(true)
    expect(plan.managedPlugins).toEqual(['/component'])
    expect(merged.plugins).toEqual(['/peer', '/ours', '/component'])
    expect(merged.plugin).toEqual(managedPlugin)
    expect(merged.theme).toBe('dark')
    expect(plan.notes.join('\n')).toContain('v1 plugin')
  })

  it('drops local package specs for components the peer loads from a directory', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({
        plugins: [
          '@bd7pil/reeve@0.1.2',
          '@bd7pil/opencode-deep-memory',
          '/home/dev/.ocrc/components/reeve/package',
          '/ours/other',
        ],
      }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({ json: JSON.stringify({ plugins: ['/home/dev/.ocrc/components/reeve/package'] }) })
    const plan = planConfigSync(local, peer, {
      componentPlugins: ['/home/dev/.ocrc/components/reeve/package'],
      componentNames: ['reeve', 'opencode-deep-memory'],
    })
    const merged = plan.merged as Record<string, unknown>
    // The peer can only resolve the directory entry: the package spec would be a
    // plugin that can never load on an air-gapped machine.
    expect(merged.plugins).toEqual(['/home/dev/.ocrc/components/reeve/package', '/ours/other'])
  })

  it('rewrites MCP env secrets to {env:…} and leaves provider keys alone', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({
        mcp: { servers: { gh: { command: 'x', environment: { GITHUB_TOKEN: 'ghp_secret' } } } },
        provider: { deepseek: { options: { apiKey: 'sk-literal' } } },
      }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead()
    const plan = planConfigSync(local, peer)
    const merged = plan.merged as Record<string, any>
    expect(merged.mcp.servers.gh.environment.GITHUB_TOKEN).toBe('{env:GITHUB_TOKEN}')
    // Provider keys belong in auth.json (C3); rewriting them here would break a
    // working provider with a reference nobody defines.
    expect(merged.provider.deepseek.options.apiKey).toBe('sk-literal')
    expect(plan.secretsReplaced).toEqual([{ path: 'mcp.servers.gh.environment.GITHUB_TOKEN', env: 'GITHUB_TOKEN' }])
  })

  it('applies per-peer provider baseURL rewrites only when asked (C2b)', () => {
    const { dir, authPath } = localTree({ 'opencode.json': JSON.stringify({ provider: { deepseek: { options: { baseURL: 'https://public' } } } }) })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead()
    const untouched = planConfigSync(local, peer)
    expect((untouched.merged as Record<string, any>).provider.deepseek.options.baseURL).toBe('https://public')

    const rewritten = planConfigSync(local, peer, { providerBaseUrl: { deepseek: 'http://10.0.0.9:8080' } })
    expect((rewritten.merged as Record<string, any>).provider.deepseek.options.baseURL).toBe('http://10.0.0.9:8080')
    expect(rewritten.baseUrlRewrites).toEqual([{ provider: 'deepseek', from: 'https://public', to: 'http://10.0.0.9:8080' }])
  })

  it('only deletes peer-only files that were explicitly named', () => {
    const { dir, authPath } = localTree({ 'skill/keep.md': 'k' })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerPlain([['x', 'agent/gone.md'], [local.files[0]!.hash, 'skill/keep.md']])
    const planned = planConfigSync(local, peer)
    expect(planned.deletes).toEqual([])
    expect(planned.notes.join('\n')).toContain('不会被动')

    const withDelete = planConfigSync(local, peer, { deletes: ['agent/gone.md', 'agent/never-existed.md'] })
    expect(withDelete.deletes).toEqual(['agent/gone.md'])
  })

  it('says nothing will happen when the peer already matches', () => {
    const { dir, authPath } = localTree({ 'opencode.json': JSON.stringify({ model: 'a/b' }), 'skill/x.md': 'x' })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({ model: 'a/b' }),
      files: [
        [local.files.find((f) => f.rel === 'opencode.json')!.hash, 'opencode.json'],
        [local.files.find((f) => f.rel === 'skill/x.md')!.hash, 'skill/x.md'],
      ],
    })
    const plan = planConfigSync(local, peer)
    expect(plan.configChanged).toBe(false)
    expect(plan.files).toEqual([])
  })

  it('never rewrites a commented peer config by default, and names what will be shadowed', () => {
    // This peer's opencode.jsonc documents platform differences across three
    // machines — its comments are the user's own documentation. Writing JSON
    // over it would silently destroy them, so we land in opencode.json and say
    // which keys the commented layer will keep overriding.
    const { dir, authPath } = localTree({ 'opencode.json': JSON.stringify({ model: 'local', theme: 'local-theme' }) })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({ permission: { edit: 'ask' } }),
      jsonc: '// 三端同步：WSL / VM / Windows\n{\n  "theme": "peer-theme"\n}',
      files: [['h1', 'opencode.json'], ['h2', 'opencode.jsonc']],
    })
    const plan = planConfigSync(local, peer)
    expect(plan.basename).toBe('opencode.json')
    expect(plan.commentsWillBeLost).toBeUndefined()
    expect(plan.shadowed).toEqual(['theme'])
    expect(plan.notes.join('\n')).toContain('注释是你的文档')
    expect(plan.notes.join('\n')).toContain('theme')

    // The explicit opt-in writes the commented file and says the comments go.
    const opted = planConfigSync(local, peer, { preferCommentedTarget: true })
    expect(opted.basename).toBe('opencode.jsonc')
    expect(opted.commentsWillBeLost).toBe(true)
    expect(opted.shadowed).toEqual([])
  })

  it('offers peer-only collection keys as delete candidates and removes only what was named', () => {
    // The panel has no provider delete (upstream ships add/edit/disable), so a
    // sync is the only way to express "remove it" — but never implicitly: the
    // diff offers the candidates, the caller names them.
    const { dir, authPath } = localTree({ 'opencode.json': JSON.stringify({ provider: { mine: { options: {} } } }) })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({
        provider: { mine: { options: {} }, 'peer-only': { options: {} } },
        mcp: { servers: { acc: { type: 'local' } } },
      }),
    })
    const offered = planConfigSync(local, peer)
    expect(offered.keyDeleteCandidates).toEqual([
      { collection: 'mcp.servers', key: 'acc' },
      { collection: 'provider', key: 'peer-only' },
    ])
    expect(offered.keyDeletes.removed).toEqual([])
    expect((offered.merged as Record<string, any>).provider['peer-only']).toBeTruthy()
    expect(offered.notes.join('\n')).toContain('要删得显式勾选')

    const applied = planConfigSync(local, peer, { keyDeletes: ['provider:peer-only', 'provider:never-existed'] })
    expect(applied.keyDeletes.removed).toEqual(['provider:peer-only'])
    expect((applied.merged as Record<string, any>).provider['peer-only']).toBeUndefined()
    expect((applied.merged as Record<string, any>).provider.mine).toBeTruthy()
    expect((applied.merged as Record<string, any>).mcp.servers.acc).toBeTruthy() // not named → kept
    expect(applied.configChanged).toBe(true)
    expect(applied.notes.join('\n')).toContain('按你的选择删除')
    expect(applied.notes.join('\n')).toContain('没有对应项')
  })

  it('findShadowedKeys reports at a depth a person can act on', () => {
    const higher = { provider: { deepseek: { options: { baseURL: 'a' } }, ollama: {} }, model: 'x' }
    const merged = { provider: { deepseek: { options: { baseURL: 'b' } }, ollama: {} }, model: 'x', theme: 't' }
    expect(findShadowedKeys(higher, merged)).toEqual(['provider.deepseek'])
  })

  it('writes an uncommented peer .jsonc, which is the layer that wins', () => {
    // A peer-side opencode.jsonc overrides its opencode.json (source-verified
    // load order), so a merged document written to the .json would be silently
    // overridden. With no comments to lose, we write the .jsonc.
    const { dir, authPath } = localTree({ 'opencode.json': JSON.stringify({ model: 'local' }) })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({ permission: { edit: 'ask' } }),
      jsonc: JSON.stringify({ theme: 'dark' }),
      files: [['h1', 'opencode.json'], ['h2', 'opencode.jsonc']],
    })
    const plan = planConfigSync(local, peer)
    expect(plan.basename).toBe('opencode.jsonc')
    expect(plan.files).toEqual(['opencode.jsonc'])
    expect(plan.merged).toMatchObject({ model: 'local', permission: { edit: 'ask' }, theme: 'dark' })
    expect(plan.notes.join('\n')).toContain('低优先级层')
  })
})

describe('staging and the peer-side scripts', () => {
  it('stages only what changed, with the merged config in place of the local one', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({ model: 'local' }),
      'skill/a.md': 'a',
      'agent/b.md': 'b',
      'command/c.md': 'c',
    })
    const local = readLocalConfig({ dir, authPath })
    const dest = tmp()
    const staged = stageConfigTree({
      sourceDir: local.dir,
      destDir: dest,
      entries: ['skill'],
      mergedConfig: { basename: 'opencode.json', content: renderConfig({ model: 'merged' }) },
    })
    expect(staged.sort()).toEqual(['opencode.json', 'skill'])
    expect(JSON.parse(readFileSync(join(dest, 'opencode.json'), 'utf-8')).model).toBe('merged')
    expect(readFileSync(join(dest, 'skill/a.md'), 'utf-8')).toBe('a')
    expect(() => readFileSync(join(dest, 'agent/b.md'), 'utf-8')).toThrow()
  })

  it('the apply script backs up before overwriting and before deleting', () => {
    const script = buildConfigApplyScript(["agent/old file.md", "skill/o'brien.md"])
    expect(script).toContain('$tgt.ocrc-bak')
    expect(script).toContain('rm -f "$tgt"')
    // Names come from the peer's own listing: a space or a quote must not turn
    // into a second command.
    expect(script).toContain(`for rel in 'agent/old file.md' 'skill/o'\\''brien.md'; do`)
    const plain = buildConfigApplyScript()
    expect(plain).not.toContain('rm -f "$tgt"')
  })

  it('the auth push writes 0600 and keeps one backup', () => {
    const script = buildAuthPushScript()
    expect(script).toContain('chmod 600 "$T"')
    expect(script).toContain('.ocrc-bak')
    expect(script).toContain('cat > "$T"')   // content arrives on stdin
  })
})

describe('the merge engine itself', () => {
  it('arrays and scalars are replaced whole, objects merge leaf-wise', () => {
    expect(mergeSticky({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { c: 9 } }))
      .toEqual({ a: [3], b: { c: 9, d: 2 } })
  })

  it('an undefined value means "leave it alone"', () => {
    expect(mergeSticky({ a: 1 }, { a: undefined as never })).toEqual({ a: 1 })
  })

  it('stripLiteralSecrets only touches MCP environment keys that look like credentials', () => {
    const { config, replaced } = stripLiteralSecrets({
      mcp: { servers: { s: { environment: { TOKEN: 'x', HOSTNAME: 'h', ALREADY: '{env:ALREADY}' } } } },
    })
    const env = (config.mcp as Record<string, any>).servers.s.environment
    expect(env.TOKEN).toBe('{env:TOKEN}')
    expect(env.HOSTNAME).toBe('h')
    expect(env.ALREADY).toBe('{env:ALREADY}')
    expect(replaced).toHaveLength(1)
  })
})
