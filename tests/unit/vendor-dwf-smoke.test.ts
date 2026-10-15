// P1 gate — the vendored upstream engine must actually work, not just compile.
//
// This is the "does our build of the vendored dwf tree behave" test: it drives the
// SAME pipeline the upstream run service uses (createWorkflowProgram → diagnostics
// → collectSites → synthesizeAskSchemas → buildAskSpecs → lowerWorkflow) and then
// runs the lowered body through the real sandbox harness with a fake driver and an
// in-memory journal. If the vendoring or the build layout drifted, this fails.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InMemoryJournalStore,
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  lowerWorkflow,
  synthesizeAskSchemas,
  validate,
  type AskMessage,
  type AskSpec,
  type RunEvent,
  type RunSettlement,
  type SubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
} from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import { runWorkflowScript } from '../../vendor/zcode-dwf/dist/dynamic-workflow-runtime/src/index.js'

/** Mirrors the upstream compile pipeline (bootstrap/app/dynamic-workflow-run-submit.ts). */
function compile(scriptText: string) {
  const workflow = createWorkflowProgram(scriptText)
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ].map((d) => {
    const loc = d.start === undefined ? undefined : workflow.toScriptLoc(d.start)
    return {
      code: d.code,
      line: loc?.line,
      column: loc?.column,
      message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText,
    }
  })
  if (diagnostics.length > 0) return { ok: false as const, diagnostics }
  const table = collectSites(workflow)
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table)
  if (schemaDiagnostics.length > 0) return { ok: false as const, diagnostics: schemaDiagnostics }
  return {
    ok: true as const,
    schemas,
    askSpecs: buildAskSpecs(table, schemas),
    lowered: lowerWorkflow(workflow, table).code,
  }
}

const TYPED_SCRIPT = `
interface Verdict {
  ok: boolean;
  reason?: string;
}
const reviewer = agent("reviewer");
const verdict = await reviewer.ask<Verdict>("Review the diff and answer with a verdict.");
const summary = await agent("writer").ask("Summarize the review in one line.");
log("both asks settled");
return { verdict, summary };
`

interface FakeRun {
  driver: WorkflowDriver
  asked: AskMessage[]
  verdicts: SubmitVerdict[]
  events: RunEvent[]
  sessions: string[]
  journal: InMemoryJournalStore
}

function makeRun(): { run: FakeRun; makeDriver: (sink: WorkflowReportSink) => WorkflowDriver } {
  const journal = new InMemoryJournalStore()
  const run: FakeRun = { driver: undefined as unknown as WorkflowDriver, asked: [], verdicts: [], events: [], sessions: [], journal }
  // The engine hands the driver its upward report face AFTER the driver is built
  // (makeDriver is called with the sink), so the fake closes over a late-bound ref.
  let sinkRef: WorkflowReportSink | undefined
  run.driver = {
    async createActorSession(actor) {
      const id = `ses_${actor.siteId}_${actor.ordinal}`
      run.sessions.push(id)
      return { id }
    },
    startAsk(_session, instance, message) {
      run.asked.push(message)
      // A typed ask submits a value (the engine validates it and answers with a
      // verdict); an untyped ask ends the turn with final text.
      if (message.typed) sinkRef!.askSubmitAttempted(instance, { ok: true, reason: 'no findings' })
      else sinkRef!.askTurnEnded(instance, 'one-line summary')
    },
    respondToSubmit(_instance, verdict) {
      run.verdicts.push(verdict)
    },
    cancelAsk() { /* nothing in flight in this fake */ },
    async executeWorldRead() { return { ok: true } },
    journal,
    emit(event) { run.events.push(event) },
  }
  const makeDriver = (sink: WorkflowReportSink) => {
    sinkRef = sink
    return run.driver
  }
  return { run, makeDriver }
}

async function runScript(scriptText: string, lowered: string) {
  const { run, makeDriver } = makeRun()
  const compiled = compile(scriptText)
  if (!compiled.ok) throw new Error(`fixture script must compile: ${JSON.stringify(compiled.diagnostics)}`)
  const cwd = mkdtempSync(join(tmpdir(), 'ocrc-dwf-'))
  const settlement: RunSettlement = await runWorkflowScript({
    scriptText,
    lowered,
    runId: 'dwfrun-test-1',
    cwd,
    makeDriver,
    caps: { maxConcurrency: 4 },
    askSpecs: compiled.askSpecs as ReadonlyMap<string, AskSpec>,
    validate: (schema, value) => validate(schema as never, value),
  })
  return { settlement, run, cwd }
}

