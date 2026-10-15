import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sshTarget,
  buildSshArgs,
  buildServeCommand,
  parseGlibcVersion,
  nextRetryDelay,
  buildProvisionCommand,
  buildConfigEntries,
  buildConfigApplyScript,
  buildProxyExports,
  CONFIG_SYNC_ENTRIES,
} from '../../src/core/remote-host'
import { createOpencodeBackend } from '../../src/core/agent/opencode-backend'

describe('buildProxyExports (enterprise relay, 0.27)', () => {
  it('empty when nothing configured', () => {
    expect(buildProxyExports(undefined)).toBe('')
    expect(buildProxyExports({})).toBe('')
  })

  it('injects upper+lower case proxy vars and forces NO_PROXY loopback', () => {
    const out = buildProxyExports({ httpProxy: 'http://gw.corp:3128' })
    expect(out).toContain(`HTTP_PROXY='http://gw.corp:3128'`)
    expect(out).toContain(`http_proxy='http://gw.corp:3128'`)
    expect(out).toContain(`NO_PROXY='127.0.0.1,localhost'`)
    expect(out).toContain(`no_proxy='127.0.0.1,localhost'`)
    expect(out.startsWith('export ')).toBe(true)
  })

  it('appends loopback to a user NO_PROXY that lacks it; keeps one that has it', () => {
    const added = buildProxyExports({ httpsProxy: 'https://gw:443', noProxy: '.corp.internal' })
    expect(added).toContain(`NO_PROXY='.corp.internal,127.0.0.1,localhost'`)
    const kept = buildProxyExports({ httpsProxy: 'https://gw:443', noProxy: '127.0.0.1,.corp' })
    expect(kept).toContain(`NO_PROXY='127.0.0.1,.corp'`)
  })

  it('standalone noProxy passes through untouched; CA maps to NODE_EXTRA_CA_CERTS', () => {
    expect(buildProxyExports({ noProxy: 'a,b' })).toContain(`NO_PROXY='a,b'`)
    expect(buildProxyExports({ caPath: '/etc/pki/corp-ca.pem' })).toContain(`NODE_EXTRA_CA_CERTS='/etc/pki/corp-ca.pem'`)
  })

  it('single-quote escaping keeps hostile values inert', () => {
    const out = buildProxyExports({ httpProxy: "http://x'; rm -rf ~; '" })
    expect(out).toContain(`HTTP_PROXY='http://x'\\''; rm -rf ~; '\\'''`)
  })
})

describe('config sync helpers (0.26.6)', () => {
  it('buildConfigEntries returns only existing whitelist entries; plugin/ is never synced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-cfg-'))
    writeFileSync(join(dir, 'opencode.json'), '{}')
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    mkdirSync(join(dir, 'command'))
    mkdirSync(join(dir, 'plugin')) // exists but NOT on the whitelist
    const entries = buildConfigEntries(dir)
    expect(entries).toEqual(['opencode.json', 'AGENTS.md', 'command'])
    // all-missing dir → nothing to sync
    expect(buildConfigEntries(join(dir, 'absent'))).toEqual([])
    expect(CONFIG_SYNC_ENTRIES).not.toContain('plugin')
  })

  it('buildConfigApplyScript: staging dir, tar from stdin, *.ocrc-bak backups, cleanup', () => {
    const script = buildConfigApplyScript()
    expect(script).toContain('tar -xzf - -C "$S"')
    expect(script).toContain('.ocrc-bak')
    expect(script).toContain('rm -rf "$S"')
    // backup ONLY when the target already exists (no silent overwrite)
    expect(script).toContain('if [ -f "$tgt" ]; then')
    expect(script).toContain('echo "backup: $rel"')
    expect(script).toContain('echo "new: $rel"')
  })
})

