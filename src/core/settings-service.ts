import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('settings')

/**
 * 0.27 M5 设置域 — host-side config service for the opencode global config
 * (~/.config/opencode/opencode.json[c]). opencode has no config-write API,
 * so the panel edits the file directly through this service (the path
 * OpenCode-Client proved out): JSONC-validate → back up → atomic write.
 * Provider API keys live in this file — GET responses carry a parsed SUMMARY
 * with keys redacted to hasKey/hint, and structured writes patch only the
 * fields the UI touched (keys pass through untouched unless explicitly set).
 */

export interface ConfigSummary {
  path: string
  raw: string
  parsed: boolean
  providers: Array<{
    id: string
    name?: string
    baseURL?: string
    hasKey: boolean
    keyHint?: string
    models: Array<{ id: string; name?: string }>
  }>
  error?: string
}

export interface ProviderPatch {
  providerId: string
  /** Display name (opencode: provider.<id>.name). */
  name?: string
  /** AI-SDK loader package. opencode REQUIRES npm for a config-defined provider:
   *  an entry without it makes the whole provider registry come back empty
   *  ("No providers are available" — every model, including built-ins, dies).
   *  实测：{name} 裸条目 → 引擎全挂；{npm, models:{}} → 健康。 */
  npm?: string
  baseURL?: string
  /** Write-only: absent = leave the stored key untouched. */
  apiKey?: string
  /** Replaces the provider's models map (id → name + optional passthrough). */
  models?: Array<{ id: string; name?: string; [k: string]: unknown }>
  /** true = remove the provider entry entirely (/z/ 的 deletePersonalProvider)。 */
  delete?: boolean
}

export function globalConfigPath(configDir?: string): string {
  const dir = configDir ?? join(process.env.HOME ?? '', '.config', 'opencode')
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return join(dir, 'opencode.json')
}