describe('vendored dwf: compile pipeline', () => {
  it('compiles a typed-ask script and synthesizes the ask schema', () => {
    const out = compile(TYPED_SCRIPT)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const schemas = Object.values(out.schemas)
    expect(schemas).toHaveLength(1) // only the typed ask emits a schema
    expect(schemas[0]).toMatchObject({
      type: 'object',
      properties: { ok: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['ok'],
    })
    // Both sites are present in askSpecs — the untyped one explicitly.
    expect([...out.askSpecs.values()].filter((s) => s.typed)).toHaveLength(1)
    expect([...out.askSpecs.values()].filter((s) => !s.typed)).toHaveLength(1)
    // The lowered body is an async function body whose only free identifier is __host.
    expect(out.lowered).toContain('__host')
  })

  it('reports a deliberate mistake with a script-located diagnostic', () => {
    const out = compile(`
const n: number = await agent("a").ask("give me a number");
const bad: string = n;
return bad;
`)
    expect(out.ok).toBe(false)
    if (out.ok) return
    const wrongAssignment = out.diagnostics.find((d) => d.code === 2322)
    expect(wrongAssignment).toBeDefined()
    expect(wrongAssignment!.line).toBe(3) // the authored line, not the wrapper's
    expect(wrongAssignment!.message).toContain('string')
  })

  it('refuses an unsupported ask result type instead of guessing a schema', () => {
    const out = compile(`
interface Holder { fn: () => void }
const h = await agent("a").ask<Holder>("give me a callable");
return h;
`)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.diagnostics.length).toBeGreaterThan(0)
  })

  it('validates values against the synthesized schema (the typed-submit gate)', () => {
    const out = compile(TYPED_SCRIPT)
    if (!out.ok) throw new Error('fixture must compile')
    const schema = Object.values(out.schemas)[0]
    expect(validate(schema as never, { ok: true })).toHaveLength(0)
    expect(validate(schema as never, { ok: 'yes' })).not.toHaveLength(0)
  })
})

describe('vendored dwf: sandbox run with a fake driver', () => {
  it('runs the lowered body in a child process and settles completed', async () => {
    const compiled = compile(TYPED_SCRIPT)
    if (!compiled.ok) throw new Error('fixture must compile')

    const { settlement, run, cwd } = await runScript(TYPED_SCRIPT, compiled.lowered)

    expect(settlement.status).toBe('completed')
    // Both asks reached the driver, in script order, with the typed one flagged.
    expect(run.asked.map((a) => a.typed)).toEqual([true, false])
    expect(run.asked[0].instructions).toContain('Review the diff')
    // The engine accepted the submitted value (no repair was needed).
    expect(run.verdicts).toEqual([{ kind: 'accept' }])
    // The script's return value crossed back out of the sandbox (RunSettlement
    // calls it `artifact` — it is the top-level `return`). Narrow the union to
    // the completed member first.
    expect(settlement.status === 'completed' ? settlement.artifact : undefined).toMatchObject({
      verdict: { ok: true, reason: 'no findings' },
      summary: 'one-line summary',
    })
    // The harness wrote its child entry file into the run's cwd.
    expect(existsSync(join(cwd, '.zcode', 'workflow-runs'))).toBe(true)
  })

  it('journals the run: terminal status, one actor, two settled ask nodes', async () => {
    const compiled = compile(TYPED_SCRIPT)
    if (!compiled.ok) throw new Error('fixture must compile')
    const { run } = await runScript(TYPED_SCRIPT, compiled.lowered)

    expect(run.journal.getRun('dwfrun-test-1')?.status).toBe('completed')
    // Both named actors got a session (the fake driver is asked to mint them).
    expect(run.sessions).toHaveLength(2)
    const nodes = run.journal.listNodes('dwfrun-test-1', { kinds: 'all', withResult: true })
    expect(nodes.length).toBeGreaterThanOrEqual(2)
    expect(nodes.every((n) => n.kind === 'ask' && n.status === 'completed')).toBe(true)
    // Boundary C events reached the driver's emit.
    expect(run.events.some((e) => e.type === 'run-settled')).toBe(true)
  })

  it('a script that throws settles failed rather than hanging', async () => {
    const script = `
await agent("a").ask("do nothing");
throw new Error("boom from the script");
`
    const compiled = compile(script)
    if (!compiled.ok) throw new Error(`fixture must compile: ${JSON.stringify(compiled.diagnostics)}`)
    const { settlement } = await runScript(script, compiled.lowered)
    // A script's own throw is the script's fault → `errored` (not resumable);
    // `stopped` is reserved for cancels.
    expect(settlement.status).toBe('errored')
    expect(settlement.status === 'errored' && settlement.error.code).toBeTruthy()
  })

  it('keeps the sandbox sealed: no process/require/fetch reachable from the script', () => {
    const out = compile(`
const p = process.env.HOME;
const r = require("fs");
return p;
`)
    expect(out.ok).toBe(false)
    if (out.ok) return
    // TS2591 "Cannot find name 'process'" — the facade deliberately has no ambient
    // @types/node, so the purity contract starts at compile time.
    expect(out.diagnostics.some((d) => d.code === 2591 && d.message.includes('process'))).toBe(true)
    expect(out.diagnostics.some((d) => d.code === 2591 && d.message.includes('require'))).toBe(true)
  })
})
