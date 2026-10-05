// service.ts — `ocrc start|stop|restart|status|restore`: production instance
// lifecycle, matching octg's ergonomics: ONE command, supervision built in.
//
//   ocrc start <dir>    spawn a detached supervisor (adopt-or-spawn, crash
//                       auto-restart, .stop-file graceful stop) and exit —
//                       exactly what octg's start did by generating run-N.sh
//   ocrc stop           TERM the supervisor (its cleanup chain takes the
//                       instance down), port-level fallback, SIGKILL last
//   ocrc restart [dir]  stop + start
//   ocrc status         server / supervisor / web panel / workdir
//   ocrc restore        idempotent revive — reads last.json; the @reboot cron
//                       line (`ocrc restore`) is the only boot-restore path
//
// The plugin cannot supervise its own host; the supervisor is this CLI
// process running --supervisor (hidden arg) in a detached self-spawn.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const OCRC_HOME = process.env.OCRC_HOME ?? join(homedir(), '.ocrc')
const RUN_DIR = join(OCRC_HOME, 'run')
const CONFIG_FILE = join(OCRC_HOME, 'config.env')
const PROD_LOG = join(OCRC_HOME, 'prod.log')

interface ServiceConfig {
  port: string
  host: string
  mode: string
  bin: string
  watchDelayMs: number
  env: Record<string, string>
}

/** Minimal KEY=VALUE reader for ~/.ocrc/config.env (same format install writes). */
export function readConfigEnv(file = CONFIG_FILE): Record<string, string> {
  const map: Record<string, string> = {}
  if (!existsSync(file)) return map
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  return map
}

function loadConfig(): ServiceConfig {
  const raw = readConfigEnv()
  let bin = raw.OCRC_SERVER_BIN ?? ''
  if (!bin) {
    // Prefer the pinned install location, then PATH.
    const pinned = join(homedir(), '.local', 'bin', 'opencode')
    bin = existsSync(pinned) ? pinned : 'opencode'
  }
  const delay = Number(raw.OCRC_WATCH_DELAY ?? 5)
  return {
    port: raw.OCRC_SERVER_PORT ?? '4096',
    host: raw.OCRC_SERVER_HOST ?? '0.0.0.0',
    mode: raw.OCRC_SERVER_MODE ?? 'web',
    bin,
    watchDelayMs: Number.isFinite(delay) && delay >= 0 ? delay * 1000 : 5000,
    env: raw,
  }
}

/**
 * Watch-loop restart decision. Intentional stop = the stop file, or the child
 * dying to SIGTERM/SIGINT (the operator's / our own graceful stop). Everything
 * else is a crash and restarts — including SIGKILL (operator forcing the child
 * or the OOM killer) and segfaults; octg's old `>= 128` rule treated an
 * OOM-kill as "intentional" and left the bot dead, which is exactly the
 * failure mode supervision exists to cover. Operators stop the WATCHER
 * (ocrc stop terms it first), not the child.
 */
export function shouldRestart(exitCode: number | null, signal: string | null, stopFileExists: boolean): boolean {
  if (stopFileExists) return false
  if (signal === 'SIGTERM' || signal === 'SIGINT') return false
  void exitCode
  return true
}

/**
 * Cross-platform port-ownership probe. The old implementation parsed `ss`
 * (Linux-only; Windows/other controlled hosts don't ship it). A bind probe
 * is the portable truth: if we can't LISTEN on 127.0.0.1:port, someone owns
 * it. The owning pid is a Linux bonus read from `ss` (adopt needs it; null
 * is fine on other platforms — the supervisor then restarts instead of
 * adopting).
 */