describe('remote-host pure helpers', () => {
  it('sshTarget renders user@host or bare host', () => {
    expect(sshTarget({ host: 'box.lan', user: 'demo' })).toBe('demo@box.lan')
    expect(sshTarget({ host: 'box.lan' })).toBe('box.lan')
  })

  it('buildSshArgs: tunnel spec, BatchMode, ExitOnForwardFailure, optional command', () => {
    const args = buildSshArgs({ id: 't', enabled: true, host: 'box.lan', port: 2222, user: 'u', remotePort: 4199 }, 41001)
    expect(args).toContain('127.0.0.1:41001:127.0.0.1:4199')
    expect(args).toContain('-N')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('BatchMode=yes')
    expect(args.at(-1)).toBe('u@box.lan')

    const withCmd = buildSshArgs({ id: 't', enabled: true, host: 'box.lan', port: 22, user: undefined, remotePort: 4199 }, 1, 'serve here')
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

describe('syncDirectory guards (2.0.0-alpha.3)', () => {
  it('rejects entries that escape the local root before touching ssh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-sync-'))
    const { createRemotesStore } = await import('../../src/core/remotes')
    const store = createRemotesStore(join(dir, 'remotes.json'))
    store.upsert({ id: 'lab', host: '127.0.0.1', port: 22, remotePort: 4301 })
    const { createRemoteHostManager } = await import('../../src/core/remote-host')
    const mgr = createRemoteHostManager({ store })
    await expect(mgr.syncDirectory('lab', { localRoot: dir, remoteTarget: '~/ws', entries: ['../escape'] }))
      .rejects.toThrow(/entry escapes local root/)
  })

  it('rejects relative remoteTarget; accepts ~ and absolute forms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-sync-'))
    const { createRemotesStore } = await import('../../src/core/remotes')
    const store = createRemotesStore(join(dir, 'remotes.json'))
    store.upsert({ id: 'lab', host: '127.0.0.1', port: 22, remotePort: 4301 })
    const { createRemoteHostManager } = await import('../../src/core/remote-host')
    const mgr = createRemoteHostManager({ store })
    const rel = await mgr.syncDirectory('lab', { localRoot: dir, remoteTarget: 'workspaces/rel' })
    expect(rel.ok).toBe(false)
    expect(rel.detail).toContain('absolute path')
    // missing local root is surfaced without any ssh attempt
    const miss = await mgr.syncDirectory('lab', { localRoot: join(dir, 'nope'), remoteTarget: '~/ws' })
    expect(miss.ok).toBe(false)
    expect(miss.detail).toContain('local root not found')
  })

  it('unknown remote id fails with a plain detail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-sync-'))
    const { createRemotesStore } = await import('../../src/core/remotes')
    const store = createRemotesStore(join(dir, 'remotes.json'))
    const { createRemoteHostManager } = await import('../../src/core/remote-host')
    const mgr = createRemoteHostManager({ store })
    const res = await mgr.syncDirectory('ghost', { localRoot: dir, remoteTarget: '~/ws' })
    expect(res).toEqual({ ok: false, detail: 'unknown remote' })
  })
})

describe('extra env exports (batch 5)', () => {
  it('buildExtraEnvExports: empty/undefined → empty string', async () => {
    const { buildExtraEnvExports } = await import('../../src/core/remote-host')
    expect(buildExtraEnvExports(undefined)).toBe('')
    expect(buildExtraEnvExports({})).toBe('')
  })

  it('renders sorted, single-quoted exports; hostile values inert; bad names dropped', async () => {
    const { buildExtraEnvExports } = await import('../../src/core/remote-host')
    const out = buildExtraEnvExports({ B: "x'; rm -rf ~; '", A: 'v', 'bad name': 'z' })
    expect(out.startsWith('export ')).toBe(true)
    expect(out).toContain(`A='v'`)
    expect(out.indexOf("A='v'")).toBeLessThan(out.indexOf(`B='x'`))
    expect(out).toContain(`B='x'\\''; rm -rf ~; '\\'''`)
    expect(out).not.toContain('bad name')
  })

  it('buildServeCommand appends env exports before the password', async () => {
    const { buildServeCommand } = await import('../../src/core/remote-host')
    const cmd = buildServeCommand('/usr/bin/opencode', 4199, 'pw', undefined, { AWS_REGION: 'cn-north-1' })
    expect(cmd).toContain(`AWS_REGION='cn-north-1'`)
    expect(cmd.indexOf('AWS_REGION')).toBeLessThan(cmd.indexOf('OPENCODE_SERVER_PASSWORD'))
  })
})

describe('config whitelist (batch 5 additions)', () => {
  it('includes plural agents/skills and the omo config file', async () => {
    const { CONFIG_SYNC_ENTRIES } = await import('../../src/core/remote-host')
    expect(CONFIG_SYNC_ENTRIES).toContain('agents')
    expect(CONFIG_SYNC_ENTRIES).toContain('skills')
    expect(CONFIG_SYNC_ENTRIES).toContain('oh-my-opencode-slim.json')
    // and the deliberate absence of plugin/ stays
    expect(CONFIG_SYNC_ENTRIES).not.toContain('plugin')
  })

  it('buildConfigEntries picks up the new entries when they exist', async () => {
    const { buildConfigEntries } = await import('../../src/core/remote-host')
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-cfg5-'))
    writeFileSync(join(dir, 'opencode.json'), '{}')
    mkdirSync(join(dir, 'agents'))
    mkdirSync(join(dir, 'skills'))
    writeFileSync(join(dir, 'oh-my-opencode-slim.json'), '{}')
    const entries = buildConfigEntries(dir)
    expect(entries).toContain('agents')
    expect(entries).toContain('skills')
    expect(entries).toContain('oh-my-opencode-slim.json')
    expect(entries).not.toContain('skill') // singular absent
  })
})
