/**
 * One config-merge engine, two topologies (C2/C4).
 *
 * Why this module exists: the sync that pushes our config to a peer has to
 * answer the same questions in both places we do it — the workspace bridge
 * (project-level `<dir>/opencode.jsonc`) and the instance topology (the peer's
 * user-level `~/.config/opencode`). Two implementations would drift, and the
 * rules here are not preferences:
 *
 *   · **Never a whole-file overwrite.** A peer's `opencode.json` may hold keys
 *     we know nothing about (hand-edited providers, permissions, an MCP server
 *     someone added in the panel). `mergeSticky` copies the peer's document and
 *     overwrites only the leaves we send, so anything we did not mention
 *     survives — including the peer's own credentials, which a naive push
 *     would erase.
 *   · **Secrets do not travel in files.** `stripLiteralSecrets` rewrites a
 *     literal key into an `{env:VAR}` reference, so the value never lands on the
 *     peer's disk (C2/D11).
 *   · **The peer's own layer wins where it owns the key.** openchamber writes
 *     `~/.config/openchamber/opencode.managed.json`, which per upstream
 *     (`server/lib/opencode/managed-config-file.js`) holds **nothing but
 *     `plugins`** and sits above the user's global config. So we refuse to write
 *     a `plugins`/`plugin` key into the peer's `opencode.json` and say so
 *     instead — silently writing one would fight the instance's own plugin
 *     management.
 *   · **Read and write are separate round trips**, both atomic on the peer:
 *     read is base64 (quotes and newlines cannot tear the script), write is
 *     temp-file → `.ocrc-bak` → `mv`.
 *
 * Pure string/structure in, pure string/structure out: the ssh transport is
 * injected by the caller, which is what makes the merge testable without a peer.
 */
import { stripJsonc } from './settings-service.js'

export const CONFIG_BASENAMES = ['opencode.jsonc', 'opencode.json'] as const

export type ConfigFormat = 'jsonc' | 'json' | 'missing'

export interface ConfigFileRead {
  /** The file the engine actually reads; when neither exists, the recommended
   *  landing spot (the first candidate). */
  targetPath: string
  basename: string
  format: ConfigFormat
  exists: boolean
  raw?: string
  parsed?: Record<string, unknown>
  parseError?: string
  /** A `.jsonc` with comments: writing it back as JSON loses them, and the UI
   *  has to say so rather than silently reformat the user's file. */
  commentsWillBeLost?: boolean
}

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** One ssh round trip that reads the first existing candidate, base64-encoded
 *  (so quoting/newlines cannot break the remote shell). */
export function buildConfigReadScript(dir: string, basenames: readonly string[] = CONFIG_BASENAMES): string {
  const d = dir.replace(/\/+$/, '')
  return [
    `D=${q(d)}`,
    'for name in ' + basenames.map(q).join(' ') + '; do',
    '  f="$D/$name"',
    '  if [ -f "$f" ]; then',
    '    echo "FOUND=$name"',
    '    echo "B64_BEGIN"',
    '    base64 < "$f"',
    '    echo "B64_END"',
    '    break',
    '  fi',
    'done',
    'echo "READ_DONE=1"',
  ].join('\n')
}

