import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASKPASS_VALUE_ENV, askpassDir, askpassEnv, askpassShellScript, ensureAskpassFiles, needsAskpass, resetAskpassCache,
} from '../../src/core/ssh-askpass.js'
import {
  buildForwardArgs, buildSshExecArgs, redactInstance, type RemoteInstance,
} from '../../src/core/remote-instance.js'
import { createRemoteInstancesStore } from '../../src/core/remote-instances.js'

/**
 * A1 — the peer's account may only have a password. ssh has no flag for one, so
 * the mode is expressed as (a) different argv and (b) an askpass helper that
 * reads the value from the environment. Both halves have to be right together:
 * argv without the helper hangs on a prompt, and the helper without argv is
 * never consulted.
 */

const SECRET = 'hp93000-not-a-real-password'
const tmpDirs: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-askpass-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  resetAskpassCache()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ssh argv per auth mode', () => {
  it('key mode is the default and keeps the non-interactive contract', () => {
    const args = buildSshExecArgs({ host: 'peer' }, 'true')
    expect(args).toContain('BatchMode=yes')
    expect(args).not.toContain('PubkeyAuthentication=no')
  })

  it('an explicit key mode is byte-identical to the default', () => {
    expect(buildSshExecArgs({ host: 'peer', sshAuth: 'key' }, 'true'))
      .toEqual(buildSshExecArgs({ host: 'peer' }, 'true'))
  })

  it('password mode turns interaction on and public keys off', () => {
    const args = buildSshExecArgs({ host: 'peer', sshAuth: 'password', sshPassword: SECRET }, 'true')
    // Without this ssh never consults SSH_ASKPASS at all.
    expect(args).toContain('BatchMode=no')
    expect(args).not.toContain('BatchMode=yes')
    // A passphrase-protected key in ~/.ssh would otherwise be offered first and
    // turn a password peer into a "wrong passphrase" failure.
    expect(args).toContain('PubkeyAuthentication=no')
    expect(args).toContain('PreferredAuthentications=password,keyboard-interactive')
    // One bad password must not spend the host proxy's whole 20 s budget.
    expect(args).toContain('NumberOfPasswordPrompts=1')
  })

  it('carries the password nowhere in argv', () => {
    const args = buildSshExecArgs({ host: 'peer', sshAuth: 'password', sshPassword: SECRET }, 'true')
    expect(args.join(' ')).not.toContain(SECRET)
  })

  it('the tunnel authenticates the same way as the probe', () => {
    const args = buildForwardArgs({
      host: 'peer', port: 22, user: 'demo', sshAuth: 'password', sshPassword: SECRET,
      localPort: 4610, remotePort: 2610,
    })
    expect(args).toContain('BatchMode=no')
    expect(args).toContain('PubkeyAuthentication=no')
    expect(args.join(' ')).not.toContain(SECRET)
  })

  it('a password without the mode is still key mode (no silent upgrade)', () => {
    const args = buildSshExecArgs({ host: 'peer', sshPassword: SECRET }, 'true')
    expect(args).toContain('BatchMode=yes')
    expect(needsAskpass({ sshPassword: SECRET })).toBe(false)
  })
})

