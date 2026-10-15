/** omo-config — batch 5.1 (2.0.0-alpha.6).
 *
 * The omo-slim plugin reads `~/.config/opencode/oh-my-opencode-slim.json[c]`
 * on the CONTROLLED host and hot-reloads it (fs.watch, ~300ms debounce —
 * E4-verified: "runtime profiles refreshed from disk" in the plugin log after
 * an external edit; malformed JSON is rejected with last-known-good retained).
 * The panel host never sees that disk, so the bridge carries it over the same
 * ssh exec face as batch 4/5.
 *
 * Path policy (stricter than an allowlist): the remote path is assembled
 * HERE — `$HOME/.config/opencode/oh-my-opencode-slim.json[c]` — no request
 * can name an arbitrary file.
 *
 * Write semantics = syncConfig family: server-side JSON.parse validation
 * (bad JSON is a 422 and never reaches ssh), atomic write, prior file backed
 * up to *.ocrc-bak. Editing a `.jsonc` round-trips to plain JSON (comments
 * stripped by the jsonc parse) and the caller is told via `willConvertToJson`.
 */
import { OMO_SCHEMA } from './omo-schema.js'

export const OMO_BASENAME_JSON = 'oh-my-opencode-slim.json'
export const OMO_BASENAME_JSONC = 'oh-my-opencode-slim.jsonc'

/** The only two paths this module will ever read/write on the remote. */
export function omoRemotePaths(homeExpr = '$HOME'): { json: string; jsonc: string } {
  return {
    json: `${homeExpr}/.config/opencode/${OMO_BASENAME_JSON}`,
    jsonc: `${homeExpr}/.config/opencode/${OMO_BASENAME_JSONC}`,
  }
}

/** Strip // line comments and /* block comments from jsonc text — string
 *  literals are preserved (quotes, escapes and comment-markers inside them
 *  never trigger). Trailing commas are left alone: the writer round-trips
 *  through JSON.stringify, which drops them anyway. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue }
      if (c === '"') inStr = false
      i += 1
      continue
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue // newline itself kept for line numbers
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

export type OmoFormat = 'json' | 'jsonc' | 'missing'

/** Parse an omo config in either format. `null` = unparseable (err carries why). */
export function parseOmoConfig(raw: string, format: OmoFormat): { parsed: Record<string, unknown> | null; err?: string } {
  if (format === 'missing') return { parsed: null }
  const text = raw.replace(/^\uFEFF/, '')
  try {
    const parsed = JSON.parse(format === 'jsonc' ? stripJsonc(text) : text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { parsed: null, err: 'omo config must be a JSON object' }
    }
    return { parsed: parsed as Record<string, unknown> }
  } catch (e) {
    return { parsed: null, err: e instanceof Error ? e.message : String(e) }
  }
}

/** Remote read script: prefer .jsonc (omo reads jsonc first too), fall back
 *  to .json. Keyed output — FORMAT / SIZE / MISSING / base64 body. */
/** Remote-shell-quote a path that may contain a $HOME expression. Unlike the
 *  fs/git scripts (absolute literal paths, single quotes correct), the omo
 *  paths deliberately carry `$HOME` for REMOTE expansion — single quotes
 *  would freeze it into a literal directory name (found by the alpha.7
 *  acceptance script: writes silently landed in ~/$HOME/.config/opencode).
 *  Double quotes let the remote shell expand $HOME while still protecting
 *  embedded specials; the two fixed filenames carry no other specials. */
function qq(s: string): string {
  return `"${s.replaceAll('"', '\\"')}"`
}

export function buildOmoReadScript(paths: { json: string; jsonc: string }): string {
  return [
    'set -e',
    `JC=${qq(paths.jsonc)}`,
    `JJ=${qq(paths.json)}`,
    'if [ -f "$JC" ]; then echo "FORMAT:jsonc"; wc -c < "$JC" | tr -d " " | sed "s/^/SIZE:/"',
    'elif [ -f "$JJ" ]; then echo "FORMAT:json"; wc -c < "$JJ" | tr -d " " | sed "s/^/SIZE:/"',
    'else echo "FORMAT:missing"; exit 0; fi',
    'if [ -f "$JC" ]; then base64 < "$JC"; else base64 < "$JJ"; fi',
  ].join('\n')
}

export function parseOmoReadOutput(stdout: string): { format: OmoFormat; size?: number; raw?: string } {
  const lines = stdout.split('\n')
  const fLine = lines.find((l) => l.startsWith('FORMAT:'))
  const sLine = lines.find((l) => l.startsWith('SIZE:'))
  const format = (fLine?.slice(7) ?? 'missing') as OmoFormat
  const raw = lines.filter((l) => !l.startsWith('FORMAT:') && !l.startsWith('SIZE:')).join('')
  return {
    format,
    size: sLine ? Number(sLine.slice(5)) : undefined,
    raw: raw ? Buffer.from(raw, 'base64').toString('utf-8') : undefined,
  }
}

/** Atomic write script in the syncConfig family: mktemp in the same dir,
 *  base64 -d, back up the replaced file to *.ocrc-bak, mv. Emits
 *  `bak: <path>` when a backup was made, `written: <path>` on success. */
