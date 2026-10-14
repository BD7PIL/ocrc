import { describe, it, expect } from 'vitest'
import {
  resolvePanelConfigPath, resolvePanelAgentsDir,
  inspectConfigSource, extractBridgeSections, deepMerge, buildConfigApplyScript,
  BRIDGE_SECTIONS,
} from './config-bridge'

describe('panel path resolution (mirrors openchamber shared.js)', () => {
  it('OPENCODE_CONFIG_DIR wins; then XDG; then ~/.config/opencode', () => {
    expect(resolvePanelConfigPath({ OPENCODE_CONFIG_DIR: '/x/y' })).toBe('/x/y/opencode.json')
    expect(resolvePanelConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/opencode/opencode.json')
    const p = resolvePanelConfigPath({})
    expect(p.endsWith('opencode.json')).toBe(true)
    expect(resolvePanelAgentsDir({ OPENCODE_CONFIG_DIR: '/x/y' })).toBe('/x/y/agents')
  })
})

describe('inspectConfigSource', () => {
  const fakeFs = (files: Record<string, string>, dirs: string[] = []) => ({
    exists: (p: string) => p in files || dirs.includes(p),
    read: (p: string) => { const c = files[p]; if (c === undefined) throw new Error('enoent'); return c },
    listDir: (p: string) => {
      if (!dirs.includes(p)) throw new Error('enoent')
      return Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1))
    },
    stat: (p: string) => ({ size: (files[p] ?? '').length }),
  })

  it('lists bridge sections and agent md files; skips non-objects', () => {
    const cfgPath = '/panel/opencode.json'
    const agentsDir = '/panel/agents'
    const fs = fakeFs(
      {
        [cfgPath]: JSON.stringify({
          agent: { build: { model: 'x/y' } },
          mcp: { servers: { ctx: { type: 'remote' } } },
          providers: { provA: {}, provB: {} },
          model: 'x/y', // not a section — ignored
          plugin: ['a'], // array — ignored
        }),
        [agentsDir + '/reviewer.md']: '---\nmode: subagent\n---\nreview',
        [agentsDir + '/notes.txt']: 'ignored',
      },
      [agentsDir],
    )
    const r = inspectConfigSource({ OPENCODE_CONFIG_DIR: '/panel' }, fs.exists, fs.read, fs.listDir, fs.stat)
    expect(r.exists).toBe(true)
    expect(r.sections.agent).toEqual(['build'])
    expect(r.sections.mcp).toEqual(['servers'])
    expect(r.sections.providers).toEqual(['provA', 'provB'])
    expect(r.agentFiles).toEqual([{ name: 'reviewer', path: agentsDir + '/reviewer.md', size: 29 }])
  })

  it('reports parseError on unparseable json without throwing', () => {
    const fs = fakeFs({ '/panel/opencode.json': '{not json' })
    const r = inspectConfigSource({ OPENCODE_CONFIG_DIR: '/panel' }, fs.exists, fs.read, fs.listDir, fs.stat)
    expect(r.parseError).toBeTruthy()
  })

  it('missing file → exists=false, empty lists', () => {
    const fs = fakeFs({})
    const r = inspectConfigSource({ OPENCODE_CONFIG_DIR: '/panel' }, fs.exists, fs.read, fs.listDir, fs.stat)
    expect(r.exists).toBe(false)
    expect(r.agentFiles).toEqual([])
  })
})

describe('merge policy (panel wins per leaf, remote-only survives)', () => {
  it('deepMerge preserves remote-only branches and adds panel additions', () => {
    const remote = { provider: { a: { k: 1 } }, agent: { build: { model: 'old' } }, plugins: ['ocrc'] }
    const panel = { agent: { build: { model: 'new' }, reviewer: { mode: 'subagent' } }, mcp: { servers: { s: {} } } }
    const merged = deepMerge(remote, panel) as Record<string, any>
    expect(merged.provider.a.k).toBe(1) // remote-only survives
    expect(merged.agent.build.model).toBe('new') // panel wins
    expect(merged.agent.reviewer.mode).toBe('subagent') // panel addition
    expect(merged.mcp.servers.s).toEqual({}) // panel addition
    expect(merged.plugins).toEqual(['ocrc']) // ocrc-owned rides along
  })

  it('arrays and scalars replace (panel semantics), undefined panel = keep remote', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
    expect(deepMerge({ a: 'x' }, { a: 'y' })).toEqual({ a: 'y' })
    expect(deepMerge({ a: 'x' }, {})).toEqual({ a: 'x' })
  })

  it('extractBridgeSections picks exactly the bridge sections', () => {
    const cfg = { agent: { a: 1 }, agents: { b: 2 }, mcp: { servers: {} }, providers: { p: {} }, provider: { q: {} }, model: 'x', plugins: [] }
    const out = extractBridgeSections(cfg)
    expect(Object.keys(out).sort()).toEqual([...BRIDGE_SECTIONS].sort())
    expect(out.model).toBeUndefined()
  })
})

describe('buildConfigApplyScript', () => {
  it('quotes path, backs up to .ocrc-bak, atomic mv', () => {
    const s = buildConfigApplyScript("/home/u/.config/opencode/opencode.json")
    expect(s).toContain(`P='/home/u/.config/opencode/opencode.json'`)
    expect(s).toContain('cp -p "$P" "$P.ocrc-bak"')
    expect(s).toContain('mv "$T" "$P"')
  })
})
