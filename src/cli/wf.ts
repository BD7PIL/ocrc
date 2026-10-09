import { createFileBackedState } from '../core/state.js'
import { createWorkflowJournal } from '../core/workflow/journal.js'
import { createArtifactStore } from '../core/workflow/artifacts.js'
import { createWorldReader } from '../core/workflow/world.js'
import { createSavedWorkflowsStore } from '../core/workflow/saved.js'
import { createWorkflowManager } from '../core/workflow/manager.js'
import { createBackendRegistry } from '../core/agent/registry.js'
import { createOpencodeBackend } from '../core/agent/opencode-backend.js'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { loadPluginConfig } from '../plugin/config.js'
import { createLogger } from '../utils/logger.js'
import { join } from 'node:path'
import { ocrcHome } from '../utils/paths.js'

const log = createLogger('wf-cli')

/**
 * `ocrc wf …` — the workflow line without the web panel.
 *
 * It builds the same manager the host builds, over the same on-disk journal, so
 * a run started here is visible in the panel and vice versa. The engine backend is
 * only needed for runs that actually dispatch actor sessions; list/show/cancel/
 * resume/events read and steer state, which is why they work with no engine up.
 */
const HELP = `
ocrc wf — dynamic workflows (vendored dwf engine)

USAGE:
  ocrc wf list [--json]                 List runs (newest first)
  ocrc wf show <runId> [--json]         One run: status, actors, nodes
  ocrc wf events <runId> [--after N]    Journal events
  ocrc wf cancel <runId>                Stop a run in this process (if any)
  ocrc wf resume <runId>                Resume a stopped run
  ocrc wf amend <runId> <scriptFile>    Supersede a run with a revised script
  ocrc wf run <scriptFile> [--cwd DIR]  Start a run from a script file
  ocrc wf compile <scriptFile>          Typecheck a script and print diagnostics
  ocrc wf saved                         List saved workflows
  ocrc wf --help                        This text
`

function workflowsDir(): string {
  return join(ocrcHome(), 'workflows')
}

function makeManager(cwd: string) {
  const dir = workflowsDir()
  const state = createFileBackedState(join(ocrcHome(), 'state.json'))
  // The CLI steers the SAME engine the host uses (OCRC_SERVER_URL / OCRC_SERVER_PORT)
  // — a run started here therefore appears in the panel with the same actor
  // sessions. Commands that never dispatch an ask (list/show/events/compile) work
  // even when no engine is up, because nothing calls this backend.
  const config = loadPluginConfig(undefined, { requireTelegram: false })
  const baseUrl = config.serverUrl || `http://127.0.0.1:${config.serverPort}`
  const registry = createBackendRegistry({
    backends: [{
      id: 'opencode',
      backend: createOpencodeBackend({ id: 'opencode', baseUrl, client: createOpencodeClient({ baseUrl }) as never }),
    }],
    state,
  })
  const journal = createWorkflowJournal({ dir })
  const artifacts = createArtifactStore({ dir, cwd })
  const world = createWorldReader({
    cwd,
    approve: (cmd, args) => {
      const allow = process.env.OCRC_WORKFLOW_RUN !== 'off'
      log.warn(`${allow ? 'ALLOWING' : 'DENYING'} world.run \`${cmd} ${args.join(' ').slice(0, 120)}\``)
      return allow
    },
  })
  const saved = createSavedWorkflowsStore(join(dir, 'saved.json'))
  const manager = createWorkflowManager({ registry, journal, world, artifacts, onSettled: () => { /* CLI exits on its own */ } })
  return { manager, journal, artifacts, saved }
}

