// service.ts — `ocrc start|stop|restart|status|restore`: production instance
// lifecycle, the octg `octg start <dir>` ergonomic.
//
// Two start modes:
//   ocrc start <dir>          detached one-shot launcher (no supervision).
//   ocrc start --watch <dir>  FOREGROUND supervisor (run-4096.sh semantics in
//                             Node): adopt-or-spawn, crash-restart after a
//                             delay, exit-code>=128 / stop-file = intentional
//                             stop. User runs it under nohup/tmux; `ocrc
//                             restore` re-launches it after reboot.
// The plugin still cannot supervise its own host — the watcher is this CLI
// process watching from outside; in steady state it is a dormant poll loop.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
 * Watch-loop restart decision: an intentional stop is either the stop file
 * or the process dying to a signal (exit code ≥ 128 — SIGTERM/SIGKILL'ed
 * children report 128+signal). Anything else is a crash → restart.
 */
export function shouldRestart(exitCode: number | null, stopFileExists: boolean): boolean {
  if (stopFileExists) return false
  if (exitCode !== null && exitCode >= 128) return false
  return true
}

/** Find the pid listening on a port via ss (Linux production tool). */
export function pidOnPort(port: string): number | null {
  const res = spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf-8' })
  const m = (res.stdout ?? '').match(/pid=(\d+)/)
  return m ? Number(m[1]) : null
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function pidFilePath(port: string, kind: 'prod' | 'watch'): string {
  return join(RUN_DIR, `${kind}-${port}.pid`)
}

function readPid(port: string, kind: 'prod' | 'watch'): number | null {
  try {
    const raw = readFileSync(pidFilePath(port, kind), 'utf-8').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitPort(port: string, up: boolean, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if ((pidOnPort(port) !== null) === up) return true
    await sleep(500)
  }
  return (pidOnPort(port) !== null) === up
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

// ── watch mode: the foreground supervisor ───────────────────────────────────

async function watchLoop(cfg: ServiceConfig, workDir: string): Promise<void> {
  const stopFile = join(RUN_DIR, `.stop-${cfg.port}`)
  const watchPidFile = pidFilePath(cfg.port, 'watch')
  let child: ChildProcess | null = null
  let childPid: number | null = null
  let stopping = false

  const killChild = (): void => {
    if (childPid !== null) { try { process.kill(childPid, 'SIGTERM') } catch { /* gone */ } }
  }
  const cleanupAndExit = (): void => {
    killChild()
    try { unlinkSync(stopFile) } catch { /* absent */ }
    try { unlinkSync(watchPidFile) } catch { /* absent */ }
    console.log(`[watch:${cfg.port}] stopped`)
    process.exit(0)
  }
  process.on('SIGTERM', () => { stopping = true; killChild() })
  process.on('SIGINT', () => { stopping = true; killChild() })

  mkdirSync(RUN_DIR, { recursive: true })
  writeFileSync(watchPidFile, String(process.pid))
  console.log(`[watch:${cfg.port}] supervising (pid ${process.pid}, workdir ${workDir}; stop: ocrc stop)`)

  while (!stopping) {
    if (existsSync(stopFile)) { console.log(`[watch:${cfg.port}] stop file detected`); cleanupAndExit() }

    // Adopt an already-listening instance (octg takeover semantics)…
    const existing = pidOnPort(cfg.port)
    if (existing !== null) {
      console.log(`[watch:${cfg.port}] adopted existing opencode (pid ${existing})`)
      childPid = existing
      while (alive(childPid) && !existsSync(stopFile) && !stopping) await sleep(1000)
    } else {
      // …or spawn our own attached child and await its exit code.
      if (!existsSync(cfg.bin)) {
        console.error(`[watch:${cfg.port}] opencode binary missing: ${cfg.bin}`)
        process.exit(1)
      }
      appendFileSync(PROD_LOG, `\n[watch ${new Date().toISOString()}] spawn ${cfg.mode} :${cfg.port}\n`)
      child = spawn(cfg.bin, [cfg.mode, '--port', cfg.port, `--hostname=${cfg.host}`], {
        cwd: workDir,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, ...cfg.env },
      })
      childPid = child.pid ?? null
      console.log(`[watch:${cfg.port}] started opencode (pid ${childPid})`)
      const code: number | null = await new Promise((resolve) => {
        child!.once('exit', (_c, signal) => resolve(signal ? 128 + 15 : _c))
      })
      child = null
      childPid = null
      if (stopping) break
      if (!shouldRestart(code, existsSync(stopFile))) {
        console.log(`[watch:${cfg.port}] opencode exited intentionally (code=${code ?? 'signal'})`)
        cleanupAndExit()
      }
      console.log(`[watch:${cfg.port}] opencode CRASHED (code=${code}); restarting in ${cfg.watchDelayMs / 1000}s`)
    }
    if (stopping) break
    await sleep(cfg.watchDelayMs)
  }
  cleanupAndExit()
}

// ── commands ────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
  // argv[0] is the command word; --watch may sit anywhere after it.
  const watch = argv.includes('--watch')
  const args = argv.filter((a) => a !== '--watch')
  const cmd = args[0]
  const rest = args.slice(1)
  const cfg = loadConfig()
  const webPort = readConfigEnv().OCRC_WEB_PORT ?? '4099'

  if (cmd === 'start') {
    const workDir = rest[0] ?? lastWorkDir()
    if (!workDir || !existsSync(workDir)) {
      console.error('usage: ocrc start [--watch] <work_dir>')
      process.exit(1)
    }
    if (watch) {
      // One watcher per port: a live watch pid file refuses to double-start.
      const wpid = readPid(cfg.port, 'watch')
      if (wpid !== null && alive(wpid)) {
        console.log(`watcher already running (pid ${wpid}) — nothing to do`)
        return
      }
      await watchLoop(cfg, workDir)
      return
    }
    const existing = pidOnPort(cfg.port)
    if (existing !== null) {
      console.log(`already running (pid ${existing}, port ${cfg.port}) — nothing to do`)
      return
    }
    if (!existsSync(cfg.bin)) {
      console.error(`opencode binary not found: ${cfg.bin} (set OCRC_SERVER_BIN in ${CONFIG_FILE})`)
      process.exit(1)
    }
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(join(RUN_DIR, 'last.json'), JSON.stringify({ workDir, port: cfg.port }, null, 2))
    // Detached + unref + stdin ignored: the child survives the CLI exiting
    // (nohup-equivalent). stdout/stderr append to prod.log.
    const out = openSync(PROD_LOG, 'a')
    const child: ChildProcess = spawn(cfg.bin, [cfg.mode, '--port', cfg.port, `--hostname=${cfg.host}`], {
      cwd: workDir,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...cfg.env },
    })
    child.unref()
    appendFileSync(PROD_LOG, `\n[ocrc start ${new Date().toISOString()}] pid=${child.pid} workdir=${workDir}\n`)
    console.log(`starting opencode ${cfg.mode} on :${cfg.port} (pid ${child.pid}, workdir ${workDir})…`)
    if (!(await waitPort(cfg.port, true, 30))) {
      console.error(`port ${cfg.port} did not come up in 30s — check ${PROD_LOG}`)
      process.exit(1)
    }
    console.log(`ready — server http://localhost:${cfg.port} · web panel http://localhost:${webPort}`)
    console.log('the ocrc plugin (Telegram + web) starts automatically inside this process')
    return
  }

  if (cmd === 'restore') {
    const workDir = lastWorkDir()
    if (!workDir) { console.error('no previous work_dir on record — usage: ocrc start --watch <work_dir> first'); process.exit(1) }
    console.log(`restoring watched instance for ${workDir}…`)
    await main(['--watch', workDir])
    return
  }

  if (cmd === 'stop') {
    // The watcher owns the child via its cleanup chain — TERM it first.
    const wpid = readPid(cfg.port, 'watch')
    if (wpid !== null && alive(wpid)) {
      console.log(`stopping watcher (pid ${wpid})…`)
      try { process.kill(wpid, 'SIGTERM') } catch { /* gone */ }
      // Watcher's cleanup chain: TERM child → free port → remove files.
      for (let i = 0; i < 20; i++) {
        if (!alive(wpid)) break
        await sleep(500)
      }
    }
    let pid = readPid(cfg.port, 'prod')
    if (pid !== null && !alive(pid)) pid = null
    if (pid === null) pid = pidOnPort(cfg.port)
    if (pid === null) {
      console.log(`not running (nothing on port ${cfg.port})`)
      try { unlinkSync(pidFilePath(cfg.port, 'prod')) } catch { /* already gone */ }
      try { unlinkSync(pidFilePath(cfg.port, 'watch')) } catch { /* already gone */ }
      return
    }
    console.log(`stopping instance (pid ${pid})…`)
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    if (!(await waitPort(cfg.port, false, 15))) {
      console.log('still listening — sending SIGKILL')
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      await waitPort(cfg.port, false, 5)
    }
    try { unlinkSync(pidFilePath(cfg.port, 'prod')) } catch { /* already gone */ }
    console.log(pidOnPort(cfg.port) === null ? `stopped (port ${cfg.port} free)` : `port ${cfg.port} still busy — check manually`)
    return
  }

  if (cmd === 'restart') {
    const workDir = rest[0] ?? lastWorkDir()
    if (!workDir) { console.error('no previous work_dir — usage: ocrc restart <work_dir>'); process.exit(1) }
    const wasWatched = (() => {
      const wpid = readPid(cfg.port, 'watch')
      return wpid !== null && alive(wpid)
    })()
    await main(['stop'])
    await main(wasWatched ? ['--watch', workDir] : ['start', workDir])
    return
  }

  if (cmd === 'status') {
    const portPid = pidOnPort(cfg.port)
    const ver = spawnSync(cfg.bin, ['--version'], { encoding: 'utf-8' }).stdout?.trim()
    const wpid = readPid(cfg.port, 'watch')
    console.log(`binary : ${cfg.bin} (${(ver ?? 'n/a').split('\n')[0]})`)
    console.log(`server : port ${cfg.port} ${portPid !== null ? `UP (pid ${portPid})` : 'DOWN'}`)
    console.log(`watch  : ${wpid !== null && alive(wpid) ? `active (pid ${wpid})` : 'none (bare start)'}`)
    const web = httpGetStatus(`http://127.0.0.1:${webPort}/`)
    console.log(`web    : port ${webPort} ${web !== null ? `HTTP ${web}` : 'unreachable'}`)
    const workDir = lastWorkDir()
    if (workDir) console.log(`workdir: ${workDir}`)
    return
  }

  console.error('usage: ocrc start [--watch] <work_dir> | stop | restart [work_dir] | restore | status')
  process.exit(1)
}
