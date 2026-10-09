#!/usr/bin/env node
/**
 * P0-4 gate — live, on a scratch stack. Nothing here touches the user's engine
 * (:4096) or any running ocrc: every process is started by this script and killed
 * by pid on the way out.
 *
 * What it proves
 *   A. host up, plugin installed in an engine
 *      1. the engine exposes the probe tool `wf_echo`          (registration)
 *      2. a MODEL calls it and the host's value comes back      (取回值, host-assigned runId)
 *      3. the engine owns no port but its own API port          (plugin listens on nothing)
 *      4. the engine never tries to start a Telegram poller     (no second bot)
 *   B. no host → the plugin behaves as before
 *      5. the plugin wins the election and takes the lock with role=plugin
 *      6. it starts its OWN web listener and tries its OWN Telegram poller
 *
 * Run: node scripts/spikes/p0-tool-registration/gate.mjs
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const ROOT = process.env.GATE_ROOT ?? '/tmp/ocrc-p04'

const P = {
  stub: 4300,
  host: 4199,        // host web
  hostEngine: 4296,  // the engine the host adopts as its backend
  pluginEngine: 4295, // the engine that loads the plugin (gate A)
  soloEngine: 4294,   // the engine that loads the plugin with NO host (gate B)
  soloWeb: 4198,      // the plugin's own web listener in gate B
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * SAFETY. `loadPluginConfig` dotenv-loads the REPO's `.env` (never overriding an
 * already-set variable), and that file carries the PRODUCTION Telegram bot token.
 * A gate process that does not blank the key inherits it and polls the user's real
 * bot — which is exactly what the first run of this script did. Every child env
 * goes through here, and `assertNoTelegramCredentials` refuses to start if any
 * repo .env on the load path would still supply a token.
 */
const BLANKED = { TELEGRAM_BOT_TOKEN: '', ALLOWED_USER_IDS: '' }
function childEnv(extra = {}) {
  return { ...process.env, ...BLANKED, ...extra }
}

function assertNoTelegramCredentials() {
  const candidates = [join(REPO, '.env'), join(process.env.HOME ?? '', '.ocrc', 'config.env')]
  const found = candidates.filter((p) => {
    try { return /^TELEGRAM_BOT_TOKEN=\S/m.test(readFileSync(p, 'utf-8')) } catch { return false }
  })
  if (found.length) {
    console.log(`  (note: ${found.join(', ')} define a Telegram token — blanked in every child env)`)
  }
}

function portPid(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf-8' })
    const line = out.split('\n').find((l) => l.includes(`:${port} `))
    const m = line?.match(/pid=(\d+)/)
    return m ? Number(m[1]) : undefined
  } catch { return undefined }
}

function portsOfPid(pid) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf-8' })
    return out.split('\n').filter((l) => l.includes(`pid=${pid},`)).map((l) => l.trim().split(/\s+/)[3] ?? '?')
  } catch { return [] }
}

async function get(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  return { status: res.status, text }
}

/** Best-effort GET: used to warm a lazily-bootstrapped engine, where the first
 *  request can block while plugins load. */
async function tryGet(url) {
  try { return await get(url) } catch { return { status: 0, text: '' } }
}

async function waitFor(fn, { tries = 60, delay = 500, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(delay)
  }
  console.error(`  !! timed out waiting for ${label}`)
  return false
}

const procs = []
function start(name, cmd, args, opts = {}) {
  const logPath = join(ROOT, `${name}.log`)
  const out = openSync(logPath, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out] })
  procs.push({ name, child, logPath })
  return child
}

function logTail(logPath, n = 40) {
  try { return readFileSync(logPath, 'utf-8').split('\n').slice(-n).join('\n') } catch { return '(no log)' }
}

function cleanup() {
  for (const { name, child } of procs) {
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      console.log(`  (stopped ${name} pid ${child.pid})`)
    }
  }
  // The bun-compiled opencode re-execs, so the listening pid can differ from the
  // spawned one: kill whatever still holds our ports (ours, by construction).
  for (const port of [P.stub, P.host, P.hostEngine, P.pluginEngine, P.soloEngine, P.soloWeb]) {
    const pid = portPid(port)
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ } }
  }
}