function fmtTime(ms: number | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); return }
  const rest = argv.slice(1)
  const json = rest.includes('--json')
  const cwd = (() => {
    const i = rest.indexOf('--cwd')
    return i >= 0 && rest[i + 1] ? rest[i + 1] : process.cwd()
  })()

  const { manager, artifacts, saved } = makeManager(cwd)

  if (sub === 'list') {
    const runs = manager.list()
    if (json) { console.log(JSON.stringify(runs, null, 2)); return }
    if (runs.length === 0) { console.log('（没有 workflow run）'); return }
    for (const r of runs) {
      const live = manager.live().includes(r.runId) ? ' ·running' : ''
      console.log(`${r.runId}  ${r.status.padEnd(10)}${live}  ${fmtTime((r as { createdAt?: number }).createdAt)}  ${r.name ?? ''}`)
    }
    return
  }

  if (sub === 'show') {
    const id = rest[0]
    if (!id) { console.error('runId required'); process.exitCode = 1; return }
    const view = manager.get(id)
    if (!view) { console.error(`no such run: ${id}`); process.exitCode = 1; return }
    if (json) { console.log(JSON.stringify(view, null, 2)); return }
    console.log(`run       ${view.record.runId}`)
    console.log(`status    ${view.record.status}${view.record.stopReason ? ` (${view.record.stopReason})` : ''}`)
    console.log(`name      ${view.record.name ?? '—'}`)
    console.log(`cwd       ${view.record.cwd ?? '—'}`)
    console.log(`tokens    ${view.record.spentTokens}`)
    console.log(`caps      maxConcurrency=${view.record.caps.maxConcurrency}`)
    console.log(`actors    ${view.actors.length}`)
    for (const a of view.actors) console.log(`  - ${a.name ?? `${a.siteId}#${a.ordinal}`} → ${a.sessionId ?? '(no session)'}${a.resolvedModel ? ` @${a.resolvedModel}` : ''}`)
    console.log(`nodes     ${view.nodes.length}`)
    for (const n of view.nodes) console.log(`  - [${n.status}] ${n.kind} ${n.siteId}#${n.ordinal}${n.artifactId ? ` (${n.artifactId})` : ''}`)
    return
  }

  if (sub === 'events') {
    const id = rest[0]
    if (!id) { console.error('runId required'); process.exitCode = 1; return }
    const i = rest.indexOf('--after')
    const after = i >= 0 ? Number(rest[i + 1]) : undefined
    const events = manager.events(id, after !== undefined ? { afterSequence: after } : undefined)
    if (json) { console.log(JSON.stringify(events, null, 2)); return }
    for (const e of events) console.log(`${String(e.sequence).padStart(4)}  ${fmtTime(e.timeCreated)}  ${(e.event as { type: string }).type}`)
    return
  }

  if (sub === 'cancel' || sub === 'resume') {
    const id = rest[0]
    if (!id) { console.error('runId required'); process.exitCode = 1; return }
    if (sub === 'cancel') {
      const ok = manager.cancel(id)
      console.log(ok ? `cancelled ${id}` : `${id} is not running in this process (the host owns live runs)`)
      return
    }
    const res = await manager.resume(id)
    if (!res.ok) { console.error(`resume failed: ${res.error}`); process.exitCode = 1; return }
    console.log(`resumed ${id}`)
    return
  }

  if (sub === 'amend' || sub === 'run' || sub === 'compile') {
    const file = rest[0]
    if (!file) { console.error('script file required'); process.exitCode = 1; return }
    const { readFileSync } = await import('node:fs')
    let scriptText: string
    try { scriptText = readFileSync(file, 'utf-8') } catch (err) {
      console.error(`cannot read ${file}: ${(err as Error).message}`); process.exitCode = 1; return
    }
    if (sub === 'compile') {
      const { compileScript } = await import('../core/workflow/manager.js')
      const out = compileScript(scriptText)
      if (out.ok) { console.log(`ok — ${out.askSpecs?.size ?? 0} ask site(s), hash ${out.scriptHash?.slice(0, 12)}`); return }
      for (const d of out.diagnostics) console.log(`TS${d.code} ${d.line ?? '?'}:${d.column ?? '?'} ${d.message}`)
      process.exitCode = 1
      return
    }
    if (sub === 'amend') {
      const target = rest[1]
      if (!target) { console.error('runId required'); process.exitCode = 1; return }
      const res = await manager.amend(target, scriptText)
      if (!res.ok) { console.error(`amend failed: ${res.error}`); process.exitCode = 1; return }
      console.log(`amended ${target} → ${res.runId}`)
      return
    }
    const i = rest.indexOf('--name')
    const res = await manager.submit({
      scriptText,
      cwd,
      ...(i >= 0 && rest[i + 1] ? { name: rest[i + 1] } : {}),
    })
    if (!res.ok) {
      console.error(`run failed to start: ${res.error}`)
      for (const d of res.diagnostics ?? []) console.error(`  TS${d.code} ${d.line ?? '?'}:${d.column ?? '?'} ${d.message}`)
      process.exitCode = 1
      return
    }
    console.log(`started ${res.runId} (artifacts under ${artifacts.versionPath(res.runId, '<id>', 1)})`)
    return
  }

  if (sub === 'saved') {
    const list = saved.list()
    if (json) { console.log(JSON.stringify(list, null, 2)); return }
    if (list.length === 0) { console.log('（没有已保存的 workflow）'); return }
    for (const w of list) console.log(`${w.id}  ${w.name}  runs=${w.runCount ?? 0}  ${w.description ?? ''}`)
    return
  }

  console.log(HELP)
}
