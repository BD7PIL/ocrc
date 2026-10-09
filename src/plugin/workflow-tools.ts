import { tool } from '@opencode-ai/plugin'
import type { Hooks } from '@opencode-ai/plugin'
import type { AttachedOpts } from './attached.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('wf-tools')

/**
 * P3: the workflow tool face.
 *
 * These are the tools the MODEL authors workflows with. Two design points carry
 * almost all of the agent effect, and both come from the upstream design rather
 * than from us:
 *
 *  - **The skill gate.** `CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` /
 *    `EvalWorkflowSnippet` refuse until the authoring skill has been loaded in this
 *    session (the vendored skill says so in its own first section). The gate is what
 *    turns "the model guesses the facade" into "the model read the contract".
 *  - **Compile feedback is a first-class tool.** `EvalWorkflowSnippet` typechecks a
 *    script WITHOUT creating a run and returns located diagnostics, so the model can
 *    iterate cheaply before spending a run.
 *
 * Every tool here is a thin HTTP call to the host, and every one is stateless: the
 * host assigns run ids (see docs/workflow-p0-tool-registration.md for why that is
 * load-bearing when opencode keeps duplicate tool registrations).
 */

/** Per-process skill gate. Keyed by session so one workspace loading the skill
 *  does not unlock another's authoring. */
const skillLoaded = new Set<string>()
export function markSkillLoaded(sessionId: string): void { skillLoaded.add(sessionId) }
export function isSkillLoaded(sessionId: string | undefined): boolean {
  return sessionId ? skillLoaded.has(sessionId) : false
}

const SKILL_REFUSAL =
  'Refused: the `dynamic-workflows` skill has not been loaded in this session yet.\n' +
  'Call the `skill` tool with name "dynamic-workflows" first (or `GetWorkflowSkill`), then retry. ' +
  'The skill is the whole authoring contract — the facade, the rules a script must satisfy and the ' +
  'fields each tool takes are in it, and scripts written without it fail the compiler.'

