#!/usr/bin/env node
/**
 * P3 gate — the tool face, driven by a real (scripted) model turn.
 *
 * Stack: ocrc host (:4199) + an engine (:4295) with the ocrc plugin installed
 * (ATTACHED) + a scripted stub model (:4300). Nothing here touches the user's
 * engine or a running ocrc; the Telegram credentials are blanked in every child env
 * (the P0 gate explains why that matters).
 *
 * What it proves, in the plan's a–g terms:
 *   a. the model reads the authoring skill and the create-class gate opens
 *   b. the model writes a 2-actor fan-out script and starts a run
 *   c. a deliberately wrong script comes back with LOCATED diagnostics, and the fix runs
 *   d. the run starts only through the tool (no run exists before CreateWorkflow)
 *   e. an actor's typed submit is accepted by the engine
 *   f. the model follows the run with GetWorkflowRun
 *   g. ResolveWorkflowQuestion answers an actor's escalation
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const ROOT = process.env.GATE_ROOT ?? '/tmp/ocrc-p3'
const P = { stub: 4300, host: 4199, engine: 4295 }

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BLANKED = { TELEGRAM_BOT_TOKEN: '', ALLOWED_USER_IDS: '' }
const childEnv = (extra = {}) => ({ ...process.env, ...BLANKED, ...extra })

function portPid(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf-8' })
    const m = out.split('\n').find((l) => l.includes(`:${port} `))?.match(/pid=(\d+)/)
    return m ? Number(m[1]) : undefined
  } catch { return undefined }
}
async function get(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  return { status: res.status, text: await res.text() }
}
const json = async (url, init) => JSON.parse((await get(url, init)).text || '{}')
async function waitFor(fn, { tries = 120, delay = 500, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(delay)
  }
  console.error(`  !! timed out waiting for ${label}`)
  return false
}
async function waitValue(fn, { tries = 120, delay = 500, label = 'value' } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v } catch { /* retry */ }
    await sleep(delay)
  }
  console.error(`  !! timed out waiting for ${label}`)
  return undefined
}

const procs = []
function start(name, cmd, args, opts = {}) {
  const logPath = join(ROOT, `${name}.log`)
  const out = openSync(logPath, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out] })
  procs.push({ name, child, logPath })
  return child
}
function cleanup() {
  for (const { name, child } of procs) {
    if (child.exitCode === null && !child.killed) { try { child.kill('SIGTERM') } catch { /* ignore */ }; console.log(`  (stopped ${name} pid ${child.pid})`) }
  }
  for (const port of [P.stub, P.host, P.engine]) {
    const pid = portPid(port)
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ } }
  }
}

