import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  buildAuthSyncProbeScript, buildAuthPushScript, buildConfigApplyScript, buildEngineCredentialPushScript, buildPeerConfigReadScript,
  buildPeerPullScript, decideAuthSyncV2, enginePushEntries, extractConfigTar, gunzipCapped, isSafeConfigRel,
  parseAuthSyncProbe, parseEngineCredentialPush, parsePeerConfigRead, parsePullFailures, parsePullSize,
  diffConfig,
  findShadowedKeys, planConfigSync, readLocalConfig, stageConfigFiles,
} from '../../src/core/instance-config.js'
import { mergeSticky, renderConfig, stripLiteralSecrets } from '../../src/core/config-merge.js'
import { compileIgnoreMatcher, sanitizeIgnorePaths } from '../../src/utils/ignore-patterns.js'

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

  it('hashes in batched parallel form and keeps a per-file fallback', () => {
    const script = buildPeerConfigReadScript()
    // Fast path: one sha256sum per 50 files, 4 workers, joined back against the
    // find list so unreadable files still surface as `?` instead of vanishing.
    expect(script).toContain('xargs -0 -r -n50 -P4 sha256sum')
    expect(script).toContain('mktemp')
    expect(script).toContain('$0 in h')
    // Floor fallback: the original per-file loop survives for mktemp-less hosts.
    expect(script).toContain('while IFS= read -r rel')
  })

  it('tolerates any whitespace between hash and path (raw sha256sum lines)', () => {
    const state = parsePeerConfigRead(['LIST_BEGIN', `aaaaaaaaaaaaaaaa  skill/two spaces.md`, 'LIST_END'].join('\n'))
    expect(state.files).toEqual([{ hash: 'aaaaaaaaaaaaaaaa', rel: 'skill/two spaces.md' }])
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

  it('without componentNames the local package specs travel untouched (the dedupe is opt-in)', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({ plugins: ['@bd7pil/reeve@0.1.2', '/ours/other'] }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({ json: JSON.stringify({ plugins: ['/home/dev/.ocrc/components/reeve/package'] }) })
    const plan = planConfigSync(local, peer, {
      componentPlugins: ['/home/dev/.ocrc/components/reeve/package'],
    })
    const merged = plan.merged as Record<string, unknown>
    // 名单为空 = 不知道对端会从目录加载什么 → 一个条目都不动。
    // 过滤必须是调用方显式给的（否则本机自己的包规格会被悄悄丢掉）。
    expect(merged.plugins).toEqual([
      '/home/dev/.ocrc/components/reeve/package',
      '@bd7pil/reeve@0.1.2',
      '/ours/other',
    ])
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

  it('rewrites the v2 plural shape too: providers.<id>.settings.baseURL (C2b)', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({
        providers: {
          reeve: { package: '@ai-sdk/openai-compatible', settings: { baseURL: 'http://127.0.0.1:18080/v1' } },
          'lmuai-glm': { package: '@ai-sdk/openai-compatible', settings: { baseURL: 'https://api.lmuai.com/v1' } },
        },
      }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead()

    // 不点名就不动
    const untouched = planConfigSync(local, peer)
    const untouchedProviders = (untouched.merged as Record<string, any>).providers
    expect(untouchedProviders['lmuai-glm'].settings.baseURL).toBe('https://api.lmuai.com/v1')
    expect(untouched.baseUrlRewrites).toEqual([])

    // 点名只改指定的那一家，另一家（reeve 的本机回环端点）原样
    const rewritten = planConfigSync(local, peer, { providerBaseUrl: { 'lmuai-glm': 'http://10.0.0.9:8080/v1' } })
    const merged = (rewritten.merged as Record<string, any>).providers
    expect(merged['lmuai-glm'].settings.baseURL).toBe('http://10.0.0.9:8080/v1')
    expect(merged.reeve.settings.baseURL).toBe('http://127.0.0.1:18080/v1')
    expect(rewritten.baseUrlRewrites).toEqual([{ provider: 'lmuai-glm', from: 'https://api.lmuai.com/v1', to: 'http://10.0.0.9:8080/v1' }])
  })

  it('rewrites the same id in both shapes and reports each (mixed legacy + v2)', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({
        provider: { deepseek: { options: { baseURL: 'https://old.example' } } },
        providers: { deepseek: { package: '@ai-sdk/openai-compatible', settings: { baseURL: 'https://new.example/v1' } } },
      }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead()
    const rewritten = planConfigSync(local, peer, { providerBaseUrl: { deepseek: 'http://10.0.0.9:8080' } })
    const merged = rewritten.merged as Record<string, any>
    expect(merged.provider.deepseek.options.baseURL).toBe('http://10.0.0.9:8080')
    expect(merged.providers.deepseek.settings.baseURL).toBe('http://10.0.0.9:8080')
    expect(rewritten.baseUrlRewrites).toEqual([
      { provider: 'deepseek', from: 'https://new.example/v1', to: 'http://10.0.0.9:8080' },
      { provider: 'deepseek', from: 'https://old.example', to: 'http://10.0.0.9:8080' },
    ])
  })

  it('offers peer-only keys in the v2 providers collection for explicit deletion', () => {
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({
        providers: { reeve: { package: '@ai-sdk/openai-compatible', settings: { baseURL: 'http://127.0.0.1:18080/v1' } } },
      }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({
        provider: { 'lmuai-glm': { options: { baseURL: 'https://api.lmuai.com/v1' } } },
        providers: { 'stale-relay': { package: '@ai-sdk/openai-compatible', settings: { baseURL: 'http://10.9.9.9:1/v1' } } },
      }),
    })
    const plan = planConfigSync(local, peer)
    const offered = plan.keyDeleteCandidates.map((c) => `${c.collection}:${c.key}`)
    expect(offered).toContain('provider:lmuai-glm')
    expect(offered).toContain('providers:stale-relay')

    // 显式点名才删（C2）；删除后对端不再有这一条
    const merged = planConfigSync(local, peer, { keyDeletes: ['providers:stale-relay'] }).merged as Record<string, any>
    expect(merged.providers['stale-relay']).toBeUndefined()
    expect(merged.providers.reeve).toBeDefined()
  })

  it('syncs the GATE config directory (~/.config/opencode/reeve/) as a declaration', () => {
    // 拆 Bifrost 之后，reeve 的链/策略在 ~/.config/opencode/reeve/fallback.jsonc —— 它必须随 sync 走，
    // 否则对端的 GATE 只能落回打包默认（两端行为不同）。台账/快照在 ~/.reeve/，**不进** sync。
    const { dir, authPath } = localTree({
      'reeve/fallback.jsonc': '{ "schema": 1 }',
      '.reeve/gate.jsonl': '{"ts":"x"}',
    })
    const local = readLocalConfig({ dir, authPath })
    const rels = local.files.map((f) => f.rel).sort()
    expect(rels).toContain('reeve/fallback.jsonc')
    expect(rels).not.toContain('.reeve/gate.jsonl')
  })

  it('stages through links: a junctioned entry travels as real files (dereference)', () => {
    // 本机把 `reeve/` 软链到仓库（junction）时的形状：对端拿到必须是**真目录** ——
    // 对端没有这个链接目标，而 Windows 上照搬符号链接还要提权（EPERM，实测踩到）。
    const { dir, authPath } = localTree({ 'real-reeve/fallback.jsonc': '{ "schema": 1 }' })
    try {
      symlinkSync(join(dir, 'real-reeve'), join(dir, 'reeve'), 'junction')
    } catch (err) {
      // 少数环境（无权限/容器）建不了链接：跳过而不是红
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return
      throw err
    }
    const local = readLocalConfig({ dir, authPath })
    const staging = mkdtempSync(join(tmpdir(), 'ocrc-stage-'))
    const staged = stageConfigFiles({ sourceDir: dir, destDir: staging, files: local.files.map((f) => f.rel) })
    expect(staged).toContain('reeve/fallback.jsonc')
    const copied = join(staging, 'reeve', 'fallback.jsonc')
    expect(existsSync(copied)).toBe(true)
    expect(readFileSync(copied, 'utf8')).toContain('schema')
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

  it('reports peer-only keys across the whole pushed surface, and deletes by any dot path', () => {
    // 起因（2026-10 实况）：v1 时代留在对端的两枚键（compaction.tail_turns、顶层
    // subagent_depth）不在任何集合里，于是每次 sync 都"看不见"地活着。报告面补齐到
    // 整份文档，但删除仍然**只报告、永远显式**（C2 不变）。
    const { dir, authPath } = localTree({
      'opencode.json': JSON.stringify({ compaction: { auto: true }, nested: { a: { b: {} } }, theme: 'x' }),
    })
    const local = readLocalConfig({ dir, authPath })
    const peer = peerRead({
      json: JSON.stringify({
        compaction: { auto: true, tail_turns: 2 },
        nested: { a: { b: { c: 1 } } },
        subagent_depth: 1,
        peerBlock: { any: { thing: 1 } },
        theme: 'x',
      }),
    })
    const offered = planConfigSync(local, peer)
    // 深度 ≤ 2 才报（可操作的粒度）；只在远端的容器按容器本身报（删它 = 删整块）
    expect(offered.keyDeleteCandidates).toEqual([
      { collection: '', key: 'peerBlock' },
      { collection: '', key: 'subagent_depth' },
      { collection: 'compaction', key: 'tail_turns' },
    ])
    expect((offered.merged as Record<string, any>).compaction.tail_turns).toBe(2) // 默认只报告，不自动删

    // 显式点名才删；`:` 与 `.` 都是路径分隔符；没点名的一律留着
    const applied = planConfigSync(local, peer, {
      keyDeletes: ['compaction.tail_turns', 'subagent_depth', 'nested.a.b.c', 'nope.nothing'],
    })
    expect(applied.keyDeletes.removed).toEqual(['compaction.tail_turns', 'subagent_depth', 'nested.a.b.c'])
    expect((applied.merged as Record<string, any>).compaction.tail_turns).toBeUndefined()
    expect((applied.merged as Record<string, any>).compaction.auto).toBe(true) // 兄弟键不动
    expect((applied.merged as Record<string, any>).subagent_depth).toBeUndefined()
    expect((applied.merged as Record<string, any>).peerBlock).toBeTruthy() // 未点名 → 留着
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
    const staged = stageConfigFiles({
      sourceDir: local.dir,
      destDir: dest,
      files: ['skill/a.md', 'opencode.json'],
      mergedConfig: { basename: 'opencode.json', content: renderConfig({ model: 'merged' }) },
    })
    expect(staged.sort()).toEqual(['opencode.json', 'skill/a.md'])
    expect(JSON.parse(readFileSync(join(dest, 'opencode.json'), 'utf-8')).model).toBe('merged')
    expect(readFileSync(join(dest, 'skill/a.md'), 'utf-8')).toBe('a')
    expect(() => readFileSync(join(dest, 'agent/b.md'), 'utf-8')).toThrow()
  })

  it('staging never copies the raw local config doc — only the merged one', () => {
    const { dir } = localTree({ 'opencode.json': JSON.stringify({ model: 'raw-local' }) })
    const dest = tmp()
    const staged = stageConfigFiles({
      sourceDir: dir,
      destDir: dest,
      files: ['opencode.json', 'skill/x.md'],
      mergedConfig: { basename: 'opencode.json', content: renderConfig({ model: 'merged' }) },
    })
    expect(staged).toEqual(['opencode.json'])
    expect(JSON.parse(readFileSync(join(dest, 'opencode.json'), 'utf-8')).model).toBe('merged')
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

describe('auth 漂移探测 v2（引擎 DB 凭据为准，明文不出对端）', () => {
  const FP = 'a'.repeat(12)
  const FP2 = 'b'.repeat(12)

  it('探测脚本：定位引擎走 /proc；密码只进对端 env；指纹化 node 脚本 base64 内嵌', () => {
    const s = buildAuthSyncProbeScript('24.22.0')
    expect(s).toContain('engine/opencode serve')
    expect(s).toContain('/proc/$PID/environ')
    expect(s).toContain('OPENCODE_SERVER_PASSWORD')
    expect(s).toContain('api/credential')
    // 引擎没跑/没密码/缺 runtime 都要如实报，不许伪装成 drift
    expect(s).toContain("echo 'ENGINE=not-running'")
    expect(s).toContain("echo 'ENGINE=no-password'")
    expect(s).toContain("echo 'ENGINE=runtime-missing'")
    // 明文 key 绝不回传：curl 输出直管道给对端 node，脚本里没有 cat auth.json
    expect(s).toContain('| "$N" -e')
    expect(s).not.toContain(`cat "$A"`)
  })

  it('推送脚本：凭据走 stdin（不进命令行/ps）；推送器 base64 内嵌', () => {
    const s = buildEngineCredentialPushScript('24.22.0')
    expect(s).not.toMatch(/apiKey|sk-/) // 命令行里不该出现 key 形态
    // node 推送器经 env 拿端口与密码，本体 base64 内嵌（含 api/credential 调用）
    expect(s).toContain('OC_PW=')
    expect(s).toContain('OC_PORT=')
    expect(s).toContain('base64 -d')
  })

  it('探测输出解析：AUTHFILE/ENGINE/CRED 三类行 + 容错', () => {
    const view = parseAuthSyncProbe([
      'AUTHFILE 5a3f43f632ab' + '0'.repeat(52),
      '1770000000',
      'ENGINE=running',
      `CRED deepseek ${FP} 35 5499`,
      `CRED lmuai-glm ${FP2} 67 0a9c`,
      'CRED wechat no-key(oauth)',
    ].join('\n'))
    expect(view.authFile && view.authFile !== 'missing' ? view.authFile.sha : undefined).toHaveLength(64)
    expect(view.engine).toBe('running')
    expect(view.creds).toEqual([
      { id: 'deepseek', fp: FP, len: 35, tail4: '5499' },
      { id: 'lmuai-glm', fp: FP2, len: 67, tail4: '0a9c' },
      { id: 'wechat' },
    ])
    const downView = parseAuthSyncProbe('AUTHFILE=MISSING\nENGINE=not-running')
    expect(downView.authFile).toBe('missing')
    expect(downView.engine).toBe('not-running')
    expect(parseAuthSyncProbe('ENGINE=running\nCREDS parse-fail').credsParseFail).toBe(true)
    expect(parseAuthSyncProbe('').engine).toBe('probe-fail')
  })

  it('推送输出解析：OK/ERR/WARN/ENGINE 状态', () => {
    const r = parseEngineCredentialPush('ENGINE=running\nOK deepseek\nOK lmuai-glm\nERR wawapi HTTP 500\nPUSH parse-fail')
    expect(r.engine).toBe('running')
    expect(r.updated).toEqual(['deepseek', 'lmuai-glm'])
    expect(r.failed).toContainEqual({ id: 'wawapi', reason: 'HTTP 500' })
    expect(r.failed).toContainEqual({ id: '(payload)', reason: '推送载荷解析失败' })
    expect(parseEngineCredentialPush('ENGINE=not-running').engine).toBe('not-running')
  })

  it('v2 决策表：引擎没跑=unknown；旧 key/缺行=drift 点名；全等=match；对端多出不动', () => {
    const running = (creds: Array<{ id: string; fp?: string; len?: number; tail4?: string }>) => ({ authFile: undefined, engine: 'running' as const, creds })
    // 引擎没跑：不是 drift 也不是 match
    for (const engine of ['not-running', 'no-password', 'runtime-missing', 'probe-fail'] as const) {
      const v = decideAuthSyncV2({ local: [{ id: 'deepseek', fp: FP }], probe: { authFile: undefined, engine, creds: [] } })
      expect(v.sync).toBe('unknown')
    }
    expect(decideAuthSyncV2({ local: [{ id: 'deepseek', fp: FP }], probe: { authFile: undefined, engine: 'running', creds: [], credsParseFail: true } }).sync).toBe('unknown')
    // 旧 key（EL7 实证形态）：fp 不等 → drift 且点名带尾号
    const stale = decideAuthSyncV2({ local: [{ id: 'deepseek', fp: FP }], probe: running([{ id: 'deepseek', fp: FP2, len: 35, tail4: '5499' }]) })
    expect(stale.sync).toBe('drift')
    expect(stale.reason).toContain('deepseek')
    expect(stale.reason).toContain('5499')
    // 引擎里没有该 provider → drift
    const missing = decideAuthSyncV2({ local: [{ id: 'deepseek', fp: FP }], probe: running([{ id: 'other', fp: FP }]) })
    expect(missing.sync).toBe('drift')
    expect(missing.reason).toContain('引擎里没有')
    // 全等 → match；引擎里多出的（对端自建）不算 drift，reason 报备
    const ok = decideAuthSyncV2({ local: [{ id: 'deepseek', fp: FP }], probe: running([{ id: 'deepseek', fp: FP }, { id: 'wawapi-glm', fp: FP2 }]) })
    expect(ok.sync).toBe('match')
    expect(ok.reason).toContain('1 个对端自建')
  })

  it('enginePushEntries：type=api 才推，oauth 跳过点名', () => {
    const raw = JSON.stringify({
      deepseek: { type: 'api', key: 'k1' },
      github: { type: 'oauth', access: 'x', refresh: 'y' },
      nokey: { type: 'api' },
    })
    const { providers, skippedOauth } = enginePushEntries(raw)
    expect(providers).toEqual([{ id: 'deepseek', key: 'k1' }])
    expect(skippedOauth).toEqual(['github', 'nokey'])
    expect(() => enginePushEntries('not-json')).toThrow()
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

// ── 0.11: ignore table ────────────────────────────────────────────────────────

describe('ignore patterns', () => {
  it('matches directory rules at the root and at any depth with the leading **', () => {
    const m = compileIgnoreMatcher(['**/__pycache__/'])
    expect(m('skills/x/scripts/__pycache__/tml.pyc')).toBe(true)
    expect(m('__pycache__/a.pyc')).toBe(true)
    expect(m('skills/x/scripts/__pycache__')).toBe(false) // files only reach us
    expect(m('skills/x/SKILL.md')).toBe(false)
  })

  it('a slash-containing directory rule anchors at the root', () => {
    const m = compileIgnoreMatcher(['skills/ppt-master/'])
    expect(m('skills/ppt-master/SKILL.md')).toBe(true)
    expect(m('other/skills/ppt-master/SKILL.md')).toBe(false)
  })

  it('a bare directory name matches at any depth (gitignore semantics)', () => {
    const m = compileIgnoreMatcher(['__pycache__/'])
    expect(m('a/b/__pycache__/x.pyc')).toBe(true)
    expect(m('__pycache__/x.pyc')).toBe(true)
  })

  it('exact root files, any-depth names and single-segment wildcards', () => {
    const m = compileIgnoreMatcher(['AGENTS.md', '**/tokenscope.md', 'command/exact.md'])
    expect(m('AGENTS.md')).toBe(true)
    expect(m('command/AGENTS.md')).toBe(true) // no slash in the pattern → any depth
    expect(m('command/tokenscope.md')).toBe(true)
    expect(m('a/deep/tokenscope.md')).toBe(true)
    expect(m('command/exact.md')).toBe(true)
    expect(m('other/command/exact.md')).toBe(false) // interior slash → rooted
  })

  it('an empty table matches nothing', () => {
    const m = compileIgnoreMatcher([])
    expect(m('__pycache__/x.pyc')).toBe(false)
  })

  it('sanitize: posix separators, foo/** folds to the directory rule, junk dropped', () => {
    const windowsStyle = 'reeve' + String.fromCharCode(92) + 'fallback.jsonc'
    expect(sanitizeIgnorePaths([windowsStyle, 'skills/big/**', '/abs/path', 'a/../b', '**', '', 'skills/big/**']))
      .toEqual(['reeve/fallback.jsonc', 'skills/big/'])
  })
})


// ── 0.11: pull (peer → control side) ─────────────────────────────────────────

describe('pull scripts and tar parsing', () => {
  it('isSafeConfigRel rejects everything that could walk out or smuggle a drive', () => {
    const backslash = 'a' + String.fromCharCode(92) + 'b'
    for (const bad of ['', '..', '../x', 'a/../../b', '/abs', 'C:/x', backslash, 'a//b', 'a/', 'a/.', './a']) {
      expect(isSafeConfigRel(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const good of ['AGENTS.md', 'skills/a/b/c.md', 'skills/with space.md', '.directory']) {
      expect(isSafeConfigRel(good)).toBe(true)
    }
  })

  it('the pull script quotes paths, reports size first, and streams tar only when real', () => {
    const real = buildPeerPullScript(["skills/a b.md", "command/t'x.md"])
    expect(real).toContain('D="$HOME/.config/opencode"')
    expect(real).toContain("'skills/a b.md'")
    // A quote inside a path must not become a second command: shell-escaped as '\''.
    expect(real).toMatch(/'command\/t'\\''x\.md'/)
    expect(real).toContain('PULL_SIZE')
    expect(real).toContain('tar czf -')
    const dry = buildPeerPullScript(['AGENTS.md'], { dryRun: true })
    expect(dry).toContain('PULL_SIZE')
    expect(dry).not.toContain('tar czf -')
  })

  it('parsePullSize splits the preamble from the gzip body; failures name the missing paths', () => {
    const { bytes, gzip } = parsePullSize(Buffer.from(`PULL_SIZE 4096\nxxxxxxxx`, 'latin1'))
    expect(bytes).toBe(4096)
    expect(gzip.toString('latin1')).toBe('xxxxxxxx')
    expect(parsePullFailures('PULL_MISSING skills/gone.md\nPULL_ERR boom')).toBe('对端已不存在：skills/gone.md；boom')
  })

  /** Minimal GNU-tar writer: exactly the format the parser accepts (ustar
   *  header, GNU longname for >100-char names, 512 alignment, end blocks). */
  function tarOf(entries: Array<{ name: string; content?: Buffer; type?: string }>): Buffer {
    const blocks: Buffer[] = []
    const padTo512 = (data: Buffer): Buffer[] => {
      const p = (512 - (data.length % 512)) % 512
      return p > 0 ? [data, Buffer.alloc(p)] : [data]
    }
    const headerFor = (name: string, size: number, type: string): Buffer => {
      const h = Buffer.alloc(512)
      h.write(name.slice(0, 100), 0, 'utf-8')
      h.write('0000644\0', 100, 'ascii')
      h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
      h.write(type, 156, 'ascii')
      h.write('ustar ', 257, 'ascii')
      let sum = 0
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
      return h
    }
    for (const e of entries) {
      let name = e.name
      if (name.length >= 100) {
        const data = Buffer.from(`${name}\0`, 'utf-8')
        blocks.push(headerFor('././@LongLink', data.length, 'L'), ...padTo512(data))
        name = name.slice(0, 99)
      }
      const content = e.content ?? Buffer.alloc(0)
      blocks.push(headerFor(name, e.type === '5' ? 0 : content.length, e.type ?? '0'))
      if (e.type !== '5') blocks.push(...padTo512(content))
    }
    blocks.push(Buffer.alloc(1024))
    return Buffer.concat(blocks)
  }

  it('extracts regular files, honors GNU longname, skips links and out-of-scope entries', () => {
    const longName = `skills/${'very/'.repeat(30)}deep.md`
    const tar = tarOf([
      { name: 'skills/a.md', content: Buffer.from('hello') },
      { name: longName, content: Buffer.from('deep!') },
      { name: 'skills/', type: '5' },
      { name: 'a/../../evil.md', content: Buffer.from('x') },
      { name: 'elsewhere/x.md', content: Buffer.from('y') },
    ])
    const r = extractConfigTar(tar, ['skills'])
    expect(r.files.map((f) => f.rel).sort()).toEqual([longName, 'skills/a.md'].sort())
    expect(r.files.find((f) => f.rel === 'skills/a.md')!.content.toString()).toBe('hello')
    expect(r.files.find((f) => f.rel === longName)!.content.toString()).toBe('deep!')
    expect(r.dirs).toContain('skills')
    const kinds = r.skipped.map((s) => s.type)
    expect(kinds).toContain('unsafe-name')
    expect(kinds).toContain('out-of-scope')
  })

  it('a corrupted header fails loudly instead of half-applying', () => {
    const tar = tarOf([{ name: 'skills/a.md', content: Buffer.from('hello') }])
    tar[10] = tar[10]! ^ 0xff
    expect(() => extractConfigTar(tar, ['skills'])).toThrow(/校验失败/)
  })

  it('gunzipCapped round-trips what gzipSync produced', () => {
    expect(gunzipCapped(gzipSync(Buffer.from('round-trip'))).toString()).toBe('round-trip')
  })
})
