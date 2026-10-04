import { describe, it, expect } from 'vitest'
import {
  sshTarget,
  buildSshArgs,
  buildServeCommand,
  parseGlibcVersion,
  nextRetryDelay,
  buildProvisionCommand,
} from '../../src/core/remote-host'
import { createOpencodeBackend } from '../../src/core/agent/opencode-backend'

describe('remote-host pure helpers', () => {
  it('sshTarget renders user@host or bare host', () => {
    expect(sshTarget({ host: 'box.lan', user: 'demo' })).toBe('demo@box.lan')
    expect(sshTarget({ host: 'box.lan' })).toBe('box.lan')
  })

  it('buildSshArgs: tunnel spec, BatchMode, ExitOnForwardFailure, optional command', () => {
    const args = buildSshArgs({ host: 'box.lan', port: 2222, user: 'u', remotePort: 4199 }, 41001)
    expect(args).toContain('127.0.0.1:41001:127.0.0.1:4199')
    expect(args).toContain('-N')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('BatchMode=yes')
    expect(args.at(-1)).toBe('u@box.lan')

    const withCmd = buildSshArgs({ host: 'box.lan', port: 22, user: undefined, remotePort: 4199 }, 1, 'serve here')
    expect(withCmd.at(-2)).toBe('box.lan')
    expect(withCmd.at(-1)).toBe('serve here')
  })

  it('buildServeCommand quotes the binary and password; PATH covers both install roots', () => {
    const cmd = buildServeCommand('$HOME/.opencode/bin/opencode', 4199, 'p@ss w/rd')
    expect(cmd).toContain(`OPENCODE_SERVER_PASSWORD='p@ss w/rd'`)
    expect(cmd).toContain(`'$HOME/.opencode/bin/opencode' serve --hostname 127.0.0.1 --port 4199`)
    expect(cmd).toContain('PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"')
    // single-quote escaping keeps hostile-ish content inert
    const evil = buildServeCommand("x'; rm -rf ~; '", 1, 'pw')
    expect(evil).toContain(`'x'\\''; rm -rf ~; '\\'''`)
  })

  it('parseGlibcVersion extracts n.n from ldd output', () => {
    expect(parseGlibcVersion('ldd (GNU libc) 2.17')).toBe('2.17')
    expect(parseGlibcVersion('ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35')).toBe('2.35')
    expect(parseGlibcVersion(undefined)).toBeUndefined()
    expect(parseGlibcVersion('')).toBeUndefined()
  })

  it('nextRetryDelay doubles and caps at 60s', () => {
    expect(nextRetryDelay(1)).toBe(2000)
    expect(nextRetryDelay(2)).toBe(4000)
    expect(nextRetryDelay(5)).toBe(32000)
    expect(nextRetryDelay(6)).toBe(60000)
    expect(nextRetryDelay(20)).toBe(60000)
  })

  it('buildProvisionCommand pins the official installer version when given', () => {
    expect(buildProvisionCommand('1.18.32')).toBe('curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.32')
    expect(buildProvisionCommand('')).toBe('curl -fsSL https://opencode.ai/install | bash -s --')
  })
})

describe('remote backend derates (0.26.0)', () => {
  // Minimal fake — construction must not touch the client.
  const client = {} as never

  it('remote: true drops local-filesystem methods and mirrors/tui', () => {
    const remote = createOpencodeBackend({ client, remote: true, id: 'remote:x', host: 'box.lan' })
    expect(remote.id).toBe('remote:x')
    expect(remote.host).toBe('box.lan')
    expect(remote.capabilities.liveMirror).toBe(false)
    expect(remote.capabilities.tuiSelect).toBe(false)
    expect('getVcs' in remote).toBe(false)
    expect('getVcsDiff' in remote).toBe(false)
    // HTTP-backed surfaces stay on.
    expect(remote.capabilities.diff).toBe(true)
    expect(remote.capabilities.files).toBe(true)
    expect(typeof remote.getDiff).toBe('function')
  })

  it('local backend keeps the full surface', () => {
    const local = createOpencodeBackend({ client })
    expect(local.capabilities.liveMirror).toBe(true)
    expect(typeof local.getVcs).toBe('function')
    expect(typeof local.getVcsDiff).toBe('function')
  })
})
