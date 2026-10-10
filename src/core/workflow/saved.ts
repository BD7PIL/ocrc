import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('workflow-saved')

/**
 * Saved workflows — the named, re-runnable scripts behind `SaveWorkflow` /
 * `ListSavedWorkflows` / `startSavedWorkflow`.
 *
 * Same store discipline as the rest of ocrc (a single JSON file under the ocrc
 * home, debounce-free synchronous writes): the file is small, writes are rare and
 * user-initiated, and losing one would lose the user's authored script.
 *
 * A saved workflow is *not* a run: it holds the script text plus the declared
 * arguments (name/description/type/default) that the run service validates and
 * back-fills before a run starts. The script's own `args` facade object is what the
 * script reads; the declarations here are what the UI prompts with.
 */
export interface SavedWorkflowArg {
  name: string
  type: 'string' | 'number' | 'boolean' | 'json'
  description?: string
  required?: boolean
  default?: unknown
}

/**
 * P4-3: the vendored scope vocabulary. Upstream keeps two directories (`<workspace>/.zcode/
 * workflows/` and `~/.zcode/workflows/`); ocrc keeps ONE machine-wide store, so the scope
 * is a field on the record rather than a directory, and `project` means "authored in a
 * workspace" rather than "stored under that workspace". The panel's default view is the
 * project scope, so new saves default to `project` — an entry the user cannot see by
 * default would be a worse lie than this one.
 */
export type SavedWorkflowScope = 'project' | 'global'

export interface SavedWorkflow {
  id: string
  name: string
  description?: string
  /** P4-3: the second half of the vendored meta (`description` + `whenToUse`). */
  whenToUse?: string
  scriptText: string
  args?: SavedWorkflowArg[]
  /** Where the script was authored (workspace), so a run can default its cwd. */
  cwd?: string
  /** P4-3: which scope the entry belongs to (see {@link SavedWorkflowScope}). */
  scope?: SavedWorkflowScope
  createdAt: number
  updatedAt: number
  /** How many times it has been started (the list face sorts on it). */
  runCount?: number
  lastRunAt?: number
}

export interface SavedWorkflowInput {
  name: string
  scriptText: string
  description?: string
  whenToUse?: string
  args?: SavedWorkflowArg[]
  cwd?: string
  scope?: SavedWorkflowScope
}

export interface SavedWorkflowsStore {
  list(): SavedWorkflow[]
  /** P4-3: the scoped list face the panel's Automations tab reads. */
  listScoped(scope?: SavedWorkflowScope): SavedWorkflow[]
  get(id: string): SavedWorkflow | undefined
  /** The vendored saved-workflow API is name-keyed, so this is the lookup it uses. */
  getByName(name: string, scope?: SavedWorkflowScope): SavedWorkflow | undefined
  /** Create or overwrite by name (the tool face is name-keyed, like upstream). */
  save(input: SavedWorkflowInput): SavedWorkflow
  /** P4-3: the vendored `updateSavedWorkflowMeta` (description / whenToUse / args). */
  setMeta(id: string, meta: { description: string; whenToUse?: string; args?: SavedWorkflowArg[] }): SavedWorkflow | undefined
  /** Where the store keeps its records — the `dir`/`path` the panel reports. */
  filePath(): string
  remove(id: string): boolean
  /** Validate + back-fill arguments against the saved declarations. */
  resolveArgs(id: string, provided: Record<string, unknown> | undefined):
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; error: string }
  noteRun(id: string): void
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workflow'
}

function coerce(type: SavedWorkflowArg['type'], value: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (type) {
    case 'string': return typeof value === 'string' ? { ok: true, value } : { ok: false }
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return { ok: true, value: Number(value) }
      return { ok: false }
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true') return { ok: true, value: true }
      if (value === 'false') return { ok: true, value: false }
      return { ok: false }
    }
    case 'json': return { ok: true, value }
  }
}