describe('askpass helper', () => {
  it('is not consulted in key mode', () => {
    expect(askpassEnv({})).toBeUndefined()
    expect(askpassEnv({ sshAuth: 'password' })).toBeUndefined() // no password → no askpass
  })

  it('carries the password in the env, never in the file', () => {
    const dir = tmp()
    const env = askpassEnv({ sshAuth: 'password', sshPassword: `  ${SECRET}  ` }, { dir, platform: 'linux' })
    expect(env).toBeDefined()
    expect(env?.[ASKPASS_VALUE_ENV]).toBe(SECRET) // trimmed: a trailing newline from a paste must not become part of the password
    expect(env?.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(env?.SSH_ASKPASS).toBe(join(dir, 'askpass.sh'))
    expect(env?.DISPLAY).toBe('1')
    const script = readFileSync(env!.SSH_ASKPASS!, 'utf-8')
    expect(script).not.toContain(SECRET)
    expect(script).toContain(ASKPASS_VALUE_ENV)
  })

  it('writes the posix helper 0700', () => {
    // chmod only toggles the read-only bit on Windows, so the mode assertion is
    // meaningful on the platforms that have modes at all.
    if (process.platform === 'win32') return
    const dir = tmp()
    const path = ensureAskpassFiles(dir, 'linux')
    expect(statSync(path).mode & 0o777).toBe(0o700)
  })

  it('answers only password-looking prompts', () => {
    const script = askpassShellScript()
    // The prompt match is what keeps a host-key yes/no question from being
    // answered with a password.
    expect(script).toContain('*assword*')
    expect(script).toContain('*assphrase*')
    expect(script).not.toContain('yes/no')
    // Anything else prints an empty line: ssh gives up on its own terms.
    expect(script).toMatch(/printf '\\n'/)
  })

  it('uses the two-file cmd wrapper on Windows', () => {
    const dir = tmp()
    const path = ensureAskpassFiles(dir, 'win32')
    expect(path.endsWith('askpass.cmd')).toBe(true)
    expect(existsSync(join(dir, 'askpass.ps1'))).toBe(true)
    expect(readFileSync(join(dir, 'askpass.cmd'), 'utf-8')).toContain('powershell.exe')
    expect(readFileSync(join(dir, 'askpass.ps1'), 'utf-8')).toContain(ASKPASS_VALUE_ENV)
    expect(readFileSync(join(dir, 'askpass.ps1'), 'utf-8')).not.toContain(SECRET)
  })

  it('keeps the helper out of a shared temp dir', () => {
    // The path ends up in an ssh argv we log; a per-run temp path would be
    // unreadable in the log and unreviewable on disk.
    expect(askpassDir('/home/u/.ocrc')).toBe(join('/home/u/.ocrc', 'ssh'))
  })
})

describe('the password never leaves the store', () => {
  const base: RemoteInstance = {
    id: 'demo@peer', host: 'peer', port: 22, user: 'demo',
    sshAuth: 'password', sshPassword: SECRET,
    instancePort: 2610, localPort: 4610, appVersion: '2.3.3', uiPassword: 'ui-secret', enabled: true,
  }

  it('redactInstance drops it and says it exists', () => {
    const red = redactInstance(base) as Record<string, unknown>
    expect(red.sshPassword).toBeUndefined()
    expect(red.hasSshPassword).toBe(true)
    expect(red.uiPassword).toBeUndefined()
    expect(red.hasUiPassword).toBe(true)
    expect(JSON.stringify(red)).not.toContain(SECRET)
  })

  it('the store keeps it in password mode and erases it in key mode', () => {
    const path = join(tmp(), 'remote-instances.json')
    const store = createRemoteInstancesStore(path, { flushOnExit: false })
    store.upsert({ ...base })
    store.flush()
    expect(JSON.parse(readFileSync(path, 'utf-8')).instances[0].sshPassword).toBe(SECRET)

    // Switching back to key mode must delete the credential, not park it: a
    // secret the UI no longer shows is what leaks out of a backup later.
    store.upsert({ host: 'peer', user: 'demo', sshAuth: 'key' })
    store.flush()
    const saved = JSON.parse(readFileSync(path, 'utf-8')).instances[0]
    expect(saved.sshPassword).toBeUndefined()
    expect(saved.sshAuth).toBeUndefined()
  })

  it('the store persists a fresh password-mode record', () => {
    const path = join(tmp(), 'remote-instances.json')
    const store = createRemoteInstancesStore(path, { flushOnExit: false })
    const saved = store.upsert({ host: 'peer2', user: 'demo', sshAuth: 'password', sshPassword: SECRET })
    expect(saved.sshAuth).toBe('password')
    expect(saved.sshPassword).toBe(SECRET)
  })
})
