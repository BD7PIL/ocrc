import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { mergeDiscoveries, scanSource, toggleSkill } from '../../src/core/skills-manager.js'

describe('mergeDiscoveries', () => {
  it('flags the same name from two sources as conflict', () => {
    const { skills, conflicts } = mergeDiscoveries([
      { source: '/a', entries: [{ name: 'demo', source: '/a', path: '/a/demo' }] },
      { source: '/b', entries: [{ name: 'demo', source: '/b', path: '/b/demo' }, { name: 'other', source: '/b', path: '/b/other' }] },
    ])
    expect(conflicts).toEqual(['demo'])
    expect(skills.filter((s) => s.name === 'demo')).toHaveLength(2)
    expect(skills.every((s) => s.conflict === (s.name === 'demo'))).toBe(true)
  })
})

describe('scanSource', () => {
  it('reads only dirs containing SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'))
    mkdirSync(join(root, 'good'))
    writeFileSync(join(root, 'good', 'SKILL.md'), '---\ndescription: Demo skill\n---\nbody')
    mkdirSync(join(root, 'empty'))
    writeFileSync(join(root, 'loose.txt'), 'x')
    const entries = scanSource(root)
    expect(entries.map((e) => e.name)).toEqual(['good'])
    expect(entries[0]!.description).toBe('Demo skill')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('toggleSkill', () => {
  it('symlinks on enable, removes on disable, refuses to remove foreign skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    const source = mkdtempSync(join(tmpdir(), 'src-'))
    mkdirSync(join(source, 'demo'))
    writeFileSync(join(source, 'demo', 'SKILL.md'), 'x')

    const on = toggleSkill(home, 'demo', source, true)
    expect(on.ok).toBe(true)
    const link = join(home, '.config', 'opencode', 'skills', 'demo')
    expect(existsSync(link)).toBe(true)

    const foreign = toggleSkill(home, 'demo', '/elsewhere', false)
    expect(foreign.ok).toBe(false) // not this source's symlink — refuse

    const off = toggleSkill(home, 'demo', source, false)
    expect(off.ok).toBe(true)
    expect(existsSync(link)).toBe(false)
    rmSync(source, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
})