export async function portOwner(port: string): Promise<{ pid: number | null } | null> {
  const net = await import('node:net')
  // CONNECT probe, not bind probe: a bind can steal 127.0.0.1:port for its
  // brief lifetime and EADDRINUSE-crash the very server we're waiting for.
  // Connecting succeeds ⇒ owned; refused/reset ⇒ free.
  const owned = await new Promise<boolean>((resolve) => {
    const sock = net.connect(Number(port), '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
  if (!owned) return null
  return { pid: pidFromSsBestEffort(port) }
}

/** Linux-only bonus: the owning pid via ss (never fatal). */
function pidFromSsBestEffort(port: string): number | null {
  if (process.platform !== 'linux') return null
  try {
    const res = spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf-8' })
    const m = (res.stdout ?? '').match(/pid=(\d+)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function pidFilePath(port: string): string {
  return join(RUN_DIR, `${port}.pid`)
}

function readPid(port: string): number | null {
  try {
    const raw = readFileSync(pidFilePath(port), 'utf-8').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitPort(port: string, up: boolean, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if ((await portOwner(port) !== null) === up) return true
    await sleep(500)
  }
  return (await portOwner(port) !== null) === up
}

function httpGetStatus(url: string, timeoutSec = 4): number | null {
  const res = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(timeoutSec), url], { encoding: 'utf-8' })
  const code = Number((res.stdout ?? '').trim())
  return Number.isFinite(code) ? code : null
}

function lastWorkDir(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(RUN_DIR, 'last.json'), 'utf-8')) as { workDir?: string }
    return j.workDir ?? null
  } catch { return null }
}

// ── supervisor (the run-N.sh equivalent): an internal, detached self-spawn ──

async function supervisorLoop(cfg: ServiceConfig, workDir: string): Promise<void> {
  const stopFile = join(RUN_DIR, `.stop-${cfg.port}`)
  const pidFile = pidFilePath(cfg.port)
  let childPid: number | null = null
  let stopping = false

  const killChild = (): void => {
    if (childPid !== null) { try { process.kill(childPid, 'SIGTERM') } catch { /* gone */ } }
  }
  const cleanupAndExit = (): void => {
    killChild()
    try { unlinkSync(stopFile) } catch { /* absent */ }
    try { unlinkSync(pidFile) } catch { /* absent */ }
    console.log(`[supervisor:${cfg.port}] stopped`)
    process.exit(0)
  }
  process.on('SIGTERM', () => { stopping = true; killChild() })
  process.on('SIGINT', () => { stopping = true; killChild() })

  mkdirSync(RUN_DIR, { recursive: true })
  writeFileSync(pidFile, String(process.pid))
  console.log(`[supervisor:${cfg.port}] supervising (pid ${process.pid}, workdir ${workDir}; stop: ocrc stop)`)

  while (!stopping) {
    if (existsSync(stopFile)) { console.log(`[supervisor:${cfg.port}] stop file detected`); cleanupAndExit() }

    // Adopt an already-listening instance (octg takeover semantics)…
    const existing = await portOwner(cfg.port)
    if (existing !== null) {
      const adoptPid = existing.pid
      console.log(`[supervisor:${cfg.port}] adopted existing opencode${adoptPid !== null ? ` (pid ${adoptPid})` : ''}`)
      if (adoptPid !== null) childPid = adoptPid
      if (adoptPid === null) {
        // pid unknown (non-Linux / no ss): the adopted instance is gone when
        // 127.0.0.1:port stops answering — poll the port so the outer loop
        // can respawn instead of sleeping forever (OCR review finding).
        while (!existsSync(stopFile) && !stopping && (await portOwner(cfg.port)) !== null) await sleep(1000)
      } else {
        while (childPid !== null && alive(childPid) && !existsSync(stopFile) && !stopping) await sleep(1000)
      }
    } else {
      // …or spawn our own attached child and await its exit.
      if (!existsSync(cfg.bin)) {
        console.error(`[supervisor:${cfg.port}] opencode binary missing: ${cfg.bin}`)
        process.exit(1)
      }
      appendFileSync(PROD_LOG, `\n[supervisor ${new Date().toISOString()}] spawn ${cfg.mode} :${cfg.port}\n`)
      const child = spawn(cfg.bin, [cfg.mode, '--port', cfg.port, `--hostname=${cfg.host}`], {
        cwd: workDir,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, ...cfg.env },
      })
      childPid = child.pid ?? null
      console.log(`[supervisor:${cfg.port}] started opencode (pid ${childPid})`)
      const outcome: { code: number | null; signal: string | null } = await new Promise((resolve) => {
        child.once('exit', (c, sig) => resolve({ code: c, signal: sig ?? null }))
      })
      childPid = null
      if (stopping) break
      if (!shouldRestart(outcome.code, outcome.signal, existsSync(stopFile))) {
        console.log(`[supervisor:${cfg.port}] opencode exited intentionally (code=${outcome.code ?? '-'} signal=${outcome.signal ?? '-'})`)
        cleanupAndExit()
      }
      console.log(`[supervisor:${cfg.port}] opencode CRASHED (code=${outcome.code ?? '-'} signal=${outcome.signal ?? '-'}); restarting in ${cfg.watchDelayMs / 1000}s`)
    }
    if (stopping) break
    await sleep(cfg.watchDelayMs)
  }
  cleanupAndExit()
}

// ── commands ────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
  // Internal entry: the detached supervisor process itself.
  if (argv[0] === '--supervisor') {
    const workDir = argv[1] ?? ''
    if (!workDir || !existsSync(workDir)) { console.error('[supervisor] invalid workdir'); process.exit(1) }
    await supervisorLoop(loadConfig(), workDir)
    return
  }

  // `--watch` is accepted and IGNORED (pre-0.14.0 muscle memory): supervision
  // is always on, octg-style. The first non-flag word is the command.
  const cmd = argv.find((a) => !a.startsWith('--')) ?? ''
  const rest = (() => {
    const i = argv.findIndex((a) => !a.startsWith('--'))
    return i >= 0 ? argv.slice(i + 1) : []
  })()
  const cfg = loadConfig()
  const webPort = readConfigEnv().OCRC_WEB_PORT ?? '4099'

  if (cmd === 'start') {
    const workDir = rest[0] ?? lastWorkDir()
    if (!workDir || !existsSync(workDir)) {
      console.error('usage: ocrc start <work_dir>')
      process.exit(1)
    }
    const existing = await portOwner(cfg.port)
    if (existing !== null) {
      console.log(`already running (pid ${existing.pid ?? 'unknown'}, port ${cfg.port}) — nothing to do`)
      return
    }
    const supPid = readPid(cfg.port)
    if (supPid !== null && alive(supPid)) {
      console.log(`supervisor already running (pid ${supPid}) — it will adopt or restart the instance`)
      return
    }
    if (!existsSync(cfg.bin)) {
      console.error(`opencode binary not found: ${cfg.bin} (set OCRC_SERVER_BIN in ${CONFIG_FILE})`)
      process.exit(1)
    }
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(join(RUN_DIR, 'last.json'), JSON.stringify({ workDir, port: cfg.port }, null, 2))
    // octg parity: `start` hands off to a detached supervisor and returns.
    // Spawn SELF (--supervisor) detached; stdout/stderr append to prod.log.
    const self = fileURLToPath(import.meta.url)
    const out = openSync(PROD_LOG, 'a')
    const child: ChildProcess = spawn(process.execPath, [self, '--supervisor', workDir], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...cfg.env },
    })
    child.unref()
    appendFileSync(PROD_LOG, `\n[ocrc start ${new Date().toISOString()}] supervisor pid=${child.pid} workdir=${workDir}\n`)
    console.log(`starting supervised opencode on :${cfg.port} (supervisor pid ${child.pid}, workdir ${workDir})…`)
    if (!(await waitPort(cfg.port, true, 30))) {
      console.error(`port ${cfg.port} did not come up in 30s — check ${PROD_LOG}`)
      process.exit(1)
    }
    console.log(`ready — server http://localhost:${cfg.port} · web panel http://localhost:${webPort}`)
    console.log('the ocrc plugin (Telegram + web) starts automatically inside this process')
    return
  }

  if (cmd === 'restore') {
    // Idempotent revive: nothing to do when the instance is already up —
    // this runs every boot from the @reboot cron line.
    if (await portOwner(cfg.port) !== null) {
      console.log(`already running (port ${cfg.port}) — nothing to restore`)
      return
    }
    const workDir = lastWorkDir()
    if (!workDir) { console.error('no previous work_dir on record — usage: ocrc start <work_dir> first'); process.exit(1) }
    console.log(`restoring supervised instance for ${workDir}…`)
    await main(['start', workDir])
    return
  }

  if (cmd === 'stop') {
    // The supervisor owns the child via its cleanup chain — TERM it first.
    const supPid = readPid(cfg.port)
    if (supPid !== null && alive(supPid)) {
      console.log(`stopping supervisor (pid ${supPid})…`)
      try { process.kill(supPid, 'SIGTERM') } catch { /* gone */ }
      for (let i = 0; i < 20; i++) {
        if (!alive(supPid)) break
        await sleep(500)
      }
    }
    const owner = await portOwner(cfg.port)
    if (owner === null) {
      console.log(`not running (nothing on port ${cfg.port})`)
      try { unlinkSync(pidFilePath(cfg.port)) } catch { /* already gone */ }
      return
    }
    // Owned port with unknown pid (non-Linux): still TERM the port — SIGTERM
    // to pid null is impossible, so target the supervisor pid file / port by
    // killing whatever we CAN identify; otherwise report honestly.
    const pid = owner.pid
    if (pid !== null) {
      console.log(`stopping instance (pid ${pid})…`)
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    } else {
      // pid unknown (non-Linux): TERM the supervisor from the pid file, then
      // fall through to the port wait — the port is the ground truth.
      const supPid = readPid(cfg.port)
      if (supPid !== null) { try { process.kill(supPid, 'SIGTERM') } catch { /* gone */ } }
      console.log('stopping instance (pid unknown — port watch)…')
    }
    if (!(await waitPort(cfg.port, false, 15))) {
      console.log('still listening — sending SIGKILL')
      if (pid !== null) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      else if (pid !== null && pid === null) { /* unreachable */ }
      await waitPort(cfg.port, false, 5)
    }
    try { unlinkSync(pidFilePath(cfg.port)) } catch { /* already gone */ }
    console.log((await portOwner(cfg.port)) === null ? `stopped (port ${cfg.port} free)` : `port ${cfg.port} still busy — check manually`)
    return
  }

  if (cmd === 'restart') {
    const workDir = rest[0] ?? lastWorkDir()
    if (!workDir) { console.error('no previous work_dir — usage: ocrc restart <work_dir>'); process.exit(1) }
    await main(['stop'])
    await main(['start', workDir])
    return
  }

  if (cmd === 'status') {
    const portOwnerRes = await portOwner(cfg.port)
    const ver = spawnSync(cfg.bin, ['--version'], { encoding: 'utf-8' }).stdout?.trim()
    const supPid = readPid(cfg.port)
    console.log(`binary    : ${cfg.bin} (${(ver ?? 'n/a').split('\n')[0]})`)
    console.log(`server    : port ${cfg.port} ${portOwnerRes !== null ? `UP (pid ${portOwnerRes.pid ?? 'unknown'})` : 'DOWN'}`)
    console.log(`supervisor: ${supPid !== null && alive(supPid) ? `active (pid ${supPid})` : 'none'}`)
    const web = httpGetStatus(`http://127.0.0.1:${webPort}/`)
    console.log(`web panel : port ${webPort} ${web !== null ? `HTTP ${web}` : 'unreachable'}`)
    const workDir = lastWorkDir()
    if (workDir) console.log(`workdir   : ${workDir}`)
    return
  }

  console.error('usage: ocrc start <work_dir> | stop | restart [work_dir] | status | restore')
  process.exit(1)
}

// Direct-invocation guard: `start` spawns SELF with --supervisor; when this
// module IS the entry script, run main() (index.js's dispatcher is absent).
const selfPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