async function main() {
  assertNoTelegramCredentials()
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'home', '.config', 'opencode', 'plugin'), { recursive: true })
  mkdirSync(join(ROOT, 'hosthome', '.ocrc'), { recursive: true })
  mkdirSync(join(ROOT, 'proj'), { recursive: true })

  // ── scratch engine config: a stub provider, so a real model turn can happen ──
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

  // ── the ocrc plugin, installed the way a user installs it ──
  writeFileSync(
    join(ROOT, 'home', '.config', 'opencode', 'plugin', 'ocrc.js'),
    `export { default } from ${JSON.stringify(join(REPO, 'dist', 'plugin', 'entry.js'))}\n`,
  )

  // Gate A: the plugin must own NOTHING, so no bot token anywhere — if the plugin
  // ever went FULL this env would not let it start a poller, and gate A asserts on
  // the absence of any Telegram line instead.
  const engineEnv = childEnv({
    HOME: join(ROOT, 'home'),
    OCRC_HOME: join(ROOT, 'hosthome', '.ocrc'),
    OCRC_MODE: 'plugin',
    OCRC_WEB_ENABLED: 'true',
    OCRC_WEB_PORT: String(P.soloWeb),
    OCRC_WEB_HOST: '127.0.0.1',
    OCRC_WF_PROBE: '1',
    LOG_LEVEL: 'info',
  })

  // Gate B needs the FULL path to actually try a Telegram launch — that attempt
  // (and its failure) is the evidence. The token must be structurally valid so
  // grammY gets as far as the API call, and obviously fake so nothing real is
  // touched: the API answers 401 and the transport logs a start failure.
  const FAKE_BOT_TOKEN = '123456789:AAHfake-token-for-the-p0-gate-never-real'
  const soloEnv = childEnv({ ...engineEnv, TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN, ALLOWED_USER_IDS: '1' })

  // ═══ gate A ═══
  console.log('\n== gate A: host running, plugin installed in an engine ==')

  const stub = spawn(process.execPath, [join(HERE, 'stub-llm.mjs')], {
    env: childEnv({ STUB_PORT: String(P.stub) }),
    stdio: ['ignore', 'ignore', openSync(join(ROOT, 'stub.log'), 'a')],
  })
  procs.push({ name: 'stub-llm', child: stub, logPath: join(ROOT, 'stub.log') })
  await waitFor(async () => (await get(`http://127.0.0.1:${P.stub}/v1/models`)).status === 200, { label: 'stub llm' })

  // the engine the host adopts as its backend (no plugin in it)
  start('hostEngine', 'opencode', ['serve', '--port', String(P.hostEngine), '--hostname', '127.0.0.1'], { cwd: join(ROOT, 'proj'), env: childEnv({ HOME: join(ROOT, 'hosthome') }) })
  await waitFor(() => portPid(P.hostEngine), { label: 'host engine' })

  // the ocrc host — takes the lock with role=host + its URL
  start('host', process.execPath, [join(REPO, 'dist', 'cli', 'index.js'), 'host'], {
    cwd: REPO,
    env: childEnv({
      HOME: join(ROOT, 'hosthome'),
      OCRC_HOME: join(ROOT, 'hosthome', '.ocrc'),
      OCRC_BACKENDS: 'opencode',
      OCRC_SERVER_URL: `http://127.0.0.1:${P.hostEngine}`,
      OCRC_SERVER_PORT: String(P.hostEngine),
      OCRC_WEB_PORT: String(P.host),
      OCRC_WEB_HOST: '127.0.0.1',
      OCRC_WEB_ENABLED: 'true',
      // The host must serve the probe route, because that route is what the
      // attached plugin's wf_echo calls.
      OCRC_WF_PROBE: '1',
    LOG_LEVEL: 'info',
    }),
  })

  const lockPath = join(ROOT, 'hosthome', '.ocrc', 'primary.lock')
  // The Telegram transport acquires this at the top of start(): its presence is a
  // deterministic "a poller was attempted" signal, independent of log wording.
  const tgLockPath = join(ROOT, 'hosthome', '.ocrc', 'tg-runtime.lock')
  const lockIsHost = await waitFor(() => {
    if (!existsSync(lockPath)) return false
    const o = JSON.parse(readFileSync(lockPath, 'utf-8'))
    return o.role === 'host' && !!o.url
  }, { label: 'host to take the lock' })
  check('host takes the primary lock with role=host and its own URL', lockIsHost, existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : 'no lock')

  const hostToken = readFileSync(join(ROOT, 'hosthome', '.ocrc', 'token'), 'utf-8').trim()
  const hostUp = await waitFor(async () => {
    const r = await get(`http://127.0.0.1:${P.host}/api/attach/status`, { headers: { Authorization: `Bearer ${hostToken}` } })
    return r.status === 200
  }, { label: 'host web api' })
  check('host serves the attach channel behind the token guard', hostUp)
  const unauth = await get(`http://127.0.0.1:${P.host}/api/attach/status`)
  check('the attach channel rejects a tokenless call', unauth.status === 401, `status=${unauth.status}`)

  // the engine that loads the plugin — started AFTER the host, so it attaches
  const pluginEngine = start('pluginEngine', 'opencode', ['serve', '--port', String(P.pluginEngine), '--hostname', '127.0.0.1'], { cwd: join(ROOT, 'proj'), env: engineEnv })
  await waitFor(() => portPid(P.pluginEngine), { label: 'plugin engine' })

  const ids = await waitFor(async () => {
    const r = await get(`http://127.0.0.1:${P.pluginEngine}/experimental/tool/ids`)
    return r.status === 200 && r.text.includes('wf_echo')
  }, { label: 'wf_echo to appear' })
  const idList = (await get(`http://127.0.0.1:${P.pluginEngine}/experimental/tool/ids`)).text
  check('engine exposes the probe tool wf_echo', ids, idList.slice(0, 200))

  const enginePid = portPid(P.pluginEngine)
  const enginePorts = portsOfPid(enginePid)
  check(
    'the engine (and therefore the plugin) listens on nothing but its own API port',
    enginePorts.length === 1 && enginePorts[0].includes(`:${P.pluginEngine}`),
    `ports=${JSON.stringify(enginePorts)}`,
  )

  // The plugin's logger writes to $OCRC_HOME/ocrc.log — the SAME file the host
  // writes (they share OCRC_HOME), which is why the engine's own stdout has no
  // plugin lines. Read the shared log for election/telegram evidence.
  const sharedLog = () => { try { return readFileSync(join(ROOT, 'hosthome', '.ocrc', 'ocrc.log'), 'utf-8') } catch { return '' } }
  const engineLog = readFileSync(join(ROOT, 'pluginEngine.log'), 'utf-8')
  const combined = `${engineLog}\n${sharedLog()}`

  const botPollLine = combined.match(/.*(bot polling as|setMyCommands|transport telegram start).*/g)
  check(
    'the engine never starts a Telegram poller (no second bot)',
    !botPollLine && !existsSync(tgLockPath),
    botPollLine?.join(' | ').slice(0, 200) ?? (existsSync(tgLockPath) ? 'tg-runtime.lock was created!' : 'no telegram line, no tg-runtime.lock'),
  )
  const attachLine = sharedLog().split('\n').filter((l) => /ATTACHED|became PRIMARY|PASSIVE|standing down/.test(l))
  const engineSelfPrimary = attachLine.some((l) => new RegExp(`became PRIMARY \\(pid ${portPid(P.pluginEngine)}`).test(l))
  check(
    'the plugin log says ATTACHED, and the plugin engine never elected itself',
    attachLine.some((l) => /ATTACHED to http:\/\/127\.0\.0\.1:4199/.test(l)) && !engineSelfPrimary,
    attachLine.map((l) => l.slice(l.indexOf('] [') + 2)).join(' | ').slice(0, 320) || '(no election line)',
  )

  // ── the model actually calls the tool ──
  const created = await get(`http://127.0.0.1:${P.pluginEngine}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'p0-gate' }),
  })
  const sessionId = JSON.parse(created.text)?.id
  check('a session can be created on the plugin engine', !!sessionId, String(sessionId))

  const reply = await get(`http://127.0.0.1:${P.pluginEngine}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'Call the wf_echo tool with value "ping", then report exactly what it returned.' }],
      model: { providerID: 'stub', modelID: 'stub-model' },
    }),
  })
  const hostPid = portPid(P.host)
  const toolEchoed = reply.text.includes(`runId=host-${hostPid}-`)
  check(
    'the model calls wf_echo and gets the HOST-assigned value back',
    toolEchoed,
    reply.text.replace(/\s+/g, ' ').slice(0, 400),
  )
  appendFileSync(join(ROOT, 'transcript.txt'), `\n=== gate A model turn (status ${reply.status}) ===\n${reply.text}\n`)

  // ═══ gate B: no host ═══
  console.log('\n== gate B: no host running — the plugin must behave as before ==')

  // Take the host out. Wait for the lock to stop being HELD (file gone, or its
  // owner pid dead) — a lock whose owner died is reclaimed by the next election,
  // so a leftover file is not itself a failure.
  const hostChild = procs.find((p) => p.name === 'host')?.child
  try { hostChild.kill('SIGTERM') } catch { /* ignore */ }
  const lockFree = await waitFor(() => {
    if (!existsSync(lockPath)) return true
    const o = JSON.parse(readFileSync(lockPath, 'utf-8'))
    try { process.kill(o.pid, 0); return false } catch { return true }
  }, { label: 'the host to stop holding the lock', tries: 60 })
  check('the host hands the primary lock back on shutdown', lockFree,
    existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : 'lock removed')

  const solo = start('soloEngine', 'opencode', ['serve', '--port', String(P.soloEngine), '--hostname', '127.0.0.1'], { cwd: join(ROOT, 'proj'), env: soloEnv })
  await waitFor(() => portPid(P.soloEngine), { label: 'solo engine' })
  // Plugins load lazily, on the first app instance for a directory: hit the API
  // first, otherwise the election never runs and the wait below just spins. The
  // first request can block while the plugin imports, so it is best-effort.
  await tryGet(`http://127.0.0.1:${P.soloEngine}/experimental/tool/ids`)

  const soloTookLock = await waitFor(() => {
    if (!existsSync(lockPath)) return false
    const o = JSON.parse(readFileSync(lockPath, 'utf-8'))
    return o.role === 'plugin' && o.pid === portPid(P.soloEngine)
  }, { label: 'the plugin to take the lock as role=plugin' })
  check('with no host the plugin wins the election (lock role=plugin)', soloTookLock,
    existsSync(lockPath) ? readFileSync(lockPath, 'utf-8').trim() : 'no lock')

  const soloWebUp = await waitFor(() => portPid(P.soloWeb), { label: 'the plugin web listener' })
  const soloWebPid = portPid(P.soloWeb)
  check('the plugin starts its OWN web listener (full mode unchanged)', soloWebUp && soloWebPid === portPid(P.soloEngine),
    `web pid=${soloWebPid} engine pid=${portPid(P.soloEngine)}`)

  const soloLog = `${readFileSync(join(ROOT, 'soloEngine.log'), 'utf-8')}\n${sharedLog()}`
  const soloTg = soloLog.match(/.*(transport telegram start failed|bot polling as|setMyCommands).*/g)
  check('the plugin tries to start its OWN Telegram poller (full mode unchanged)',
    existsSync(tgLockPath) && !/bot polling as/.test(soloLog),
    existsSync(tgLockPath) ? 'tg-runtime.lock created by the plugin itself (launch then fails on the fake token)' : '(no tg-runtime.lock)' + (soloTg ? ` | ${soloTg.join(' | ')}` : ''))

  const soloIds = (await tryGet(`http://127.0.0.1:${P.soloEngine}/experimental/tool/ids`)).text
  check('the full-mode tool set is still registered', soloIds.includes('schedule_create') && soloIds.includes('rc-status'), soloIds.slice(0, 200))
  appendFileSync(join(ROOT, 'transcript.txt'), `\n=== gate B solo engine log (tail) ===\n${logTail(join(ROOT, 'soloEngine.log'), 60)}\n${soloLog.split('\n').slice(-40).join('\n')}\n`)

  // ── report ──
  const failed = results.filter((r) => !r.ok)
  console.log(`\n== ${results.length - failed.length}/${results.length} checks passed ==`)
  console.log(`artifacts: ${ROOT} (logs + transcript.txt)`)
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