/** Strip JSONC comments + trailing commas WITHOUT touching string contents
 *  (a naive regex would eat URLs like https://… inside strings). */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  let strCh = ''
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inStr) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === strCh) inStr = false
      i++
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; out += ch; i++; continue }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue }
    out += ch
    i++
  }
  // trailing commas: `,` followed by whitespace then } or ]
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function parseConfig(raw: string): { ok: boolean; parsed?: Record<string, unknown>; error?: string } {
  try {
    const parsed = JSON.parse(stripJsonc(raw))
    return parsed && typeof parsed === 'object'
      ? { ok: true, parsed: parsed as Record<string, unknown> }
      : { ok: false, error: '顶层必须是对象' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function keyHint(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/** Redacted summary — provider keys never leave the host. */
export function summarize(raw: string, path: string): ConfigSummary {
  const { ok, parsed, error } = parseConfig(raw)
  if (!ok || !parsed) return { path, raw, parsed: false, providers: [], error }
  const providersRaw = (parsed.provider ?? {}) as Record<string, Record<string, unknown>>
  const providers = Object.entries(providersRaw).map(([id, p]) => {
    const options = (p.options ?? {}) as Record<string, unknown>
    const key = typeof options.apiKey === 'string' ? options.apiKey : ''
    const models = Object.entries((p.models ?? {}) as Record<string, { name?: string }>).map(([mid, m]) => ({ id: mid, name: m?.name }))
    return {
      id,
      name: typeof p.name === 'string' ? p.name : undefined,
      baseURL: typeof options.baseURL === 'string' ? options.baseURL : undefined,
      hasKey: !!key,
      keyHint: key ? keyHint(key) : undefined,
      models,
    }
  })
  return { path, raw, parsed: true, providers }
}

/** Validate → back up the existing file (once per write, *.ocrc-bak) →
 *  atomic tmp+rename. Throws on invalid JSONC (the caller surfaces it). */
export function writeConfig(path: string, raw: string): void {
  const { ok, error } = parseConfig(raw)
  if (!ok) throw new Error(`JSONC 校验失败：${error}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.ocrc-bak`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, raw)
  renameSync(tmp, path)
  log.info(`config written: ${path} (backup at ${path}.ocrc-bak)`)
}

/** Structured provider patch: merge into the parsed doc, re-serialize
 *  pretty-2 (keys preserved — we patch in-memory from the CURRENT file). */
export function patchProvider(path: string, patch: ProviderPatch): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '{}'
  const { ok, parsed } = parseConfig(raw)
  if (!ok || !parsed) throw new Error('当前配置不是合法 JSONC — 请先用编辑器修复')
  const doc = parsed
  const providers = (doc.provider ??= {}) as Record<string, Record<string, unknown>>
  if (patch.delete) {
    delete providers[patch.providerId]
    writeFileSyncRaw(path, `${JSON.stringify(doc, null, 2)}\n`)
    return
  }
  const p = (providers[patch.providerId] ??= {})
  if (patch.name !== undefined) p.name = patch.name
  if (patch.npm !== undefined) p.npm = patch.npm
  if (patch.baseURL !== undefined || patch.apiKey !== undefined) {
    const options = (p.options ??= {}) as Record<string, unknown>
    if (patch.baseURL !== undefined) options.baseURL = patch.baseURL
    // Write-only: absent = leave the stored key untouched.
    if (patch.apiKey !== undefined) options.apiKey = patch.apiKey
  }
  if (patch.models !== undefined) {
    const models: Record<string, unknown> = {}
    for (const m of patch.models) {
      const { id, name, ...rest } = m
      models[id] = { ...(rest as Record<string, unknown>), ...(name ? { name } : {}) }
    }
    p.models = models
  }
  writeFileSyncRaw(path, `${JSON.stringify(doc, null, 2)}\n`)
}

/** Reorder = rebuild the object's key order (JSON objects keep insertion order,
 *  and the panel renders providers/models in file order). Ids absent from the
 *  document are ignored; ids not listed keep their relative order at the end. */
export function reorderConfig(
  path: string,
  input: { providerIds?: readonly string[]; providerId?: string; modelIds?: readonly string[] },
): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '{}'
  const { ok, parsed } = parseConfig(raw)
  if (!ok || !parsed) throw new Error('当前配置不是合法 JSONC — 请先用编辑器修复')
  const doc = parsed
  const providers = (doc.provider ?? {}) as Record<string, Record<string, unknown>>
  const withRest = <T>(order: readonly string[] | undefined, source: Record<string, T>): Record<string, T> => {
    if (!order?.length) return source
    const out: Record<string, T> = {}
    for (const id of order) if (id in source) out[id] = source[id]!
    for (const [id, v] of Object.entries(source)) if (!(id in out)) out[id] = v
    return out
  }
  if (input.providerIds?.length) doc.provider = withRest(input.providerIds, providers)
  if (input.providerId && input.modelIds?.length) {
    const p = providers[input.providerId]
    if (p && p.models && typeof p.models === 'object') {
      p.models = withRest(input.modelIds, p.models as Record<string, unknown>)
    }
  }
  writeFileSyncRaw(path, `${JSON.stringify(doc, null, 2)}\n`)
}

/** MCP entry patch for the user-level `mcp` map in the opencode global
 *  config. Same read-modify-write contract as patchProvider: the CURRENT
 *  parsed doc is patched and re-serialized, so unrelated keys survive, and the
 *  write goes through writeFileSyncRaw (backup + atomic rename). */
export interface McpPatch {
  id: string
  /** Replace/insert the entry. */
  entry?: Record<string, unknown>
  /** Toggle `enabled` on an EXISTING entry (creating a bare {enabled} stub
   *  would be an invalid entry the engine chokes on). */
  enabled?: boolean
  /** Remove the entry. */
  delete?: boolean
}

export function patchMcpEntry(path: string, patch: McpPatch): void {
  const id = typeof patch?.id === 'string' ? patch.id.trim() : ''
  if (!id) throw new Error('MCP 名称必填')
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '{}'
  const { ok, parsed } = parseConfig(raw)
  if (!ok || !parsed) throw new Error('当前配置不是合法 JSONC — 请先用编辑器修复')
  const doc = parsed
  const mcp = (doc.mcp ??= {}) as Record<string, Record<string, unknown>>
  if (patch.delete) {
    delete mcp[id]
    writeFileSyncRaw(path, `${JSON.stringify(doc, null, 2)}\n`)
    return
  }
  if (patch.entry !== undefined) {
    const entry = patch.entry
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('MCP 配置必须是对象')
    // The engine fail-fasts on malformed MCP bootstrap; validate here so a bad
    // form can't poison the global config.
    const type = (entry as { type?: unknown }).type
    if (type !== 'local' && type !== 'remote') throw new Error("MCP 配置需要 type: 'local' | 'remote'")
    if (type === 'local' && !Array.isArray((entry as { command?: unknown }).command)) throw new Error('local MCP 需要 command 数组')
    if (type === 'remote' && typeof (entry as { url?: unknown }).url !== 'string') throw new Error('remote MCP 需要 url')
    mcp[id] = entry
    writeFileSyncRaw(path, `${JSON.stringify(doc, null, 2)}\n`)
    return
  }
  if (patch.enabled !== undefined) {
    const existing = mcp[id]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error(`MCP ${id} 不存在，无法切换启停`)
    existing.enabled = patch.enabled
    writeFileSyncRaw(path, `${JSON.stringify(doc, null, 2)}\n`)
    return
  }
  throw new Error('MCP patch 需要 entry / enabled / delete 之一')
}

/** Read the user-level `mcp` map (parsed; missing/invalid file → {}). Feeds the
 *  settings page's list right after a write — the engine itself only picks the
 *  entries up on restart (it does not hot-reload config). */
export function readMcpEntries(path: string): Record<string, Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {}
    const { ok, parsed } = parseConfig(readFileSync(path, 'utf-8'))
    if (!ok || !parsed) return {}
    return (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>
  } catch {
    return {}
  }
}

/** Server-side connectivity probe for a stored provider: the API key never
 *  leaves the host, so the browser cannot do this itself. GET <baseURL>/models
 *  is the cheapest authenticated round-trip. */
export async function testProviderConnectivity(
  path: string,
  providerId: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '{}'
  const { ok, parsed } = parseConfig(raw)
  if (!ok || !parsed) return { ok: false, latencyMs: 0, error: '配置不是合法 JSONC' }
  const provider = ((parsed.provider ?? {}) as Record<string, Record<string, unknown>>)[providerId]
  const options = (provider?.options ?? {}) as Record<string, unknown>
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : ''
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey : ''
  if (!baseURL) return { ok: false, latencyMs: 0, error: `供应商 ${providerId} 未配置 baseURL` }
  try {
    await fetchProviderModels(baseURL, apiKey || undefined)
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message }
  }
}

/** Raw write without re-validation (patchProvider already parsed). */
function writeFileSyncRaw(path: string, raw: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.ocrc-bak`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, raw)
  renameSync(tmp, path)
}

/** Fetch a provider's model list (OpenAI-shaped /models, 10s timeout). */
export async function fetchProviderModels(baseURL: string, apiKey?: string): Promise<Array<{ id: string; name?: string }>> {
  const base = baseURL.replace(/\/+$/, '')
  const res = await fetch(`${base}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GET ${base}/models → ${res.status}`)
  const body = (await res.json()) as { data?: Array<{ id?: string; name?: string }> } | Array<{ id?: string; name?: string }>
  const list = Array.isArray(body) ? body : body.data ?? []
  return list.filter((m) => typeof m.id === 'string').map((m) => ({ id: m.id as string, name: typeof m.name === 'string' ? m.name : undefined }))
}
