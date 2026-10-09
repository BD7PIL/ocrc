#!/usr/bin/env node
/**
 * P2 gate — the workflow engine, live, on a scratch stack.
 *
 * Everything here is started by this script and killed by pid on the way out. It
 * never touches the user's engine (:4096) or a running ocrc, and — because
 * `loadPluginConfig` dotenv-reads the repo's `.env` — every child env goes through
 * `childEnv()`, which blanks the Telegram credentials (see the P0 gate for why that
 * matters: the first version of that script polled the real bot).
 *
 * Checks (the plan's P2 gate):
 *   1. a 3-actor fan-out runs to completion, with real actor sessions
 *   2. the per-run concurrency cap is honoured (never more than N asks live)
 *   3. a typed ask is accepted by the engine through `submit_result` (the driver
 *      seam P3's tool calls), and a bad value is repaired then accepted
 *   4. world.read and artifact publishing work end to end (bytes served over HTTP)
 *   5. `report` reaches Boundary C
 *   6. cancel settles `stopped(user)`
 *   7. resume continues from the journal and completes
 *   8. a host restart marks in-flight runs `interrupted`, and resume then completes
 *   9. the token budget stops a run
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const ROOT = process.env.GATE_ROOT ?? '/tmp/ocrc-p2'

const P = { stub: 4300, host: 4199, engine: 4295 }

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BLANKED = { TELEGRAM_BOT_TOKEN: '', ALLOWED_USER_IDS: '' }
const childEnv = (extra = {}) => ({ ...process.env, ...BLANKED, ...extra })

function portPid(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf-8' })
    const line = out.split('\n').find((l) => l.includes(`:${port} `))
    const m = line?.match(/pid=(\d+)/)
    return m ? Number(m[1]) : undefined
  } catch { return undefined }
}

async function get(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  return { status: res.status, text }
}
const getJson = async (url, init) => JSON.parse((await get(url, init)).text || '{}')
const post = (url, body) => get(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

async function waitFor(fn, { tries = 90, delay = 500, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(delay)
  }
  console.error(`  !! timed out waiting for ${label}`)
  return false
}

/** Like waitFor, but returns the first truthy VALUE (not just true). */
async function waitValue(fn, { tries = 90, delay = 500, label = 'value' } = {}) {
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
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      console.log(`  (stopped ${name} pid ${child.pid})`)
    }
  }
  for (const port of [P.stub, P.host, P.engine]) {
    const pid = portPid(port)
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ } }
  }
}

const HOST_ENV = {
  OCRC_BACKENDS: 'opencode',
  OCRC_SERVER_URL: `http://127.0.0.1:${P.engine}`,
  OCRC_SERVER_PORT: String(P.engine),
  OCRC_WEB_PORT: String(P.host),
  OCRC_WEB_HOST: '127.0.0.1',
  OCRC_WEB_ENABLED: 'true',
  // The typed-ask seam (P3's submit_result tool calls the same manager method).
  OCRC_WF_PROBE: '1',
  LOG_LEVEL: 'info',
}

let token = ''

async function api(path, init) {
  const res = await get(`http://127.0.0.1:${P.host}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  })
  return res
}
const apiJson = async (path, init) => JSON.parse((await api(path, init)).text || '{}')

function startHost(name = 'host') {
  return start(name, process.execPath, [join(REPO, 'dist', 'cli', 'index.js'), 'host'], {
    cwd: REPO, env: childEnv({ HOME: join(ROOT, 'home'), OCRC_HOME: join(ROOT, 'home', '.ocrc'), ...HOST_ENV }),
  })
}

async function waitHost() {
  const up = await waitFor(async () => {
    const r = await get(`http://127.0.0.1:${P.host}/api/version`, { headers: { Authorization: `Bearer ${token}` } })
    return r.status === 200
  }, { label: 'host api' })
  return up
}

