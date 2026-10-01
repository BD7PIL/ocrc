/**
 * Build a normalized DiffEntry from two file versions, shared by every backend's
 * getDiff. Uses jsdiff's line diff; trims long unchanged runs to ~3 lines of
 * context around changes, and guards against pathologically large diffs.
 */
import { diffLines } from 'diff'
import type { DiffEntry, DiffLine } from './backend.js'

const CTX = 3 // context lines kept around each change
const MAX_CHANGED = 2000 // beyond this, return counts only (no full lines)

/** Split a jsdiff chunk value into lines, dropping the trailing empty element. */
function toLines(value: string): string[] {
  const arr = value.split('\n')
  if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop()
  return arr
}

export function buildDiffEntry(path: string, oldText: string, newText: string): DiffEntry {
  const parts = diffLines(oldText ?? '', newText ?? '')

  let additions = 0
  let deletions = 0
  for (const p of parts) {
    if (p.added) additions += toLines(p.value).length
    else if (p.removed) deletions += toLines(p.value).length
  }

  if (additions + deletions === 0) return { path, additions: 0, deletions: 0, lines: [] }
  if (additions + deletions > MAX_CHANGED) {
    return { path, additions, deletions, lines: [{ kind: 'ctx', text: `… ${additions + deletions} changed lines (truncated) …` }] }
  }

  const lines: DiffLine[] = []
  parts.forEach((p, i) => {
    const ls = toLines(p.value)
    if (p.added) { for (const text of ls) lines.push({ kind: 'add', text }) }
    else if (p.removed) { for (const text of ls) lines.push({ kind: 'del', text }) }
    else {
      // Unchanged context: keep only ~CTX lines adjacent to changes; collapse the
      // middle of long runs so the payload stays small.
      const isFirst = i === 0
      const isLast = i === parts.length - 1
      if (ls.length <= CTX * 2) { for (const text of ls) lines.push({ kind: 'ctx', text }) }
      else if (isFirst) { for (const text of ls.slice(-CTX)) lines.push({ kind: 'ctx', text }) }
      else if (isLast) { for (const text of ls.slice(0, CTX)) lines.push({ kind: 'ctx', text }) }
      else {
        for (const text of ls.slice(0, CTX)) lines.push({ kind: 'ctx', text })
        lines.push({ kind: 'ctx', text: '…' })
        for (const text of ls.slice(-CTX)) lines.push({ kind: 'ctx', text })
      }
    }
  })
  return { path, additions, deletions, lines }
}

/**
 * Build a normalized DiffEntry from a unified-diff patch (1.18.32's
 * /session/:id/diff returns {file, patch} — NOT the old before/after pair the
 * opencode-backend used to parse, which silently produced empty diffs).
 * Keeps +/-/context lines; collapses long unchanged runs like buildDiffEntry.
 */
export function buildDiffEntryFromPatch(path: string, patch: string, additions = 0, deletions = 0): DiffEntry {
  const bodyLines = (patch ?? '').split('\n').filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ ') && !/^@@/.test(l) && !/^diff /g.test(l) && !/^index /.test(l))
  const lines: DiffLine[] = []
  let ctxRun: string[] = []
  let changed = 0
  const flushCtx = (keepFirst: boolean, keepLast: boolean) => {
    if (ctxRun.length === 0) return
    if (ctxRun.length <= CTX * 2) lines.push(...ctxRun.map((text) => ({ kind: 'ctx' as const, text })))
    else if (keepFirst) lines.push(...ctxRun.slice(0, CTX).map((text) => ({ kind: 'ctx' as const, text })), { kind: 'ctx', text: '…' })
    else if (keepLast) lines.push({ kind: 'ctx', text: '…' }, ...ctxRun.slice(-CTX).map((text) => ({ kind: 'ctx' as const, text })))
    else lines.push({ kind: 'ctx', text: '…' })
    ctxRun = []
  }
  for (const l of bodyLines) {
    if (l.startsWith('+')) { flushCtx(false, false); lines.push({ kind: 'add', text: l.slice(1) }); changed++ }
    else if (l.startsWith('-')) { flushCtx(false, false); lines.push({ kind: 'del', text: l.slice(1) }); changed++ }
    else if (l.startsWith('\\')) { /* "\ No newline at end of file" */ }
    else ctxRun.push(l)
  }
  flushCtx(false, true)
  const totalAdd = additions || lines.filter((l) => l.kind === 'add').length
  const totalDel = deletions || lines.filter((l) => l.kind === 'del').length
  if (totalAdd + totalDel === 0) return { path, additions: 0, deletions: 0, lines: [] }
  if (changed > MAX_CHANGED) {
    return { path, additions: totalAdd, deletions: totalDel, lines: [{ kind: 'ctx', text: `… ${totalAdd + totalDel} changed lines (truncated) …` }] }
  }
  return { path, additions: totalAdd, deletions: totalDel, lines }
}
