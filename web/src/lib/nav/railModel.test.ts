import { describe, it, expect } from 'vitest'
import {
  isRemoteSession,
  remoteHostOf,
  repoName,
  matchesQuery,
  groupByProject,
  partitionTime,
  type RailGroup,
} from './railModel.js'
import type { SessionSummary } from '../api/types.js'

function s(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { title: '', lastActiveAt: 0, unread: false, ...over } as SessionSummary
}

const local = (id: string, dir: string | undefined, at: number, title = ''): SessionSummary =>
  s({ id, directory: dir, lastActiveAt: at, title, backendId: 'opencode' })
const remote = (id: string, host: string, at: number, dir?: string, title = ''): SessionSummary =>
  s({ id, directory: dir, lastActiveAt: at, title, backendId: `remote:${host}` })

describe('remote/session predicates', () => {
  it('cloud icon rides the remote: backendId prefix; host extracted', () => {
    expect(isRemoteSession(remote('a', 'box.lan', 1))).toBe(true)
    expect(isRemoteSession(local('a', '/x', 1))).toBe(false)
    expect(isRemoteSession(s({ id: 'a', lastActiveAt: 1 }))).toBe(false)
    expect(remoteHostOf(remote('a', 'box.lan', 1))).toBe('box.lan')
    expect(remoteHostOf(local('a', '/x', 1))).toBeUndefined()
  })

  it('repoName takes the basename and strips trailing slashes', () => {
    expect(repoName('/home/u/proj')).toBe('proj')
    expect(repoName('/home/u/proj/')).toBe('proj')
    expect(repoName(undefined)).toBe('')
  })
})

describe('matchesQuery', () => {
  const row = remote('ses_abcd1234', 'box.lan', 1, '/home/u/ocrc', 'Fix WS reconnect')
  it('matches title / project / host / short id, case-insensitive', () => {
    expect(matchesQuery(row, 'reconnect')).toBe(true)
    expect(matchesQuery(row, 'OCRC')).toBe(true)
    expect(matchesQuery(row, 'BOX')).toBe(true)
    expect(matchesQuery(row, 'abcd1234')).toBe(true)
    expect(matchesQuery(row, 'nope')).toBe(false)
  })
  it('blank query matches everything', () => {
    expect(matchesQuery(row, '  ')).toBe(true)
  })
})

describe('groupByProject', () => {
  it('groups by directory basename, groups and rows most-recent-first', () => {
    const rows = [
      local('a', '/w/alpha', 100),
      local('b', '/w/beta', 300),
      local('c', '/w/alpha', 200),
    ]
    const groups = groupByProject(rows)
    expect(groups.map((g) => g.label)).toEqual(['beta', 'alpha'])
    expect(groups[1].rows.map((r) => r.id)).toEqual(['c', 'a'])
  })

  it('directory-less remote sessions group under their host with the cloud flag', () => {
    const rows = [
      remote('r1', 'box.lan', 500),
      remote('r2', 'box.lan', 100),
      remote('r3', 'other.lan', 300),
      local('l1', '/w/alpha', 50),
    ]
    const groups = groupByProject(rows)
    const box = groups.find((g) => g.remoteHost === 'box.lan') as RailGroup
    expect(box.remote).toBe(true)
    expect(box.rows.map((r) => r.id)).toEqual(['r1', 'r2'])
    // mixed group: directory present wins over remote-ness
    const alpha = groups.find((g) => g.label === 'alpha') as RailGroup
    expect(alpha.remote).toBe(false)
  })

  it('local rows without directory land in 未分组 (not remote)', () => {
    const groups = groupByProject([local('x', undefined, 1)])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('未分组')
    expect(groups[0].remote).toBe(false)
  })
})

describe('partitionTime', () => {
  it('splits pinned vs recent, both most-recent-first', () => {
    const rows = [local('a', '/w', 100), local('b', '/w', 300), local('c', '/w', 200)]
    const { pinned, recent } = partitionTime(rows, ['c'])
    expect(pinned.map((r) => r.id)).toEqual(['c'])
    expect(recent.map((r) => r.id)).toEqual(['b', 'a'])
  })
})