export function createSavedWorkflowsStore(path: string): SavedWorkflowsStore {
  let items: SavedWorkflow[] = []
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { workflows?: SavedWorkflow[] }
      if (Array.isArray(parsed.workflows)) items = parsed.workflows
    }
  } catch (err) {
    log.warn(`could not read ${path}: ${(err as Error).message}`)
  }

  function flush(): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ workflows: items }, null, 2))
    } catch (err) {
      log.warn(`could not write ${path}: ${(err as Error).message}`)
    }
  }

  const scopeOf = (w: SavedWorkflow): SavedWorkflowScope => w.scope ?? 'project'

  return {
    list() {
      return [...items].sort((a, b) => (b.lastRunAt ?? b.updatedAt) - (a.lastRunAt ?? a.updatedAt))
    },

    listScoped(scope) {
      const want = scope ?? 'project'
      return this.list().filter((w) => scopeOf(w) === want)
    },

    get(id) {
      return items.find((w) => w.id === id)
    },

    getByName(name, scope) {
      const want = scope ?? 'project'
      return items.find((w) => w.name === name.trim() && scopeOf(w) === want)
    },

    setMeta(id, meta) {
      const existing = items.find((w) => w.id === id)
      if (!existing) return undefined
      const updated: SavedWorkflow = {
        ...existing,
        description: meta.description,
        ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
        ...(meta.args !== undefined ? { args: meta.args } : {}),
        updatedAt: Date.now(),
      }
      items = items.map((w) => (w.id === id ? updated : w))
      flush()
      return updated
    },

    filePath() {
      return path
    },

    save(input) {
      const now = Date.now()
      const name = input.name.trim()
      const existing = items.find((w) => w.name === name)
      if (existing) {
        const updated: SavedWorkflow = {
          ...existing,
          scriptText: input.scriptText,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.args !== undefined ? { args: input.args } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          updatedAt: now,
        }
        items = items.map((w) => (w.id === existing.id ? updated : w))
        flush()
        return updated
      }
      const created: SavedWorkflow = {
        id: `wf-${slug(name)}-${now.toString(36)}`,
        name,
        scriptText: input.scriptText,
        createdAt: now,
        updatedAt: now,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {}),
        scope: input.scope ?? 'project',
      }
      items = [...items, created]
      flush()
      return created
    },

    remove(id) {
      const before = items.length
      items = items.filter((w) => w.id !== id)
      if (items.length === before) return false
      flush()
      return true
    },

    resolveArgs(id, provided) {
      const wf = items.find((w) => w.id === id)
      if (!wf) return { ok: false, error: 'not_found' }
      const given = provided ?? {}
      const out: Record<string, unknown> = {}
      for (const decl of wf.args ?? []) {
        const raw = Object.prototype.hasOwnProperty.call(given, decl.name) ? given[decl.name] : decl.default
        if (raw === undefined) {
          if (decl.required) return { ok: false, error: `missing required argument: ${decl.name}` }
          continue
        }
        const coerced = coerce(decl.type, raw)
        if (!coerced.ok) return { ok: false, error: `argument ${decl.name} must be a ${decl.type}` }
        out[decl.name] = coerced.value
      }
      // Unknown arguments are refused rather than ignored: a typo that silently
      // runs the workflow with a default is worse than an error message.
      for (const key of Object.keys(given)) {
        if (!(wf.args ?? []).some((d) => d.name === key)) return { ok: false, error: `unknown argument: ${key}` }
      }
      return { ok: true, args: out }
    },

    noteRun(id) {
      items = items.map((w) => (w.id === id ? { ...w, runCount: (w.runCount ?? 0) + 1, lastRunAt: Date.now() } : w))
      flush()
    },
  }
}

/** Default location, next to the rest of the workflow state. */
export function defaultSavedWorkflowsPath(workflowsDir: string): string {
  return join(workflowsDir, 'saved.json')
}
