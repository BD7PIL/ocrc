import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, remoteHelp } from '../../src/cli/remote.js'

/**
 * `src/cli/remote.ts` had zero tests — every exit code below is a contract a
 * script (and the extension service) relies on:
 *   · a usage mistake = 2, a failed step = 1, success = no exit call;
 *   · a non-TTY run without `--yes` refuses at the gate (exit 2), before
 *     touching anything;
 *   · `--dry-run` still registers the record (merge semantics visible on disk)
 *     and never spawns ssh;
 *   · the store paths land under OCRC_HOME (tests/setup.ts points it at a temp
 *     dir), so these tests never touch a real ~/.ocrc.
 *
 * main() is driven directly; process.exit is stubbed to throw so a stray exit
 * fails the test instead of killing the worker.
 */

class ExitError extends Error {
  constructor(readonly code: string | number | null) {
    super(`exit ${code}`)
  }
}

let exitMock: { mockRestore(): void } | undefined
let logs: string[] = []
let errors: string[]
let origLog: typeof console.log
let origError: typeof console.error

function capture(): void {
  exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new ExitError(code ?? 0)
  }) as never)
  logs = []
  errors = []
  origLog = console.log
  origError = console.error
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
}

function restore(): void {
  exitMock?.mockRestore()
  exitMock = undefined
  if (origLog) console.log = origLog
  if (origError) console.error = origError
}

/** Run `ocrc remote …` with capture on; returns exit code (0 = main returned). */
async function run(argv: string[]): Promise<number> {
  try {
    await main(argv)
    return 0
  } catch (err) {
    if (err instanceof ExitError) return Number(err.code)
    throw err
  }
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'ocrc-cli-'))
}

const storePath = (home: string) => join(home, 'remote-instances.json')

/** The store debounces writes (~100 ms); a stubbed process.exit never fires the
 *  flush hook, so wait for the file instead of racing it. */
async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