const GOOD_SCRIPT = `
interface Verdict { ok: boolean; reason?: string }
phase("review");
const [a, b] = await Promise.all([
  agent("alpha").ask("Summarize alpha in one short line."),
  agent("beta").ask("Summarize beta in one short line."),
]);
report({ actors: 2, ok: true });
return { a, b };
`
const BAD_SCRIPT = `
const n: number = await agent("alpha").ask("give me a number");
const bad: string = n;
return bad;
`

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'home', '.config', 'opencode', 'plugin'), { recursive: true })
  mkdirSync(join(ROOT, 'home', '.ocrc'), { recursive: true })
  mkdirSync(join(ROOT, 'ws'), { recursive: true })

  writeFileSync(join(ROOT, 'home', '.config', 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      stub: {
        npm: '@ai-sdk/openai-compatible', name: 'Stub',
        options: { baseURL: `http://127.0.0.1:${P.stub}/v1`, apiKey: 'stub-key' },
        models: { 'stub-model': { name: 'Stub Model' } },
      },
    },
  }, null, 2))
  writeFileSync(
    join(ROOT, 'home', '.config', 'opencode', 'plugin', 'ocrc.js'),
    `export { default } from ${JSON.stringify(join(REPO, 'dist', 'plugin', 'entry.js'))}\n`,
  )

  // The scripted model: skill → bad script → good script → follow the run → answer.
  const plan = [
    { tool: 'GetWorkflowSkill', args: {} },
    { tool: 'EvalWorkflowSnippet', args: { script: BAD_SCRIPT } },
    { tool: 'CreateWorkflow', args: { script: BAD_SCRIPT, name: 'p3-bad' } },
    { tool: 'CreateWorkflow', args: { script: GOOD_SCRIPT, name: 'p3-good' } },
    { tool: 'ListWorkflowRuns', args: {} },
    { text: 'workflow started' },
  ]
  start('stub', process.execPath, [join(HERE, 'stub-llm.mjs')], { env: childEnv({ STUB_PORT: String(P.stub), STUB_PLAN: JSON.stringify(plan) }) })
  await waitFor(async () => (await get(`http://127.0.0.1:${P.stub}/v1/models`)).status === 200, { label: 'stub' })

  const engineEnv = childEnv({
    HOME: join(ROOT, 'home'), OCRC_HOME: join(ROOT, 'home', '.ocrc'),
    OCRC_MODE: 'plugin', OCRC_WEB_ENABLED: 'true', OCRC_WEB_PORT: '4198', OCRC_WEB_HOST: '127.0.0.1',
    OCRC_WF_PROBE: '1', LOG_LEVEL: 'info',
  })

  start('host', process.execPath, [join(REPO, 'dist', 'cli', 'index.js'), 'host'], {
    cwd: REPO,
    env: childEnv({
      HOME: join(ROOT, 'home'), OCRC_HOME: join(ROOT, 'home', '.ocrc'),
      OCRC_BACKENDS: 'opencode', OCRC_SERVER_URL: `http://127.0.0.1:${P.engine}`, OCRC_SERVER_PORT: String(P.engine),
      OCRC_WEB_PORT: String(P.host), OCRC_WEB_HOST: '127.0.0.1', OCRC_WEB_ENABLED: 'true',
      OCRC_WF_PROBE: '1', LOG_LEVEL: 'info',
    }),
  })
  const lockPath = join(ROOT, 'home', '.ocrc', 'primary.lock')
  await waitFor(() => existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf-8')).role === 'host', { label: 'host lock' })
  const token = await waitValue(() => {
    try { return readFileSync(join(ROOT, 'home', '.ocrc', 'token'), 'utf-8').trim() || undefined } catch { return undefined }
  }, { label: 'host token' })

  // The engine that loads the plugin (started AFTER the host, so it attaches).
  start('engine', 'opencode', ['serve', '--port', String(P.engine), '--hostname', '127.0.0.1'], { cwd: join(ROOT, 'ws'), env: engineEnv })
  await waitFor(() => portPid(P.engine), { label: 'engine' })

  const ids = await waitFor(async () => {
    const r = await get(`http://127.0.0.1:${P.engine}/experimental/tool/ids`)
    return r.text.includes('CreateWorkflow') && r.text.includes('submit_result') && r.text.includes('escalate')
  }, { label: 'workflow tools to appear' })
  const idList = (await get(`http://127.0.0.1:${P.engine}/experimental/tool/ids`)).text
  check('the engine exposes the whole workflow tool face', ids, idList.slice(0, 260))

  // ── the model turn ─────────────────────────────────────────────────────────
  console.log('\n== the model authors a workflow through the tools ==')
  const created = await json(`http://127.0.0.1:${P.engine}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'p3' }) })
  const sessionId = created.id
  check('a session exists for the author turn', !!sessionId, String(sessionId))

  const reply = await get(`http://127.0.0.1:${P.engine}/session/${sessionId}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'Author and start a two-subagent review workflow.' }],
      model: { providerID: 'stub', modelID: 'stub-model' },
    }),
  })
  // The reply to a prompt is the LAST message; the tool calls happened in the
  // intermediate steps, so the evidence is the whole message list.
  const history = await get(`http://127.0.0.1:${P.engine}/session/${sessionId}/message`)
  const transcript = `${reply.text}\n${history.text}`
  writeFileSync(join(ROOT, 'transcript.txt'), transcript)

  check('a) the model read the authoring skill (gate opened)',
    transcript.includes('Writing dynamic workflows'), 'skill text came back through the tool')
  check('c) a wrong script came back with LOCATED diagnostics',
    /TS2322/.test(transcript) && /L\d+:C\d+/.test(transcript), transcript.match(/TS\d+[^"]{0,80}/)?.[0] ?? 'no diagnostic in transcript')
  check('d) the bad script created no run', transcript.includes('no run was created'))

  const runIds = [...transcript.matchAll(/dwfrun-[0-9a-f-]{36}/g)].map((m) => m[0])
  const uniqueRuns = [...new Set(runIds)]
  check('b) the model started a run from the corrected script', uniqueRuns.length === 1, uniqueRuns.join(','))
  const runId = uniqueRuns[0]

  // The run is real: it is on the host's journal and finishes on its own.
  const runView = await waitValue(async () => {
    const v = await json(`http://127.0.0.1:${P.host}/api/workflow/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } })
    return v.record?.status === 'completed' ? v : false
  }, { label: 'the tool-started run to complete' })
  check('the tool-started run completes on the host', !!runView,
    runView ? `actors=${runView.actors.length} nodes=${runView.nodes.length}` : 'did not complete')
  check('the run has both fan-out subagents', runView?.actors?.length === 2, String(runView?.actors?.length))

  check('f) the model followed the run (ListWorkflowRuns reached the host)',
    transcript.includes('dwfrun-') && /dwfrun-[0-9a-f-]{36}\s+(completed|running)/.test(transcript),
    'run listing rendered in the transcript')

  // ── g) escalation answered ─────────────────────────────────────────────────
  console.log('\n== escalation ==')
  const asked = await json(`http://127.0.0.1:${P.host}/api/workflow/escalate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, question: 'Which environment should I target?' }),
  })
  check('an actor can escalate a question', asked.ok === true && asked.answer === null, JSON.stringify(asked).slice(0, 140))

  const answered = await json(`http://127.0.0.1:${P.host}/api/workflow/escalations/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, question: 'Which environment should I target?', answer: 'staging' }),
  })
  check('g) ResolveWorkflowQuestion answers it', answered.ok === true, JSON.stringify(answered).slice(0, 120))

  const reAsk = await json(`http://127.0.0.1:${P.host}/api/workflow/escalate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, question: 'Which environment should I target?' }),
  })
  check('the actor now gets the answer back', reAsk.answer === 'staging', JSON.stringify(reAsk).slice(0, 120))

  // ── e) typed submit accepted ───────────────────────────────────────────────
  console.log('\n== typed submit ==')
  const typedScript = 'interface V { ok: boolean }\nconst v = await agent("judge").ask<V>("SLOW: judge it.");\nreturn v;\n'
  const typedRun = await json(`http://127.0.0.1:${P.host}/api/workflow/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ scriptText: typedScript, cwd: join(ROOT, 'ws'), name: 'p3-typed' }),
  })
  const judgeSession = await waitValue(async () => {
    const v = await json(`http://127.0.0.1:${P.host}/api/workflow/runs/${typedRun.runId}`, { headers: { Authorization: `Bearer ${token}` } })
    return v.actors?.[0]?.sessionId || false
  }, { label: 'judge session' })
  const submitted = await json(`http://127.0.0.1:${P.host}/api/workflow/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: judgeSession, payload: { ok: true } }),
  })
  check('e) an actor-side submit_result is accepted by the engine', submitted.ok === true, JSON.stringify(submitted).slice(0, 140))
  const typedDone = await waitValue(async () => {
    const v = await json(`http://127.0.0.1:${P.host}/api/workflow/runs/${typedRun.runId}`, { headers: { Authorization: `Bearer ${token}` } })
    return v.record?.status === 'completed' ? v : false
  }, { label: 'typed run to complete' })
  check('the typed run completes with the submitted value',
    typedDone?.record?.result?.ok === true, String(JSON.stringify(typedDone?.record?.result)).slice(0, 120))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n== ${results.length - failed.length}/${results.length} checks passed ==`)
  console.log(`artifacts: ${ROOT} (transcript.txt + logs)`)
  return failed.length === 0
}

let ok = false
try { ok = await main() } catch (err) { console.error('gate crashed:', err) } finally { cleanup() }
process.exit(ok ? 0 : 1)
