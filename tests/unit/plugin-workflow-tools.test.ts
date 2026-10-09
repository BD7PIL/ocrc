// P3 — the workflow tool face. Two behaviours carry the agent effect: the skill
// gate (create-class tools refuse until the authoring contract is loaded) and
// compile feedback (EvalWorkflowSnippet returns located diagnostics without
// creating a run).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWorkflowTools, formatDiagnostics, isSkillLoaded, markSkillLoaded, skillGateHook } from '../../src/plugin/workflow-tools'

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const OPTS = { baseUrl: 'http://127.0.0.1:4199', resolveToken: () => 'test-token', version: '1.0.0-rc.5' }
const SES = { sessionID: 'ses_author' }

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response
}
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return handler(String(url), init) }))
  return calls
}
afterEach(() => { vi.unstubAllGlobals() })

const freshSession = () => `ses_${Math.random().toString(36).slice(2)}`

describe('workflow tools — skill gate', () => {
  it('refuses the create-class tools until the skill has been loaded', async () => {
    const calls = stubFetch(() => jsonResponse({}))
    const tools = createWorkflowTools(OPTS)
    const ses = { sessionID: freshSession() }

    for (const name of ['CreateWorkflow', 'AmendWorkflow', 'SaveWorkflow', 'EvalWorkflowSnippet']) {
      const args = name === 'AmendWorkflow' ? { runId: 'r', script: 'x' } : { script: 'x', name: 'x' }
      const out = await tools[name].execute(args as never, ses as never)
      expect(String(out)).toContain('Refused')
      expect(String(out)).toContain('dynamic-workflows')
    }
    expect(calls).toHaveLength(0) // nothing reached the host while gated
  })

  it('GetWorkflowSkill fetches the text and opens the gate for that session', async () => {
    stubFetch(() => jsonResponse({ file: 'SKILL.md', text: '# Writing dynamic workflows\n...' }))
    const tools = createWorkflowTools(OPTS)
    const ses = { sessionID: freshSession() }

    const out = await tools.GetWorkflowSkill.execute({}, ses as never)
    expect(String(out)).toContain('# Writing dynamic workflows')
    expect(isSkillLoaded(ses.sessionID)).toBe(true)

    // …and the gate is per session: another session is still locked.
    expect(isSkillLoaded('ses_other')).toBe(false)
  })

  it("the opencode `skill` tool opens the gate too (the upstream path)", async () => {
    const hook = skillGateHook()
    const ses = freshSession()
    await hook({ tool: 'skill', sessionID: ses, args: { name: 'dynamic-workflows' } } as never)
    expect(isSkillLoaded(ses)).toBe(true)

    const other = freshSession()
    await hook({ tool: 'skill', sessionID: other, args: { name: 'something-else' } } as never)
    expect(isSkillLoaded(other)).toBe(false)
    await hook({ tool: 'bash', sessionID: other } as never)
    expect(isSkillLoaded(other)).toBe(false)
  })

  it('the gate can also be opened directly (test seam used by the E2E)', () => {
    const ses = freshSession()
    markSkillLoaded(ses)
    expect(isSkillLoaded(ses)).toBe(true)
  })
})

describe('workflow tools — compile feedback', () => {
  it('EvalWorkflowSnippet reports a clean compile without creating a run', async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, askSites: 2, scriptHash: 'abc', declaredRunCommands: ['npm test'] }))
    const tools = createWorkflowTools(OPTS)
    const ses = { sessionID: freshSession() }
    markSkillLoaded(ses.sessionID)

    const out = String(await tools.EvalWorkflowSnippet.execute({ script: 'x' }, ses as never))
    expect(out).toContain('Compiles clean.')
    expect(out).toContain('ask sites: 2')
    expect(out).toContain('npm test')
    expect(calls[0].url).toBe('http://127.0.0.1:4199/api/workflow/compile')
    expect(calls).toHaveLength(1) // compile only — no run endpoint touched
  })

  it('EvalWorkflowSnippet renders located diagnostics', async () => {
    stubFetch(() => jsonResponse({ ok: false, diagnostics: [{ code: 2322, line: 3, column: 7, message: "Type 'number' is not assignable to type 'string'." }] }))
    const tools = createWorkflowTools(OPTS)
    const ses = { sessionID: freshSession() }
    markSkillLoaded(ses.sessionID)

    const out = String(await tools.EvalWorkflowSnippet.execute({ script: 'x' }, ses as never))
    expect(out).toContain('Compile failed (1 diagnostic(s))')
    expect(out).toContain('L3:C7')
    expect(out).toContain('TS2322')
  })

  it('formatDiagnostics is one located line per diagnostic', () => {
    expect(formatDiagnostics([])).toBe('')
    expect(formatDiagnostics([{ code: 1, line: 2, column: 3, message: 'm' }])).toBe('  L2:C3  TS1  m')
  })
})

