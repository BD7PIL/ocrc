/**
 * Per-instance ignore patterns for config sync (噪音治理): matched against the
 * posix rel path of every whitelisted file, on BOTH sides and in BOTH
 * directions (diff, push, pull, CLI) — one caliber, so a path the diff hides
 * can never still ride along inside a directory push.
 *
 * Pattern grammar (gitignore-style anchoring, kept deliberately tiny):
 *   `foo/`          the directory `foo` and everything under it — no interior
 *                   slash, so it matches at ANY depth (gitignore semantics)
 *   `skills/foo/`   interior slash anchors the rule at the config-dir root
 *   `foo/bar.md`    one exact file at the root
 *   `*.pyc`         wildcard (`*` = anything but a slash)
 *   leading `**`    lifts the anchor for multi-segment patterns; the only
 *                   multi-segment `**` form
 */

/** Runtime garbage that exists on peers but is nobody's declaration. */
export const DEFAULT_IGNORE_PATHS = ['**/__pycache__/'] as const

export function sanitizeIgnorePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const posix = item.trim().replace(/\\/g, '/')
    if (!posix || posix.startsWith('/')) continue
    let segments = posix.split('/').filter((s) => s.length > 0)
    // A `..` segment would walk out of the config dir — not an ignore rule.
    if (segments.some((s) => s === '..' || s === '.')) continue
    // `foo/**` reads as "everything under foo" — same as the directory rule.
    const hadTrailingStarstar = segments.length > 1 && segments[segments.length - 1] === '**'
    if (hadTrailingStarstar) segments = segments.slice(0, -1)
    // A `**` anywhere else has no defined meaning here; drop rather than guess.
    if (segments.filter((s) => s === '**').length > 1) continue
    const isDir = posix.endsWith('/') || hadTrailingStarstar
    const pattern = segments.join('/') + (isDir ? '/' : '')
    if (pattern && pattern !== '/' && pattern !== '**' && !out.includes(pattern)) out.push(pattern)
  }
  return out
}

export type IgnoreMatcher = (rel: string) => boolean

/** Compile patterns once; an empty list matches nothing. */
export function compileIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const regexes = patterns.map(compileOne).filter((r): r is RegExp => r !== null)
  if (regexes.length === 0) return () => false
  return (rel) => regexes.some((re) => re.test(rel))
}

function compileOne(pattern: string): RegExp | null {
  const dir = pattern.endsWith('/')
  const segments = pattern.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null
  // gitignore anchoring: no interior slash → matches at any depth (a trailing
  // slash does NOT anchor); an interior slash anchors at the root unless a
  // leading `**` lifts it.
  let anyDepth = !pattern.replace(/\/$/, '').includes('/')
  if (segments[0] === '**') {
    anyDepth = true
    segments.shift()
    if (segments.length === 0) return null
  }
  const body = segments.map(escapeSegment).join('/')
  if (dir) {
    // Everything under the directory (files only reach us, so no bare-dir case).
    return new RegExp(anyDepth ? `(?:^|/)${body}/` : `^${body}/`)
  }
  return new RegExp(anyDepth ? `^(?:[^/]+/)*${body}$` : `^${body}$`)
}

function escapeSegment(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')
}
