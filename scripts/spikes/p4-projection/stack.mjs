// The P4 gate's stack, in one place so a probe can borrow it verbatim.
//
// ocrc host (:4199) + an engine (:4295) that loads the ocrc plugin (ATTACHED, because the
// host already owns the primary lock) + a scripted stub model (:4300). Every child env
// blanks the Telegram credentials: the repo `.env` holds the production bot token and
// `loadPluginConfig` dotenv-loads it, which is how the P0 gate once polled the real bot.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..', '..')
export const ROOT = process.env.GATE_ROOT ?? '/tmp/ocrc-p4'
export const SHOTS = join(ROOT, 'shots')
export const P = { stub: 4300, host: 4199, engine: 4295, cdp: 9222 }
export const PANEL = `http://127.0.0.1:${P.host}`

/**
 * The script: ONE slow actor ask. "SLOW" makes the stub model hold the turn for 30s,
 * which is what keeps the run *running* while the browser asserts on it — a settled run
 * has no Stop button to click and no rail to draw.
 */
export const SLOW_SCRIPT = `
phase("collect");
const a = await agent("slowpoke").ask("SLOW work please — take your time and reply with one line.");
return { a };
`

export const BLANKED = { TELEGRAM_BOT_TOKEN: '', ALLOWED_USER_IDS: '' }
export const childEnv = (extra = {}) => ({ ...process.env, ...BLANKED, ...extra })
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function portPid(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf-8' })
    const m = out.split('\n').find((l) => l.includes(`:${port} `))?.match(/pid=(\d+)/)
    return m ? Number(m[1]) : undefined
  } catch { return undefined }
}
export async function get(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  return { status: res.status, text: await res.text() }
}
export const json = async (url, init) => JSON.parse((await get(url, init)).text || '{}')
export async function waitFor(fn, { tries = 120, delay = 500, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(delay)
  }
  console.error(`  !! timed out waiting for ${label}`)
  return false
}
export async function waitValue(fn, { tries = 120, delay = 500, label = 'value' } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v } catch { /* retry */ }
    await sleep(delay)
  }
  console.error(`  !! timed out waiting for ${label}`)
  return undefined
}

const procs = []
export function start(name, cmd, args, opts = {}) {
  const logPath = join(ROOT, `${name}.log`)
  const out = openSync(logPath, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out] })
  procs.push({ name, child, logPath })
  return child
}
export function cleanup() {
  for (const { name, child } of procs) {
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      console.log(`  (stopped ${name} pid ${child.pid})`)
    }
  }
  // A child that re-execs itself is not the process holding the port — resolve by port
  // and take both (the P0 gate learned this the hard way).
  for (const port of [P.stub, P.host, P.engine]) {
    const pid = portPid(port)
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ } }
  }
}

/**
 * Bring the stack up and start one live run through the model tool face.
 *
 * The turn is driven through the HOST's API, not the engine's: the panel reads sessions
 * through the host's backend, and a session created directly on the engine lands in
 * whatever project that engine's cwd is — a session the sidebar would never show.
 */
