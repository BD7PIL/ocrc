// railModel.ts — pure logic for the left rail v2 (2026-10): project/time
// grouping, three-bucket partition (pinned / default / archived), inline
// search, and the local-vs-remote workspace distinction. Aligned with
// ZCode's WorkspaceSidebar model (membership{pinned,archived} + cloud/folder
// iconography), simplified to ocrc's session-centric IA.
//
// Pure and Svelte-free so it stays trivially unit-testable.

import type { SessionSummary } from '../api/types.js'

export type RailGroupMode = 'project' | 'time'

/** `remote:<host>` backends are driven over SSH — cloud icon; else folder. */
export function isRemoteSession(s: SessionSummary): boolean {
  return !!s.backendId?.startsWith('remote:')
}

export function remoteHostOf(s: SessionSummary): string | undefined {
  const m = s.backendId?.match(/^remote:(.+)$/)
  return m?.[1]
}

export function repoName(dir?: string): string {
  if (!dir) return ''
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || ''
}

/** Inline search: substring match over title / project / remote host / short id. */
export function matchesQuery(s: SessionSummary, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  const bare = s.id.includes('_') ? s.id.slice(s.id.indexOf('_') + 1) : s.id
  const haystack = [s.title ?? '', repoName(s.directory), remoteHostOf(s) ?? '', bare.slice(-8)]
  return haystack.some((field) => field.toLowerCase().includes(q))
}

export interface RailGroup {
  /** Group key: project directory, `@host` for directory-less remote sessions, `@other`. */
  key: string
  label: string
  /** True when every row rides a `remote:` backend → cloud icon + host label. */
  remote: boolean
  remoteHost?: string
  rows: SessionSummary[]
}

/** Group sessions by workspace (project directory). Directory-less remote
 *  sessions group under their host; anything else lands in 未分组. Groups and
 *  rows are both most-recent-first. */
export function groupByProject(rows: SessionSummary[]): RailGroup[] {
  const byKey = new Map<string, RailGroup>()
  for (const s of rows) {
    const dir = s.directory
    const host = remoteHostOf(s)
    const key = dir ? `dir:${dir}` : host ? `@${host}` : '@other'
    let g = byKey.get(key)
    if (!g) {
      g = {
        key,
        label: repoName(dir) || host || '未分组',
        remote: !dir && !!host,
        remoteHost: !dir ? host : undefined,
        rows: [],
      }
      byKey.set(key, g)
    }
    g.rows.push(s)
  }
  const groups = [...byKey.values()]
  for (const g of groups) g.rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  groups.sort((a, b) => newest(b) - newest(a))
  return groups
}

function newest(g: RailGroup): number {
  return g.rows.reduce((max, s) => Math.max(max, s.lastActiveAt), 0)
}

/** Time mode: the classic pinned/recent split, most-recent-first. */
export function partitionTime(rows: SessionSummary[], pinnedIds: string[]): { pinned: SessionSummary[]; recent: SessionSummary[] } {
  const sorted = [...rows].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return {
    pinned: sorted.filter((s) => pinnedIds.includes(s.id)),
    recent: sorted.filter((s) => !pinnedIds.includes(s.id)),
  }
}
