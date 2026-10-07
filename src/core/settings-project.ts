import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createLogger } from '../utils/logger.js'
import { parseConfig } from './settings-service.js'

const log = createLogger('settings-project')

/**
 * 0.27 M5-2 — project `.opencode/` file management + agent model-mapping
 * presets + MCP entry editing. All writes: validate → *.ocrc-bak → atomic.
 * File paths are CONTAINED: everything must live inside <dir>/.opencode (or
 * be AGENTS.md at the project root).
 */

export interface ProjectFilesOverview {
  dir: string
  agentsMd: { exists: boolean; content: string }
  projectConfig: { exists: boolean; content: string }
  commands: Array<{ name: string; content: string }>
  rules: Array<{ name: string; content: string }>
}

function safeInside(dir: string, rel: string): string | null {
  const base = resolve(dir)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return null
  return full
}

function opencodeDir(dir: string): string {
  const oc = join(dir, '.opencode')
  if (!existsSync(oc)) mkdirSync(oc, { recursive: true })
  return oc
}

function readText(p: string): string {
  try { return readFileSync(p, 'utf-8') } catch { return '' }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.ocrc-bak`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

function listMd(dir: string, sub: string): Array<{ name: string; content: string }> {
  const full = join(dir, sub)
  if (!existsSync(full)) return []
  try {
    return readdirSync(full).filter((f) => f.endsWith('.md')).sort().map((f) => ({
      name: f.replace(/\.md$/, ''),
      content: readText(join(full, f)),
    }))
  } catch {
    return []
  }
}

export function projectOverview(dir: string): ProjectFilesOverview {
  const oc = opencodeDir(dir)
  const agentsPath = join(dir, 'AGENTS.md')
  const cfgCandidates = ['opencode.json', 'opencode.jsonc'].map((n) => join(oc, n))
  const cfgPath = cfgCandidates.find((p) => existsSync(p))
  return {
    dir,
    agentsMd: { exists: existsSync(agentsPath), content: readText(agentsPath) },
    projectConfig: { exists: !!cfgPath, content: cfgPath ? readText(cfgPath) : '' },
    commands: listMd(oc, 'command'),
    rules: listMd(oc, 'rule'),
  }
}

export function readProjectFile(dir: string, rel: string): { ok: boolean; content: string } {
  const full = safeInside(dir, rel)
  if (!full) return { ok: false, content: 'path escapes the project' }
  return { ok: existsSync(full), content: readText(full) }
}

export function writeProjectFile(dir: string, rel: string, content: string): { ok: boolean; error?: string } {
  const full = safeInside(dir, rel)
  if (!full) return { ok: false, error: 'path escapes the project' }
  if (rel.endsWith('.json') || rel.endsWith('.jsonc')) {
    const { ok, error } = parseConfig(content)
    if (!ok) return { ok: false, error: `JSONC 校验失败：${error}` }
  }
  try {
    atomicWrite(full, content)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── agent model mapping (presets) ─────────────────────────────────────────
export interface MappingPresets {
  presets: Record<string, Record<string, string>>
}

function presetsPath(stateDir: string): string {
  return join(stateDir, 'model-presets.json')
}

export function readMapping(currentRaw: string | undefined, stateDir: string): {
  current: Record<string, string>
  presets: Record<string, Record<string, string>>
} {
  const current: Record<string, string> = {}
  if (currentRaw) {
    const { ok, parsed } = (() => { try { return { ok: true, parsed: JSON.parse(stripJsoncLite(currentRaw)) } } catch { return { ok: false, parsed: undefined } } })()
    if (ok && parsed) {
      const agents = (parsed as Record<string, Record<string, Record<string, unknown>>>).agent ?? {}
      for (const [name, cfg] of Object.entries(agents)) {
        const m = cfg?.model
        if (typeof m === 'string') current[name] = m
      }
    }
  }
  let presets: Record<string, Record<string, string>> = {}
  try {
    presets = JSON.parse(readFileSync(presetsPath(stateDir), 'utf-8')) ?? {}
  } catch { /* empty */ }
  return { current, presets }
}

/** Apply a mapping: write agent.model entries into the project/global config
 *  (atomic + backup), and persist the mapping as a named preset. */
export function applyMapping(dir: string, stateDir: string, name: string, mapping: Record<string, string>): { ok: boolean; error?: string } {
  const oc = opencodeDir(dir)
  const cfgCandidates = ['opencode.json', 'opencode.jsonc'].map((n) => join(oc, n))
  const cfgPath = cfgCandidates.find((p) => existsSync(p)) ?? join(oc, 'opencode.json')
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(stripJsoncLite(readText(cfgPath))) as Record<string, unknown>
  } catch {
    return { ok: false, error: '项目配置不是合法 JSONC' }
  }
  const agents = (doc.agent ??= {}) as Record<string, Record<string, unknown>>
  for (const [agentName, model] of Object.entries(mapping)) {
    const a = (agents[agentName] ??= {})
    a.model = model
  }
  try {
    atomicWrite(cfgPath, `${JSON.stringify(doc, null, 2)}\n`)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  // persist preset
  const pp = presetsPath(stateDir)
  let presets: Record<string, Record<string, string>> = {}
  try { presets = JSON.parse(readFileSync(pp, 'utf-8')) ?? {} } catch { /* empty */ }
  presets[name] = mapping
  try {
    mkdirSync(dirname(pp), { recursive: true })
    const tmp = `${pp}.tmp`
    writeFileSync(tmp, JSON.stringify(presets, null, 2))
    renameSync(tmp, pp)
  } catch (err) {
    log.warn('preset persist failed', (err as Error).message)
  }
  return { ok: true }
}

/** MCP entry edit: upsert or remove `mcp.<id>` in the project config. */
export function setMcpEntry(dir: string, id: string, entry: Record<string, unknown> | null): { ok: boolean; error?: string } {
  const oc = opencodeDir(dir)
  const cfgPath = [join(oc, 'opencode.json'), join(oc, 'opencode.jsonc')].find((p) => existsSync(p)) ?? join(oc, 'opencode.json')
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(stripJsoncLite(readText(cfgPath))) as Record<string, unknown>
  } catch {
    return { ok: false, error: '项目配置不是合法 JSONC' }
  }
  const mcp = (doc.mcp ??= {}) as Record<string, unknown>
  if (entry === null) delete mcp[id]
  else mcp[id] = entry
  try {
    atomicWrite(cfgPath, `${JSON.stringify(doc, null, 2)}\n`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function readMcpEntries(dir: string): Record<string, Record<string, unknown>> {
  const oc = join(dir, '.opencode')
  const cfgPath = [join(oc, 'opencode.json'), join(oc, 'opencode.jsonc')].find((p) => existsSync(p))
  if (!cfgPath) return {}
  try {
    const doc = JSON.parse(stripJsoncLite(readText(cfgPath))) as Record<string, Record<string, Record<string, unknown>>>
    return doc.mcp ?? {}
  } catch {
    return {}
  }
}

/** Local JSONC strip (subset of settings-service.stripJsonc — kept local to
 *  avoid importing provider-specific pieces). */
function stripJsoncLite(text: string): string {
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
  return out.replace(/,(\s*[}\]])/g, '$1')
}