async function call<T>(opts: AttachedOpts, path: string, init?: RequestInit): Promise<T> {
  const token = opts.resolveToken()
  if (!token) throw new Error('host token not readable yet — the host may still be starting')
  const res = await fetch(`${opts.baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ocrc host ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : {}) as T
}

const down = (opts: AttachedOpts, name: string, err: unknown): string =>
  `${name} failed: ocrc host unreachable at ${opts.baseUrl} (${(err as Error).message}).`

/**
 * A host answer that is a *refusal* (compile diagnostics, "no ask in flight",
 * "no matching question") is a normal outcome the model must see verbatim — not a
 * transport failure. `call` throws on any non-2xx, so the tools that expect
 * refusals use this instead and read the body.
 */
async function callOr<T>(opts: AttachedOpts, path: string, init?: RequestInit): Promise<{ status: number; body: T } | { status: number; error: string }> {
  const token = opts.resolveToken()
  if (!token) return { status: 0, error: 'host token not readable yet — the host may still be starting' }
  try {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(120_000),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T }
  } catch (err) {
    return { status: 0, error: (err as Error).message }
  }
}

/** Diagnostics as the model should see them: one located line each. */
export function formatDiagnostics(diagnostics: Array<{ code: number; line?: number; column?: number; message: string }>): string {
  if (diagnostics.length === 0) return ''
  return diagnostics
    .map((d) => `  L${d.line ?? '?'}:C${d.column ?? '?'}  TS${d.code}  ${d.message}`)
    .join('\n')
}

export function createWorkflowTools(opts: AttachedOpts): Record<string, ReturnType<typeof tool>> {
  const gated = (sessionId: string | undefined): string | undefined =>
    isSkillLoaded(sessionId) ? undefined : SKILL_REFUSAL

  return {
    GetWorkflowSkill: tool({
      description:
        'Read the dynamic-workflows authoring skill (the contract for CreateWorkflow scripts: the facade, ' +
        'the rules, and every tool field). Call this before writing your first workflow script.',
      args: {
        file: tool.schema.string().optional().describe('SKILL.md (default), patterns.md or examples.md'),
      },
      async execute(args: { file?: string }, context: any) {
        try {
          const res = await call<{ file: string; text: string }>(opts, `/api/workflow/skill?file=${encodeURIComponent(args.file ?? 'SKILL.md')}`)
          if (context?.sessionID) markSkillLoaded(context.sessionID)
          return `${res.file} (${res.text.split('\n').length} lines)\n\n${res.text}`
        } catch (err) {
          return down(opts, 'GetWorkflowSkill', err)
        }
      },
    }),

    EvalWorkflowSnippet: tool({
      description:
        'Typecheck a workflow script WITHOUT running it, and get back located diagnostics. Use this to iterate ' +
        'on a script before creating a run — a compile error here costs nothing.',
      args: { script: tool.schema.string().describe('The workflow script source to typecheck') },
      async execute(args: { script: string }, context: any) {
        const refusal = gated(context?.sessionID)
        if (refusal) return refusal
        const res = await callOr<{ ok: boolean; askSites?: number; scriptHash?: string; declaredRunCommands?: string[]; diagnostics?: Array<{ code: number; line?: number; column?: number; message: string }> }>(
          opts, '/api/workflow/compile', { method: 'POST', body: JSON.stringify({ scriptText: args.script }) },
        )
        if ('error' in res) return down(opts, 'EvalWorkflowSnippet', res.error)
        if (res.body.ok) {
          return [
            'Compiles clean.',
            `ask sites: ${res.body.askSites}`,
            res.body.declaredRunCommands?.length ? `world.run commands (all need approval at run time): ${res.body.declaredRunCommands.join(', ')}` : 'world.run: none',
          ].join('\n')
        }
        return `Compile failed (${res.body.diagnostics?.length ?? 0} diagnostic(s)):\n${formatDiagnostics(res.body.diagnostics ?? [])}`
      },
    }),

    CreateWorkflow: tool({
      description:
        'Start a dynamic workflow run from a TypeScript script. The script is compiled first; a script that does ' +
        'not typecheck creates no run and returns its diagnostics. The run continues in the background — use ' +
        'GetWorkflowRun to follow it.',
      args: {
        script: tool.schema.string().describe('The workflow script source'),
        name: tool.schema.string().optional().describe('Short human-readable run name'),
        workspace: tool.schema.string().optional().describe('Absolute workspace directory the run executes in (defaults to the current one)'),
        tokenBudget: tool.schema.number().optional().describe('Stop the run once it spends more than this many tokens'),
      },
      async execute(args: { script: string; name?: string; workspace?: string; tokenBudget?: number }, context: any) {
        const refusal = gated(context?.sessionID)
        if (refusal) return refusal
        const res = await callOr<{ runId?: string; error?: string; diagnostics?: Array<{ code: number; line?: number; column?: number; message: string }> }>(
          opts, '/api/workflow/runs', {
            method: 'POST',
            body: JSON.stringify({
              scriptText: args.script,
              ...(args.name ? { name: args.name } : {}),
              ...(args.workspace ? { cwd: args.workspace } : {}),
              ...(typeof args.tokenBudget === 'number' ? { tokenBudget: args.tokenBudget } : {}),
              ...(context?.sessionID ? { sessionId: context.sessionID } : {}),
            }),
          },
        )
        if ('error' in res) return down(opts, 'CreateWorkflow', res.error)
        if (!res.body.runId) {
          return `CreateWorkflow failed (${res.body.error ?? 'unknown'}) — no run was created.\n${formatDiagnostics(res.body.diagnostics ?? [])}`
        }
        return `Run started: ${res.body.runId}\nIt continues in the background. Follow it with GetWorkflowRun({ runId: "${res.body.runId}" }).`
      },
    }),

    AmendWorkflow: tool({
      description:
        'Revise a finished workflow run with a new script. The predecessor is superseded (it stops being resumable) ' +
        'and a new run starts from the revision.',
      args: {
        runId: tool.schema.string().describe('The run to revise'),
        script: tool.schema.string().describe('The revised script source'),
      },
      async execute(args: { runId: string; script: string }, context: any) {
        const refusal = gated(context?.sessionID)
        if (refusal) return refusal
        const res = await callOr<{ runId?: string; error?: string; diagnostics?: Array<{ code: number; line?: number; column?: number; message: string }> }>(
          opts, `/api/workflow/runs/${encodeURIComponent(args.runId)}/amend`, {
            method: 'POST', body: JSON.stringify({ scriptText: args.script }),
          },
        )
        if ('error' in res) return down(opts, 'AmendWorkflow', res.error)
        if (!res.body.runId) return `AmendWorkflow failed (${res.body.error ?? 'unknown'}).\n${formatDiagnostics(res.body.diagnostics ?? [])}`
        return `Revised run started: ${res.body.runId} (supersedes ${args.runId}).`
      },
    }),

    GetWorkflowRun: tool({
      description: 'Report a workflow run: status, its subagents, what each step produced, and the latest events.',
      args: {
        runId: tool.schema.string().describe('The run id returned by CreateWorkflow'),
        events: tool.schema.number().optional().describe('How many recent events to include (default 15)'),
      },
      async execute(args: { runId: string; events?: number }) {
        try {
          const view = await call<{
            record: { runId: string; status: string; stopReason?: string; name?: string; spentTokens: number; failure?: { code: string; message: string }; result?: unknown }
            actors: Array<{ name?: string; siteId: string; ordinal: number; sessionId?: string; resolvedModel?: string }>
            nodes: Array<{ kind: string; status: string; siteId: string; ordinal: number; artifactId?: string; error?: { message?: string } }>
          }>(opts, `/api/workflow/runs/${encodeURIComponent(args.runId)}`)
          const events = await call<{ events: Array<{ sequence: number; event: { type: string } }>; live: boolean }>(
            opts, `/api/workflow/runs/${encodeURIComponent(args.runId)}/events`,
          )
          const r = view.record
          const lines = [
            `run ${r.runId} — ${r.status}${r.stopReason ? ` (${r.stopReason})` : ''}${events.live ? ' · running now' : ''}`,
            r.name ? `name: ${r.name}` : '',
            `tokens: ${r.spentTokens}`,
            r.failure ? `failure: ${r.failure.code} — ${r.failure.message}` : '',
            view.actors.length ? `subagents:\n${view.actors.map((a) => `  - ${a.name ?? `${a.siteId}#${a.ordinal}`}${a.resolvedModel ? ` @${a.resolvedModel}` : ''} → ${a.sessionId ?? '(no session)'}`).join('\n')}` : 'subagents: none',
            view.nodes.length
              ? `steps:\n${view.nodes.map((n) => `  - [${n.status}] ${n.kind} ${n.siteId}#${n.ordinal}${n.artifactId ? ` → artifact ${n.artifactId}` : ''}${n.error?.message ? ` — ${n.error.message}` : ''}`).join('\n')}`
              : 'steps: none',
            r.status === 'completed' && r.result !== undefined ? `result: ${JSON.stringify(r.result).slice(0, 2000)}` : '',
            `recent events (${Math.min(args.events ?? 15, events.events.length)} of ${events.events.length}):\n` +
              events.events.slice(-(args.events ?? 15)).map((e) => `  ${e.sequence} ${e.event.type}`).join('\n'),
          ]
          return lines.filter(Boolean).join('\n')
        } catch (err) {
          return down(opts, 'GetWorkflowRun', err)
        }
      },
    }),

    ListWorkflowRuns: tool({
      description: 'List recent workflow runs (newest first) with status and name.',
      args: {},
      async execute() {
        try {
          const res = await call<{ runs: Array<{ runId: string; status: string; name?: string; stopReason?: string; spentTokens: number }> }>(opts, '/api/workflow/runs')
          if (res.runs.length === 0) return '（没有 workflow run）'
          return res.runs.slice(0, 30).map((r) => `${r.runId}  ${r.status}${r.stopReason ? `(${r.stopReason})` : ''}  ${r.spentTokens}tok  ${r.name ?? ''}`).join('\n')
        } catch (err) {
          return down(opts, 'ListWorkflowRuns', err)
        }
      },
    }),

    ResumeWorkflowRun: tool({
      description: 'Resume a stopped workflow run. It continues from its journal — finished steps are not redone.',
      args: { runId: tool.schema.string().describe('The stopped run to resume') },
      async execute(args: { runId: string }) {
        const res = await callOr<{ ok?: boolean; error?: string }>(opts, `/api/workflow/runs/${encodeURIComponent(args.runId)}/resume`, { method: 'POST', body: '{}' })
        if ('error' in res) return down(opts, 'ResumeWorkflowRun', res.error)
        return res.body.ok ? `Resumed ${args.runId}.` : `Resume refused: ${res.body.error}`
      },
    }),

    SaveWorkflow: tool({
      description: 'Save a workflow script under a name so it can be started again later with its declared arguments.',
      args: {
        name: tool.schema.string().describe('Name to save under (saving an existing name overwrites it)'),
        script: tool.schema.string().describe('The workflow script source'),
        description: tool.schema.string().optional().describe('One line on what it does'),
      },
      async execute(args: { name: string; script: string; description?: string }, context: any) {
        const refusal = gated(context?.sessionID)
        if (refusal) return refusal
        const res = await callOr<{ workflow?: { id: string; name: string }; error?: string }>(opts, '/api/workflow/saved', {
          method: 'POST',
          body: JSON.stringify({ name: args.name, scriptText: args.script, ...(args.description ? { description: args.description } : {}) }),
        })
        if ('error' in res) return down(opts, 'SaveWorkflow', res.error)
        return res.body.workflow ? `Saved as "${res.body.workflow.name}" (${res.body.workflow.id}).` : `SaveWorkflow failed: ${res.body.error}`
      },
    }),

    ListSavedWorkflows: tool({
      description: 'List the saved workflows with their ids, names and run counts.',
      args: {},
      async execute() {
        try {
          const res = await call<{ workflows: Array<{ id: string; name: string; description?: string; runCount?: number }> }>(opts, '/api/workflow/saved')
          if (res.workflows.length === 0) return '（没有已保存的 workflow）'
          return res.workflows.map((w) => `${w.id}  ${w.name}  runs=${w.runCount ?? 0}${w.description ? `  ${w.description}` : ''}`).join('\n')
        } catch (err) {
          return down(opts, 'ListSavedWorkflows', err)
        }
      },
    }),

    // ── actor-side tools ─────────────────────────────────────────────────────
    // These are for the SUBAGENTS the workflow script spawns, not for the author.
    submit_result: tool({
      description:
        'Submit the result of a typed task. Call this exactly once when your task has a declared result type; ' +
        'the value must satisfy the schema you were given.',
      args: { result: tool.schema.unknown().describe('The result value') },
      async execute(args: { result: unknown }, context: any) {
        const res = await callOr<{ ok: boolean; note?: string; error?: string }>(opts, '/api/workflow/submit', {
          method: 'POST',
          body: JSON.stringify({ sessionId: context?.sessionID, payload: args.result }),
        })
        if ('error' in res) return down(opts, 'submit_result', res.error)
        return res.body.ok ? (res.body.note ?? 'submitted') : `submit_result refused: ${res.body.error}`
      },
    }),

    escalate: tool({
      description:
        'Ask the user a question the workflow cannot answer by itself. Continue with your best judgment if no ' +
        'answer comes back — do not block the run.',
      args: {
        question: tool.schema.string().describe('The question, with the context needed to answer it'),
        runId: tool.schema.string().optional().describe('The workflow run you belong to, if you know it'),
      },
      async execute(args: { question: string; runId?: string }, context: any) {
        try {
          const res = await call<{ answer: string | null; note: string }>(opts, '/api/workflow/escalate', {
            method: 'POST',
            body: JSON.stringify({ question: args.question, runId: args.runId, sessionId: context?.sessionID }),
          })
          return res.answer ? `Answer: ${res.answer}` : res.note
        } catch (err) {
          return down(opts, 'escalate', err)
        }
      },
    }),

    ResolveWorkflowQuestion: tool({
      description: 'Answer a question a running workflow raised (see the escalations listed by GetWorkflowRun).',
      args: {
        question: tool.schema.string().describe('The exact question text that was escalated'),
        answer: tool.schema.string().describe('The answer'),
        runId: tool.schema.string().optional().describe('The run that asked'),
      },
      async execute(args: { question: string; answer: string; runId?: string }) {
        const res = await callOr<{ ok: boolean; pending?: string[] }>(opts, '/api/workflow/escalations/answer', {
          method: 'POST',
          body: JSON.stringify(args),
        })
        if ('error' in res) return down(opts, 'ResolveWorkflowQuestion', res.error)
        if (!res.body.ok) return 'No matching pending question — check GetWorkflowRun for the exact text.'
        return res.body.pending?.length ? `Answered. Still pending: ${res.body.pending.length}` : 'Answered.'
      },
    }),
  }
}

/** The `tool.execute.before` hook that opens the skill gate when the model loads
 *  the authoring skill through opencode's own `skill` tool. */
export function skillGateHook(): NonNullable<Hooks['tool.execute.before']> {
  return async (input) => {
    if (input.tool !== 'skill') return
    const args = (input as { args?: { name?: string } }).args
    if (args?.name && /dynamic-workflow/i.test(args.name)) {
      markSkillLoaded(input.sessionID)
      log.info(`skill gate opened for ${input.sessionID.slice(-8)} (${args.name})`)
    }
  }
}