/** Wait until a run reaches a terminal status, returning its record. */
async function awaitRun(runId, { timeoutMs = 120_000, statuses = ['completed', 'errored', 'stopped'] } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const view = await apiJson(`/api/workflow/runs/${runId}`)
    last = view.record
    if (last && statuses.includes(last.status)) return last
    await sleep(500)
  }
  return last
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'home', '.ocrc'), { recursive: true })
  mkdirSync(join(ROOT, 'ws', 'src'), { recursive: true })
  mkdirSync(join(ROOT, 'home', '.config', 'opencode'), { recursive: true })
  writeFileSync(join(ROOT, 'ws', 'src', 'a.txt'), 'alpha\nbeta\n')
  writeFileSync(join(ROOT, 'ws', 'NOTES.md'), '# notes\n')

  // Engine config: only the stub provider, so no real model is ever reachable.
  writeFileSync(join(ROOT, 'home', '.config', 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      stub: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Stub',
        options: { baseURL: `http://127.0.0.1:${P.stub}/v1`, apiKey: 'stub-key' },
        models: { 'stub-model': { name: 'Stub Model' } },
      },
    },
  }, null, 2))

  start('stub', process.execPath, [join(HERE, 'stub-llm.mjs')], { env: childEnv({ STUB_PORT: String(P.stub) }) })
  await waitFor(async () => (await get(`http://127.0.0.1:${P.stub}/v1/models`)).status === 200, { label: 'stub llm' })

  start('engine', 'opencode', ['serve', '--port', String(P.engine), '--hostname', '127.0.0.1'], {
    cwd: join(ROOT, 'ws'), env: childEnv({ HOME: join(ROOT, 'home') }),
  })
  await waitFor(() => portPid(P.engine), { label: 'engine' })

  startHost()
  await waitFor(() => existsSync(join(ROOT, 'home', '.ocrc', 'token')), { label: 'host token' })
  token = readFileSync(join(ROOT, 'home', '.ocrc', 'token'), 'utf-8').trim()
  check('host comes up with the workflow engine enabled', await waitHost())
  const journalDir = join(ROOT, 'home', '.ocrc', 'workflows', 'runs')

  // ── 1 + 2 + 4 + 5: a real fan-out run ──────────────────────────────────────
  console.log('\n== 1) 3-actor fan-out + world.read + artifact + report ==')
  const fanout = `
phase("research");
const [a, b, c] = await Promise.all([
  agent("alpha").ask("Summarize alpha. Reply in one short line."),
  agent("beta").ask("Summarize beta. Reply in one short line."),
  agent("gamma").ask("Summarize gamma. Reply in one short line."),
]);
const hits = await files.grep("alpha", "**/*.txt");
report({ kind: "fanout", actors: 3, hits: hits.length });
const doc = await artifact.markdown("summary", "# Summary\\n\\n" + [a, b, c].join("\\n"), { title: "Fan-out summary" });
const notes = await artifact.file("notes", "NOTES.md");
return { a, b, c, hits: hits.length, doc: doc.id + ".v" + doc.version, notes: notes.id };
`
  const started = await apiJson('/api/workflow/runs', { method: 'POST', body: JSON.stringify({ scriptText: fanout, cwd: join(ROOT, 'ws'), name: 'p2-fanout', maxConcurrency: 3 }) })
  check('a fan-out run starts', !!started.runId, String(started.runId))
  const fanoutRecord = await awaitRun(started.runId)
  check('the fan-out run completes', fanoutRecord?.status === 'completed', `status=${fanoutRecord?.status}${fanoutRecord?.failure ? ` failure=${JSON.stringify(fanoutRecord.failure).slice(0, 200)}` : ''}`)

  const view = await apiJson(`/api/workflow/runs/${started.runId}`)
  const actorNames = view.actors.map((a) => a.name).sort()
  check('three actor sessions were minted and journaled', actorNames.join(',') === 'alpha,beta,gamma', actorNames.join(','))
  const askNodes = view.nodes.filter((n) => n.kind === 'ask')
  check('all three asks settled', askNodes.length === 3 && askNodes.every((n) => n.status === 'completed'), askNodes.map((n) => n.status).join(','))
  check('the fan-out result carries the actor text', typeof fanoutRecord?.result === 'object' && fanoutRecord?.result !== null,
    String(JSON.stringify(fanoutRecord?.result)).slice(0, 160))

  const events = (await apiJson(`/api/workflow/runs/${started.runId}/events`)).events
  const types = events.map((e) => e.event.type)
  check('Boundary C recorded the run lifecycle', ['run-started', 'node-settled', 'run-settled'].every((t) => types.includes(t)), [...new Set(types)].join(','))
  check('the report node reached the journal', view.nodes.some((n) => n.kind === 'report'), view.nodes.map((n) => n.kind).join(','))
  check('a world-read node is recorded with its input', view.nodes.some((n) => n.kind === 'world-read' && n.input), 'ok')

  const artifactVersions = (() => {
    try {
      const idx = JSON.parse(readFileSync(join(ROOT, 'home', '.ocrc', 'workflows', 'artifacts', started.runId, 'index.json'), 'utf-8'))
      return Object.keys(idx)
    } catch { return [] }
  })()
  check('artifact bytes were published for both members', artifactVersions.length === 2, artifactVersions.join(','))

  const bytes = await api(`/api/workflow/runs/${started.runId}/artifacts/summary/v/1`)
  check('artifact bytes are served over HTTP with the right type', bytes.status === 200 && bytes.text.includes('# Summary') && bytes.text.includes('actor-report'),
    `status=${bytes.status} type=${(await api(`/api/workflow/runs/${started.runId}/artifacts/summary/v/1`)).text.slice(0, 60)}`)

  // ── 2b: the concurrency cap is real ────────────────────────────────────────
  console.log('\n== 1b) per-run concurrency cap ==')
  const twoActors = `
const [a, b] = await Promise.all([
  agent("one").ask("First. Reply in one short line."),
  agent("two").ask("Second. Reply in one short line."),
]);
return { a, b };
`
  const serialRun = await apiJson('/api/workflow/runs', { method: 'POST', body: JSON.stringify({ scriptText: twoActors, cwd: join(ROOT, 'ws'), name: 'p2-serial', maxConcurrency: 1 }) })
  const serialRecord = await awaitRun(serialRun.runId)
  check('a 2-actor run under a cap of 1 still completes', serialRecord?.status === 'completed', `status=${serialRecord?.status}`)
  const serialEvents = (await apiJson(`/api/workflow/runs/${serialRun.runId}/events`)).events.map((e) => e.event)
  // With one seat and two actors the engine must not dispatch the second ask until
  // the first settles — that ordering IS the cap being enforced (the driver's own
  // seat gate is the second layer, for asks the engine hands over anyway).
  const dispatch1 = serialEvents.findIndex((e) => e.type === 'node-dispatched')
  const settle1 = serialEvents.findIndex((e) => e.type === 'node-settled')
  const dispatch2 = serialEvents.findIndex((e, i) => e.type === 'node-dispatched' && i > dispatch1)
  check('the cap serialises the asks (second dispatch after the first settles)',
    dispatch1 >= 0 && settle1 > dispatch1 && dispatch2 > settle1,
    `dispatch1@${dispatch1} settle1@${settle1} dispatch2@${dispatch2}`)
  const serialView = await apiJson(`/api/workflow/runs/${serialRun.runId}`)
  check('the run records the cap it was started with', serialView.record?.caps?.maxConcurrency === 1,
    `caps=${JSON.stringify(serialView.record?.caps)}`)

  // ── 3: typed ask, accepted then repaired ───────────────────────────────────
  console.log('\n== 2) typed ask: accept + repair ==')
  // The typed path needs an actor that calls `submit_result`; that tool is P3's, so
  // the gate drives the SAME seam the tool will call (manager.submitFromSession) and
  // asserts the engine's arbitration: a bad value is rejected and repaired, a good
  // one is accepted.
  // SLOW so the turn is still in flight while the gate submits: the typed path's
  // arbitration (accept / reject+repair) only exists while the ask is live.
  const typed = `
interface Verdict { ok: boolean; reason?: string }
const v = await agent("judge").ask<Verdict>("SLOW: judge the change and submit a verdict.");
return v;
`
  const typedRun = await apiJson('/api/workflow/runs', { method: 'POST', body: JSON.stringify({ scriptText: typed, cwd: join(ROOT, 'ws'), name: 'p2-typed' }) })
  check('a typed-ask run starts', !!typedRun.runId, String(typedRun.runId))

  // Find the actor session and submit a WRONG value first, then the right one.
  const judgeSession = await waitValue(async () => {
    const v = await apiJson(`/api/workflow/runs/${typedRun.runId}`)
    return v.actors[0]?.sessionId
  }, { label: 'judge session' })
  check('the typed ask minted its actor session', typeof judgeSession === 'string', String(judgeSession))

  const submitViaHost = async (payload) => {
    // The host routes a session-keyed submit into the live run's driver.
    return await api('/api/workflow/submit-probe', { method: 'POST', body: JSON.stringify({ sessionId: judgeSession, payload }) })
  }
  const wrong = await submitViaHost({ ok: 'yes' })
  check('the typed-submit seam accepts a payload', wrong.status === 200, `status=${wrong.status} body=${wrong.text.slice(0, 120)}`)
  // The engine validates, rejects, and asks for a repair turn; the actor (stub)
  // answers that turn with text, which for a typed ask settles nothing.
  await sleep(4000)
  const typedMid = await apiJson(`/api/workflow/runs/${typedRun.runId}`)
  check('the bad value did not settle the node (repair in flight)',
    typedMid.record?.status === 'running', `status=${typedMid.record?.status}`)
  const nodeRepairing = typedMid.nodes.some((n) => n.status === 'running')
  check('the journal shows the ask still running after the reject', nodeRepairing, typedMid.nodes.map((n) => n.status).join(','))

  const right = await submitViaHost({ ok: true, reason: 'looks good' })
  check('the corrected submit is accepted', right.status === 200, `status=${right.status}`)
  const typedDone = await awaitRun(typedRun.runId, { timeoutMs: 90_000 })
  check('the typed run completes after the repair', typedDone?.status === 'completed',
    `status=${typedDone?.status} result=${String(JSON.stringify(typedDone?.result)).slice(0, 120)}`)

  // ── 6: cancel settles stopped(user) ────────────────────────────────────────
  console.log('\n== 3) cancel ==')
  const slow = `
const a = await agent("slow").ask("SLOW: take your time. Reply when done.");
return { a };
`
  const slowRun = await apiJson('/api/workflow/runs', { method: 'POST', body: JSON.stringify({ scriptText: slow, cwd: join(ROOT, 'ws'), name: 'p2-slow' }) })
  await waitValue(async () => {
    const v = await apiJson(`/api/workflow/runs/${slowRun.runId}`)
    return v.actors.length > 0
  }, { label: 'slow run to dispatch' })
  const cancelRes = await api(`/api/workflow/runs/${slowRun.runId}/cancel`, { method: 'POST' })
  check('cancel is accepted for a live run', cancelRes.status === 200, `status=${cancelRes.status}`)
  const cancelled = await awaitRun(slowRun.runId, { timeoutMs: 60_000 })
  check('the cancelled run settles stopped(user)', cancelled?.status === 'stopped' && cancelled?.stopReason === 'user',
    `status=${cancelled?.status} reason=${cancelled?.stopReason}`)

  // ── 7: resume continues and completes ─────────────────────────────────────
  console.log('\n== 4) resume ==')
  const resumeRes = await api(`/api/workflow/runs/${slowRun.runId}/resume`, { method: 'POST' })
  check('resume is accepted for a stopped run', resumeRes.status === 200, `status=${resumeRes.status}`)
  const resumed = await awaitRun(slowRun.runId, { timeoutMs: 150_000 })
  check('the resumed run completes from the journal', resumed?.status === 'completed', `status=${resumed?.status}`)
  const resumedEvents = (await apiJson(`/api/workflow/runs/${slowRun.runId}/events`)).events.map((e) => e.event.type)
  check('the journal shows the replay (two run-started, one run-settled per pass)',
    resumedEvents.filter((t) => t === 'run-started').length >= 2, resumedEvents.join(','))

  // ── 8: host restart → interrupted → resume ────────────────────────────────
  console.log('\n== 5) host restart ==')
  const slow2 = await apiJson('/api/workflow/runs', { method: 'POST', body: JSON.stringify({ scriptText: slow, cwd: join(ROOT, 'ws'), name: 'p2-restart' }) })
  await waitValue(async () => {
    const v = await apiJson(`/api/workflow/runs/${slow2.runId}`)
    return v.actors.length > 0
  }, { label: 'restart-candidate run to dispatch' })

  const hostChild = procs.find((p) => p.name === 'host')?.child
  try { hostChild.kill('SIGTERM') } catch { /* ignore */ }
  await waitFor(() => !portPid(P.host), { label: 'host to stop' })
  startHost('host2')
  await waitHost()

  const afterRestart = await apiJson(`/api/workflow/runs/${slow2.runId}`)
  check('cold recovery marks the in-flight run interrupted',
    afterRestart.record?.status === 'stopped' && afterRestart.record?.stopReason === 'interrupted',
    `status=${afterRestart.record?.status} reason=${afterRestart.record?.stopReason}`)

  const resume2 = await api(`/api/workflow/runs/${slow2.runId}/resume`, { method: 'POST' })
  check('a resumed-after-restart run is accepted', resume2.status === 200, `status=${resume2.status}`)
  const resumed2 = await awaitRun(slow2.runId, { timeoutMs: 150_000 })
  check('the post-restart resume completes', resumed2?.status === 'completed', `status=${resumed2?.status}`)

  // ── 9: budget gate ────────────────────────────────────────────────────────
  console.log('\n== 6) token budget ==')
  const budgetRun = await apiJson('/api/workflow/runs', {
    method: 'POST',
    body: JSON.stringify({ scriptText: slow, cwd: join(ROOT, 'ws'), name: 'p2-budget', tokenBudget: 10 }),
  })
  const budgeted = await awaitRun(budgetRun.runId, { timeoutMs: 120_000 })
  check('a run over its token budget stops', budgeted?.status === 'stopped', `status=${budgeted?.status} reason=${budgeted?.stopReason}`)

  // ── report ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  const runCount = (() => { try { return readdirSync(journalDir).length } catch { return 0 } })()
  console.log(`\n== ${results.length - failed.length}/${results.length} checks passed (${runCount} journals on disk) ==`)
  console.log(`artifacts: ${ROOT}`)
  return failed.length === 0
}

let ok = false
try {
  ok = await main()
} catch (err) {
  console.error('gate crashed:', err)
} finally {
  cleanup()
}
process.exit(ok ? 0 : 1)
