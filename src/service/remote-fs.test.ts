import { describe, it, expect } from 'vitest'
import {
  normalizeVirtualPath, isInsideRoots,
  buildListScript, parseListOutput,
  buildReadScript, buildWriteScript, buildStatScript, buildMkdirScript,
  buildGitScript, parseGitStatus,
} from './remote-fs.js'

describe('path guards', () => {
  it('normalizeVirtualPath: absolute only, no .. segments, collapses slashes', () => {
    expect(normalizeVirtualPath('/work/a//b')).toBe('/work/a/b')
    expect(normalizeVirtualPath('work/a')).toBeNull()
    expect(normalizeVirtualPath('/work/../etc')).toBeNull()
    expect(normalizeVirtualPath('/a/../b')).toBeNull()
  })

  it('isInsideRoots: segment-boundary prefix, trailing slashes tolerated', () => {
    expect(isInsideRoots('/work/sub/f.txt', ['/work'])).toBe(true)
    expect(isInsideRoots('/work', ['/work/'])).toBe(true)
    expect(isInsideRoots('/workshop/x', ['/work'])).toBe(false)
    expect(isInsideRoots('/etc/passwd', ['/work', '/home'])).toBe(false)
  })
})

describe('script builders', () => {
  it('list script quotes the path and keys typed lines', () => {
    const s = buildListScript('/work/a b')
    expect(s).toContain(`P='/work/a b'`)
    expect(s).toContain('ERR: not-a-directory')
  })

  it('parseListOutput maps d/f lines, keeps spaces in names', () => {
    const out = parseListOutput(['d src', 'f file one.txt 123', 'f b.bin 0', ''].join('\n'))
    expect(out.entries).toEqual([
      { name: 'src', type: 'dir' },
      { name: 'file one.txt', type: 'file', size: 123 },
      { name: 'b.bin', type: 'file', size: 0 },
    ])
    expect(parseListOutput('ERR: not-a-directory\n').error).toBe('not a directory')
  })

  it('read script caps bytes; write script is atomic with .bak', () => {
    expect(buildReadScript('/w/f', 1000)).toContain('-gt 1000')
    const w = buildWriteScript("/w/f', rm", 'aGk=')
    expect(w.script).toContain(`P='/w/f'\\'', rm'`)
    expect(w.script).toContain('cp -p "$P" "$P.bak"')
    expect(w.script).toContain('mv "$T" "$P"')
    expect(w.stdin).toBe('aGk=')
  })

  it('stat and mkdir quote paths', () => {
    expect(buildStatScript('/w')).toContain(`P='/w'`)
    expect(buildMkdirScript('/w/x')).toContain(`mkdir -p '/w/x'`)
  })
})

describe('git script builders', () => {
  it('status/diff/log run inside quoted root; diff caps output', () => {
    expect(buildGitScript('/r', 'status')).toContain(`cd '/r'`)
    expect(buildGitScript('/r', 'diff', { paths: ['a b.txt'] })).toContain(`-- 'a b.txt'`)
    expect(buildGitScript('/r', 'diff')).toContain('head -c 200000')
    expect(buildGitScript('/r', 'log')).toContain('git log --oneline -n 30')
  })

  it('stage/commit quote paths and message; commit detects nothing-to-commit', () => {
    expect(buildGitScript('/r', 'stage', { paths: ['x'] })).toContain(`git add -- 'x'`)
    const c = buildGitScript('/r', 'commit', { message: "fix: it's broken" })
    expect(c).toContain(`git commit -m 'fix: it'\\''s broken'`)
    expect(c).toContain('nothing-to-commit')
  })

  it('parseGitStatus extracts branch and porcelain entries', () => {
    const r = parseGitStatus('## main...origin/main\n M src/a.ts\n?? new.txt\n')
    expect(r.branch).toBe('main')
    expect(r.entries).toEqual([
      { x: ' ', y: 'M', path: 'src/a.ts' },
      { x: '?', y: '?', path: 'new.txt' },
    ])
    expect(parseGitStatus('ERR: not-a-repo\n').error).toBe('not a git repository')
  })
})