describe('workflow tools — host calls', () => {
  it('CreateWorkflow returns the host-assigned run id and how to follow it', async () => {
    const calls = stubFetch(() => jsonResponse({ runId: 'dwfrun-abc' }))
    const tools = createWorkflowTools(OPTS)
    const ses = { sessionID: freshSession() }
    markSkillLoaded(ses.sessionID)

    const out = String(await tools.CreateWorkflow.execute({ script: 's', name: 'demo' }, ses as never))
    expect(out).toContain('Run started: dwfrun-abc')
    expect(out).toContain('GetWorkflowRun')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body).toMatchObject({ scriptText: 's', name: 'demo', sessionId: ses.sessionID })
  })

  it('CreateWorkflow surfaces a compile failure instead of a run', async () => {
    stubFetch(() => jsonResponse({ error: 'compile_failed', diagnostics: [{ code: 2591, line: 1, column: 11, message: "Cannot find name 'process'." }] }, 400))
    const tools = createWorkflowTools(OPTS)
    const ses = { sessionID: freshSession() }
    markSkillLoaded(ses.sessionID)

    const out = String(await tools.CreateWorkflow.execute({ script: 'p' }, ses as never))
    expect(out).toContain('no run was created')
    expect(out).toContain('TS2591')
  })

  it('submit_result posts the calling session and reports the engine\'s answer', async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, note: 'Submitted.' }))
    const tools = createWorkflowTools(OPTS)
    const out = String(await tools.submit_result.execute({ result: { ok: true } }, { sessionID: 'ses_actor' } as never))
    expect(out).toBe('Submitted.')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sessionId: 'ses_actor', payload: { ok: true } })
  })

  it('submit_result outside a run reads as a refusal, not a crash', async () => {
    stubFetch(() => jsonResponse({ ok: false, error: 'this session has no workflow ask in flight' }, 409))
    const tools = createWorkflowTools(OPTS)
    const out = String(await tools.submit_result.execute({ result: 1 }, { sessionID: 'ses_x' } as never))
    expect(out).toContain('submit_result refused')
  })

  it('escalate tells the actor to proceed when nobody has answered', async () => {
    stubFetch(() => jsonResponse({ answer: null, note: 'No answer is available yet — continue with your best judgment and say what you assumed.' }))
    const tools = createWorkflowTools(OPTS)
    const out = String(await tools.escalate.execute({ question: 'which env?' }, { sessionID: 'ses_a' } as never))
    expect(out).toContain('continue with your best judgment')
  })

  it('ResolveWorkflowQuestion reports an answer or a miss', async () => {
    stubFetch(() => jsonResponse({ ok: true, pending: [] }))
    const tools = createWorkflowTools(OPTS)
    expect(String(await tools.ResolveWorkflowQuestion.execute({ question: 'q', answer: 'a' }, {} as never))).toBe('Answered.')

    stubFetch(() => jsonResponse({ ok: false }, 404))
    expect(String(await tools.ResolveWorkflowQuestion.execute({ question: 'q', answer: 'a' }, {} as never))).toContain('No matching pending question')
  })

  it('GetWorkflowRun renders status, subagents, steps and events', async () => {
    stubFetch((url) => url.endsWith('/events')
      ? jsonResponse({ events: [{ sequence: 1, event: { type: 'run-started' } }, { sequence: 2, event: { type: 'node-settled' } }], live: true })
      : jsonResponse({
        record: { runId: 'dwfrun-1', status: 'completed', name: 'demo', spentTokens: 42, result: { ok: true } },
        actors: [{ name: 'reviewer', siteId: 'ask#1', ordinal: 1, sessionId: 'ses_1', resolvedModel: 'stub/model' }],
        nodes: [{ kind: 'ask', status: 'completed', siteId: 'ask#1', ordinal: 1 }],
      }))
    const tools = createWorkflowTools(OPTS)
    const out = String(await tools.GetWorkflowRun.execute({ runId: 'dwfrun-1' }, {} as never))
    expect(out).toContain('run dwfrun-1 — completed · running now')
    expect(out).toContain('tokens: 42')
    expect(out).toContain('reviewer')
    expect(out).toContain('@stub/model')
    expect(out).toContain('[completed] ask ask#1#1')
    expect(out).toContain('result: {"ok":true}')
    expect(out).toContain('recent events')
  })

  it('a dead host reads as a tool failure, never a throw', async () => {
    stubFetch(() => { throw new Error('connect ECONNREFUSED') })
    const tools = createWorkflowTools(OPTS)
    const out = String(await tools.ListWorkflowRuns.execute({}, {} as never))
    expect(out).toContain('ListWorkflowRuns failed: ocrc host unreachable')
  })
})