export function buildOmoWriteScript(target: string, b64: string): { script: string; stdin: string } {
  const script = [
    'set -e',
    `P=${qq(target)}`,
    'D=$(dirname "$P")',
    'mkdir -p "$D"',
    'T=$(mktemp "$D/.ocrc-omo.XXXXXX")',
    'base64 -d > "$T"',
    'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak"; echo "bak: $P.ocrc-bak"; fi',
    'mv "$T" "$P"',
    'echo "written: $P"',
  ].join('\n')
  return { script, stdin: b64 }
}

/** Structured summary the UI drives off — preset names, fallback defaults
 *  and the raw document for the escape-hatch editor. */
export interface OmoConfigSummary {
  exists: boolean
  format: OmoFormat
  size?: number
  activePreset?: string
  presetNames: string[]
  fallback?: Record<string, unknown>
  agentChains?: Record<string, unknown>
  parsed?: Record<string, unknown>
  parseError?: string
  schema: unknown
  /** Write-side warning: the remote file is .jsonc — the next write keeps the
   *  extension (omo reads .jsonc first; leaving both would strand edits) but
   *  comments cannot survive the JSON.stringify round-trip. */
  commentsWillBeLost?: boolean
}

export function summarizeOmoConfig(format: OmoFormat, size: number | undefined, raw: string | undefined): OmoConfigSummary {
  const base: OmoConfigSummary = { exists: format !== 'missing', format, presetNames: [], schema: OMO_SCHEMA }
  if (format === 'missing' || raw === undefined) return base
  const { parsed, err } = parseOmoConfig(raw, format)
  if (!parsed) return { ...base, parseError: err }
  const presets = parsed.presets
  return {
    ...base,
    size,
    activePreset: typeof parsed.preset === 'string' ? parsed.preset : undefined,
    presetNames: presets && typeof presets === 'object' && !Array.isArray(presets) ? Object.keys(presets).sort() : [],
    fallback: parsed.fallback && typeof parsed.fallback === 'object' && !Array.isArray(parsed.fallback)
      ? parsed.fallback as Record<string, unknown>
      : undefined,
    agentChains: presets as Record<string, unknown> | undefined,
    parsed,
    commentsWillBeLost: format === 'jsonc',
  }
}

/** Validate a write payload BEFORE any ssh runs: it must parse as a JSON
 *  object. Returns the canonical serialization (2-space, trailing newline). */
export function validateOmoWriteContent(content: string): { ok: true; canonical: string; parsed: Record<string, unknown> } | { ok: false; err: string } {
  const { parsed, err } = parseOmoConfig(content, 'json')
  if (!parsed) return { ok: false, err: `omo 配置必须是合法 JSON 对象：${err ?? 'parse failed'}` }
  return { ok: true, canonical: JSON.stringify(parsed, null, 2) + '\n', parsed }
}

/** Apply a structured edit (preset/fallback) to a parsed config — returns a
 *  new object; untouched keys survive verbatim. Undefined preset clears the
 *  key (omo falls back to the first preset / session model); null fallback
 *  removes the block (schema defaults apply). */
export function applyOmoEdits(
  parsed: Record<string, unknown>,
  edits: { preset?: string | null; fallback?: Record<string, unknown> | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parsed }
  if (edits.preset !== undefined) {
    if (edits.preset === null) delete out.preset
    else out.preset = edits.preset
  }
  if (edits.fallback !== undefined) {
    if (edits.fallback === null) delete out.fallback
    else out.fallback = edits.fallback
  }
  return out
}

/** Fallback knobs with the schema's official defaults (placeholders in UI,
 *  validation floor here — negative values are never written). */
export const OMO_FALLBACK_DEFAULTS = { enabled: true, maxRetries: 3, initialRetryDelayMs: 0, retryDelayMs: 500, continuationPolicy: 'retry-primary' } as const
export const OMO_CONTINUATION_POLICIES = ['retry-primary', 'stick-to-fallback'] as const

export function sanitizeOmoFallback(input: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; err: string } {
  const out: Record<string, unknown> = {}
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') return { ok: false, err: 'fallback.enabled 必须是布尔值' }
    out.enabled = input.enabled
  }
  for (const k of ['maxRetries', 'initialRetryDelayMs', 'retryDelayMs'] as const) {
    if (k in input) {
      const v = input[k]
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { ok: false, err: `fallback.${k} 必须是非负整数` }
      out[k] = v
    }
  }
  if ('continuationPolicy' in input) {
    if (input.continuationPolicy !== 'retry-primary' && input.continuationPolicy !== 'stick-to-fallback') {
      return { ok: false, err: 'fallback.continuationPolicy 必须是 retry-primary | stick-to-fallback' }
    }
    out.continuationPolicy = input.continuationPolicy
  }
  const known = ['enabled', 'maxRetries', 'initialRetryDelayMs', 'retryDelayMs', 'continuationPolicy']
  for (const k of Object.keys(input)) {
    if (!known.includes(k)) return { ok: false, err: `fallback.${k} 不是 omo-slim 的 fallback 字段（schema additionalProperties:false）` }
  }
  return { ok: true, value: out }
}