export async function startStack({ log = () => {}, script = SLOW_SCRIPT, name = 'p4-visible' } = {}) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'home', '.config', 'opencode', 'plugin'), { recursive: true })
  mkdirSync(join(ROOT, 'home', '.ocrc'), { recursive: true })
  mkdirSync(join(ROOT, 'ws'), { recursive: true })
  mkdirSync(SHOTS, { recursive: true })

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

  const plan = [
    { tool: 'GetWorkflowSkill', args: {} },
    { tool: 'CreateWorkflow', args: { script, name, workspace: REPO } },
    { text: 'the workflow is running in the background' },
  ]
  start('stub', process.execPath, [join(HERE, 'stub-llm.mjs')], {
    // The hold must outlive a page load, a click and the assertions that follow it.
    env: childEnv({ STUB_PORT: String(P.stub), STUB_PLAN: JSON.stringify(plan), STUB_SLOW_MS: '90000' }),
  })
  log('the stub model is up', await waitFor(async () => (await get(`http://127.0.0.1:${P.stub}/v1/models`)).status === 200, { label: 'stub' }))

  start('host', process.execPath, [join(REPO, 'dist', 'cli', 'index.js'), 'host'], {
    cwd: REPO,
    env: childEnv({
      HOME: join(ROOT, 'home'), OCRC_HOME: join(ROOT, 'home', '.ocrc'),
      OCRC_BACKENDS: 'opencode', OCRC_SERVER_URL: `http://127.0.0.1:${P.engine}`, OCRC_SERVER_PORT: String(P.engine),
      OCRC_WEB_PORT: String(P.host), OCRC_WEB_HOST: '127.0.0.1', OCRC_WEB_ENABLED: 'true',
      LOG_LEVEL: 'info',
    }),
  })
  const lockPath = join(ROOT, 'home', '.ocrc', 'primary.lock')
  await waitFor(() => existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf-8')).role === 'host', { label: 'host lock' })
  const token = await waitValue(() => {
    try { return readFileSync(join(ROOT, 'home', '.ocrc', 'token'), 'utf-8').trim() || undefined } catch { return undefined }
  }, { label: 'host token' })
  const panelUp = Boolean(token) && await waitFor(async () => (await get(`${PANEL}/z/`)).status === 200, { label: 'panel' })
  log('the host is up with a token and the panel bundle mounted', panelUp)

  start('engine', 'opencode', ['serve', '--port', String(P.engine), '--hostname', '127.0.0.1'], {
    cwd: join(ROOT, 'ws'),
    env: childEnv({
      HOME: join(ROOT, 'home'), OCRC_HOME: join(ROOT, 'home', '.ocrc'),
      OCRC_MODE: 'plugin', OCRC_WEB_ENABLED: 'false', LOG_LEVEL: 'info',
    }),
  })
  await waitFor(() => portPid(P.engine), { label: 'engine' })
  log('the engine exposes the workflow tool face', await waitFor(async () => {
    const r = await get(`http://127.0.0.1:${P.engine}/experimental/tool/ids`)
    return r.text.includes('CreateWorkflow')
  }, { label: 'tools' }))

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  // The stub model must be the one the turn runs on: the engine would otherwise pick
  // the user's configured default, which has no key in this scratch HOME.
  await json(`${PANEL}/api/overrides`, { method: 'POST', headers: auth, body: JSON.stringify({ model: { providerID: 'stub', modelID: 'stub-model' } }) })

  // One session must exist BEFORE the shell is opened: ZCodeApp picks the initial
  // workspace from the most recent session's directory and renders nothing at all when
  // there is none ("Root 没有它就不渲染壳"). This bootstrap session only provides that
  // directory — the gate's own session is the one the panel creates below.
  //
  // The directory is REPO on purpose: the panel's own `createSession` command falls back
  // to REPO when the envelope carries no workspacePath, and the sidebar's task list is
  // `listTasks({workspacePath})` filtered by session directory. A bootstrap session in a
  // different directory would leave the panel's session outside the selected workspace —
  // i.e. no sidebar row, which is half of what this gate is here to check.
  const bootstrap = await json(`${PANEL}/api/session`, {
    method: 'POST', headers: auth, body: JSON.stringify({ directory: REPO, title: 'p4-bootstrap' }),
  })
  log('the host created the bootstrap session (the shell needs a workspace)', Boolean(bootstrap.id), String(bootstrap.id))

  return { token, auth, bootstrapSessionId: bootstrap.id }
}

/**
 * Drive one model turn into `sessionId` and wait for the live run it starts.
 *
 * The turn goes through the HOST's API rather than the engine's: the host's backend is
 * the engine the panel reads, and a session created directly on the engine would land in
 * whatever project that engine's cwd is — a session the sidebar would never show.
 */
export async function startRunThrough(sessionId, { auth, log = () => {}, waitForStatus = 'running' } = {}) {
  await json(`${PANEL}/api/message`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ sessionId, text: 'Start a workflow.' }),
  })
  const runId = await waitValue(async () => {
    const body = await json(`${PANEL}/api/workflow/projection?sessionId=${sessionId}`, { headers: auth })
    const runs = body.runs ?? []
    // A model-free script settles in a second, so a gate that only waits for `running`
    // would miss it entirely — the caller says which it needs.
    return (waitForStatus === 'any' ? runs[0] : runs.find((r) => r.status === 'running'))?.runId
  }, { label: `a ${waitForStatus} workflow run`, tries: 60 })
  log('the tool call started a run', Boolean(runId), String(runId))
  return runId
}