describe('cli remote — usage errors exit 2 before anything runs', () => {
  afterEach(restore)

  it.each([
    ['no id and no target', ['bootstrap']],
    ['bad --target shape', ['bootstrap', '--target', 'dev peer']],
    ['bad --port', ['bootstrap', '--target', 'dev@peer', '--port', 'abc']],
    ['bad --egress', ['bootstrap', '--target', 'dev@peer', '--egress', 'sideways']],
    ['bad --provision', ['bootstrap', '--target', 'dev@peer', '--provision', 'teleport']],
    ['bad --ssh-auth', ['bootstrap', '--target', 'dev@peer', '--ssh-auth', 'token']],
  ])('%s → exit 2', async (_name, argv) => {
    capture()
    const code = await run(argv)
    expect(code).toBe(2)
    expect(errors.join('\n')).toContain('用法错误')
  })

  it('non-TTY without --yes is refused at the gate (exit 2), and nothing is written', async () => {
    const home = tempHome()
    const saved = process.env.OCRC_HOME
    process.env.OCRC_HOME = home
    try {
      capture()
      // stdin is not a TTY under vitest — exactly the scripted-run situation.
      const code = await run(['bootstrap', '--target', 'dev@peer'])
      expect(code).toBe(2)
      expect(existsSync(storePath(home))).toBe(false)
    } finally {
      process.env.OCRC_HOME = saved
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('unknown subcommand → exit 2', async () => {
    capture()
    const code = await run(['frobnicate'])
    expect(code).toBe(2)
    expect(errors.join('\n')).toContain('未知子命令')
    expect(logs.join('\n')).toContain('ocrc remote')
  })
})

describe('cli remote — bootstrap dry run', () => {
  afterEach(restore)

  it('registers the record locally before planning, and a second run stays merge-safe', async () => {
    const home = tempHome()
    const saved = process.env.OCRC_HOME
    process.env.OCRC_HOME = home
    try {
      capture()
      // `peer` does not exist: plan honestly fails (exit 1, 预演失败) — the
      // point here is that the record upsert has already happened and survives.
      const first = await run(['bootstrap', '--target', 'dev@peer', '--dry-run'])
      expect(first).toBe(1)
      expect(logs.join('\n')).toContain('预演失败')
      await waitForFile(storePath(home))
      const onDisk = JSON.parse(readFileSync(storePath(home), 'utf-8')) as {
        instances: Array<{ id: string; host: string; uiPassword: string; localPort: number }>
      }
      expect(onDisk.instances).toHaveLength(1)
      const rec = onDisk.instances[0]!
      expect(rec.host).toBe('peer')
      expect(rec.uiPassword).toMatch(/^[A-Za-z0-9_-]{24}$/)

      // A second dry run names nothing the first set: the stored uiPassword and
      // ports must survive — merge-not-overwrite, end to end through the CLI.
      const second = await run(['bootstrap', rec.id, '--dry-run'])
      expect(second).toBe(1)
      await waitForFile(storePath(home))
      const again = JSON.parse(readFileSync(storePath(home), 'utf-8')) as {
        instances: Array<{ id: string; uiPassword: string; localPort: number }>
      }
      expect(again.instances).toHaveLength(1)
      expect(again.instances[0]!.uiPassword).toBe(rec.uiPassword)
      expect(again.instances[0]!.localPort).toBe(rec.localPort)
    } finally {
      process.env.OCRC_HOME = saved
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('cli remote — add / list', () => {
  afterEach(restore)

  it('add without --host fails; a valid add shows up in list --json', async () => {
    const home = tempHome()
    const saved = process.env.OCRC_HOME
    process.env.OCRC_HOME = home
    try {
      capture()
      await expect(main(['add', '--user', 'dev'])).rejects.toThrow(/--host/)
      const code = await run(['add', '--host', 'peer.example', '--user', 'dev', '--egress', 'relay'])
      expect(code).toBe(0)
      expect(logs.join('\n')).toContain('已登记')
      // The store write is 100 ms-debounced and the CLI's flush normally rides
      // the process-exit hook (stubbed here); wait out the debounce instead.
      await new Promise((r) => setTimeout(r, 250))

      logs = []
      const listCode = await run(['list', '--json'])
      expect(listCode).toBe(0)
      const parsed = JSON.parse(logs.join('\n')) as { instances: Array<{ host: string; egress: string; uiPassword?: string }> }
      expect(parsed.instances).toHaveLength(1)
      expect(parsed.instances[0]!.host).toBe('peer.example')
      expect(parsed.instances[0]!.egress).toBe('relay')
      // list --json goes through redactInstance: the door password never leaves the file.
      expect(parsed.instances[0]!.uiPassword).toBeUndefined()
    } finally {
      process.env.OCRC_HOME = saved
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('add rejects a malformed --provider-baseurl pair', async () => {
    const home = tempHome()
    const saved = process.env.OCRC_HOME
    process.env.OCRC_HOME = home
    try {
      capture()
      await expect(main(['add', '--host', 'peer', '--provider-baseurl', 'nourl'])).rejects.toThrow(/id=url/)
    } finally {
      process.env.OCRC_HOME = saved
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('--ssh-auth password reads one line from stdin when piped', async () => {
    const home = tempHome()
    const saved = process.env.OCRC_HOME
    process.env.OCRC_HOME = home
    // The non-TTY stdin branch reads fd 0 synchronously — under vitest that is
    // the worker's own stdin, so exercise it in a child running the real CLI
    // from dist/ (built before tests by preflight; skip if dist is absent).
    const { spawnSync } = await import('node:child_process')
    const cli = join(process.cwd(), 'dist', 'cli', 'index.js')
    if (!existsSync(cli)) {
      rmSync(home, { recursive: true, force: true })
      return
    }
    try {
      const r = spawnSync(process.execPath, [cli, 'remote', 'add', '--host', 'peer.example', '--ssh-auth', 'password'], {
        input: 'piped-secret\n',
        encoding: 'utf-8',
        env: { ...process.env, OCRC_HOME: home },
      })
      expect(r.status).toBe(0)
      const onDisk = JSON.parse(readFileSync(storePath(home), 'utf-8')) as {
        instances: Array<{ sshAuth?: string; sshPassword?: string }>
      }
      expect(onDisk.instances[0]!.sshAuth).toBe('password')
      expect(onDisk.instances[0]!.sshPassword).toBe('piped-secret')
    } finally {
      process.env.OCRC_HOME = saved
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('cli remote — offline-proof and help', () => {
  afterEach(restore)

  it('offline-proof asserts every remote script is egress-free (exit 0, OK line)', async () => {
    capture()
    const code = await run(['offline-proof'])
    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('OK: 所有远程脚本零联网命令')
    expect(logs.join('\n')).not.toContain('FAIL')
  })

  it('help prints the usage text without exiting', async () => {
    capture()
    const code = await run([])
    expect(code).toBe(0)
    // HELP is a template literal: leading and trailing newlines are part of it.
    expect(logs.join('\n')).toBe(remoteHelp)
  })
})
