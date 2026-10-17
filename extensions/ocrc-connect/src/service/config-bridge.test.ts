import { describe, it, expect } from 'vitest'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  resolvePanelConfigPath, resolvePanelAgentsDir,
  inspectConfigSource,
  BRIDGE_SECTIONS,
} from './config-bridge.js'

describe('panel path resolution (mirrors openchamber shared.js)', () => {
  // Expected paths go through `join`: these are paths on the PANEL HOST, so the
  // separator follows whatever platform the service runs on. A literal
  // '/x/y/opencode.json' only ever passed on POSIX.
  it('OPENCODE_CONFIG_DIR wins; then XDG; then ~/.config/opencode', () => {
    expect(resolvePanelConfigPath({ OPENCODE_CONFIG_DIR: '/x/y' })).toBe(join('/x/y', 'opencode.json'))
    expect(resolvePanelConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(join('/xdg', 'opencode', 'opencode.json'))
    const p = resolvePanelConfigPath({})
    expect(p.endsWith('opencode.json')).toBe(true)
    expect(resolvePanelAgentsDir({ OPENCODE_CONFIG_DIR: '/x/y' })).toBe(join('/x/y', 'agents'))
  })

  it('win32: %APPDATA%\\opencode is the fallback when no explicit env is set', () => {
    // The Windows panel host has no XDG layout — the ~/.config fallback left
    // the 配置同步 tab empty on real Windows hosts.
    const p = resolvePanelConfigPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')
    expect(p).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'opencode', 'opencode.json'))
    // XDG still wins over APPDATA (explicit override wins).
    expect(resolvePanelConfigPath({ XDG_CONFIG_HOME: '/xdg', APPDATA: 'C:\\r' }, 'win32')).toBe(join('/xdg', 'opencode', 'opencode.json'))
    // The %APPDATA% branch never fires on POSIX.
    expect(resolvePanelConfigPath({ APPDATA: 'C:\\r' }, 'linux')).toBe(join(homedir(), '.config', 'opencode', 'opencode.json'))
    expect(resolvePanelAgentsDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'opencode', 'agents'))
  })
})

describe('inspectConfigSource', () => {
  const fakeFs = (files: Record<string, string>, dirs: string[] = []) => ({
    exists: (p: string) => p in files || dirs.includes(p),
    read: (p: string) => { const c = files[p]; if (c === undefined) throw new Error('enoent'); return c },
    listDir: (p: string) => {
      if (!dirs.includes(p)) throw new Error('enoent')
      return Object.keys(files).filter((f) => dirname(f) === p).map((f) => basename(f))
    },
    stat: (p: string) => ({ size: (files[p] ?? '').length }),
  })

  it('lists bridge sections and agent md files; skips non-objects', () => {
    const cfgPath = join('/panel', 'opencode.json')
    const agentsDir = join('/panel', 'agents')
    const fs = fakeFs(
      {
        [cfgPath]: JSON.stringify({
          agent: { build: { model: 'x/y' } },
          mcp: { servers: { ctx: { type: 'remote' } } },
          providers: { provA: {}, provB: {} },
          model: 'x/y', // not a section — ignored
          plugin: ['a'], // array — ignored
        }),
        [join(agentsDir, 'reviewer.md')]: '---\nmode: subagent\n---\nreview',
        [join(agentsDir, 'notes.txt')]: 'ignored',
      },
      [agentsDir],
    )
    const r = inspectConfigSource({ OPENCODE_CONFIG_DIR: '/panel' }, fs.exists, fs.read, fs.listDir, fs.stat)
    expect(r.exists).toBe(true)
    expect(r.sections.agent).toEqual(['build'])
    expect(r.sections.mcp).toEqual(['servers'])
    expect(r.sections.providers).toEqual(['provA', 'provB'])
    expect(r.agentFiles).toEqual([{ name: 'reviewer', path: join(agentsDir, 'reviewer.md'), size: 29 }])
  })

  it('reports parseError on unparseable json without throwing', () => {
    const fs = fakeFs({ [join('/panel', 'opencode.json')]: '{not json' })
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

describe('bridge sections', () => {
  // 段白名单还在（读面板宿主的清单要用）；写入路径已改到项目级（D10），
  // 合并与落盘由 config-project.ts 负责并有自己的测试。
  it('covers the sections the panel can offer', () => {
    expect(BRIDGE_SECTIONS).toContain('mcp')
    expect(BRIDGE_SECTIONS).toContain('agents')
  })
})