export function parseConfigRead(
  stdout: string,
  dir: string,
  basenames: readonly string[] = CONFIG_BASENAMES,
): ConfigFileRead {
  const base = dir.replace(/\/+$/, '')
  const found = /^FOUND=(\S+)$/m.exec(stdout)?.[1]
  const block = /B64_BEGIN\r?\n([\s\S]*?)\r?\nB64_END/.exec(stdout)
  if (!found || !block) {
    return { targetPath: `${base}/${basenames[0]}`, basename: basenames[0], format: 'missing', exists: false }
  }
  const raw = Buffer.from(block[1].replace(/[\r\n]/g, ''), 'base64').toString('utf-8')
  const format: ConfigFormat = found.endsWith('.jsonc') ? 'jsonc' : 'json'
  const result: ConfigFileRead = { targetPath: `${base}/${found}`, basename: found, format, exists: true, raw }
  if (format === 'jsonc' && /(^|\n)\s*(\/\/|\/\*)/.test(raw)) result.commentsWillBeLost = true
  try {
    const parsed = JSON.parse(format === 'jsonc' ? stripJsonc(raw) : raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      result.parseError = '顶层必须是对象'
    } else {
      result.parsed = parsed as Record<string, unknown>
    }
  } catch (err) {
    result.parseError = (err as Error).message
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Leaf-wise sticky merge: `incoming` wins where it has a leaf, everything else
 *  in `remote` is kept. Arrays are leaves (replaced whole) — merging them would
 *  invent an ordering the user did not ask for. */
export function mergeSticky(
  remote: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...remote }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const current = out[key]
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeSticky(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** Key order must not count as a change, or every sync would rewrite the peer's
 *  file and leave a pointless `.ocrc-bak`. */
export function hasChanges(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(before)) !== JSON.stringify(sortKeys(after))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

/**
 * The key the peer's own openchamber owns. Per upstream, the managed layer
 * (`~/.config/openchamber/opencode.managed.json`) holds only `plugins`; a
 * `plugins`/`plugin` key we wrote into `opencode.json` would sit *below* it and
 * either be shadowed or fight it. So the sync drops it and reports the drop.
 */
export const MANAGED_OWNED_KEYS = ['plugins', 'plugin'] as const

export function stripManagedKeys(config: Record<string, unknown>): {
  config: Record<string, unknown>
  dropped: string[]
} {
  const next = structuredClone(config) as Record<string, unknown>
  const dropped: string[] = []
  for (const key of MANAGED_OWNED_KEYS) {
    if (key in next) {
      delete next[key]
      dropped.push(key)
    }
  }
  return { config: next, dropped }
}

/** Literal secrets never land on the peer's disk: `{env:VAR}` instead (C2/D11).
 *
 *  Scoped to MCP `environment` blocks on purpose — that is where the panel and
 *  opencode actually put a literal key, and it is the only place a rewrite is
 *  safe without knowing what the value is. **Provider keys are not handled here
 *  at all**: they belong in `auth.json` (C3), which travels over ssh stdin and
 *  never touches a config file. A generic "rewrite anything named like a secret"
 *  pass would have turned a working `provider.<id>.options.apiKey` into a
 *  reference nobody defines — a broken provider reported as a successful sync.
 *
 *  The env var is expected to exist in the peer's own environment; we do not
 *  invent its value (documented in C6). */
export function stripLiteralSecrets(config: Record<string, unknown>): {
  config: Record<string, unknown>
  replaced: Array<{ path: string; env: string }>
} {
  const next = structuredClone(config) as Record<string, unknown>
  const replaced: Array<{ path: string; env: string }> = []
  const servers = (next.mcp as { servers?: Record<string, unknown> } | undefined)?.servers
  if (!servers) return { config: next, replaced }
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue
    const declaration = raw as { environment?: Record<string, unknown> }
    for (const [key, value] of Object.entries(declaration.environment ?? {})) {
      if (typeof value !== 'string' || /^\{.*\}$/.test(value)) continue
      if (!/(key|token|secret|password|passwd|credential|apikey)/i.test(key)) continue
      declaration.environment![key] = `{env:${key}}`
      replaced.push({ path: `mcp.servers.${name}.environment.${key}`, env: key })
    }
  }
  return { config: next, replaced }
}

/** Atomic write on the peer: temp file in the same directory → `.ocrc-bak` of
 *  the old file → `mv` into place. Content arrives as base64 on stdin, the same
 *  shape the fs/omo writers use. */
export function buildConfigWriteScript(targetPath: string, base64: string): { script: string; stdin: string } {
  const script = [
    'set -e',
    `P=${q(targetPath)}`,
    'D=$(dirname "$P")',
    'mkdir -p "$D"',
    'T=$(mktemp "$D/.ocrc-cfg.XXXXXX")',
    'base64 -d > "$T"',
    'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak" && echo "OCRC_BAK=$P.ocrc-bak"; fi',
    'mv "$T" "$P"',
    'echo "OCRC_WRITTEN=$P"',
  ].join('\n')
  return { script, stdin: base64 }
}

/** Render a merged document the way the peer's engine reads it: JSON with two
 *  spaces and a trailing newline (same shape openchamber writes). */
export function renderConfig(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}
