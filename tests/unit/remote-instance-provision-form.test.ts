import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPeerPortProbeCommand, parsePortProbe, provisionActions } from '../../src/core/remote-instance.js'
import { createRemoteInstancesStore } from '../../src/core/remote-instances.js'

/**
 * A3 — the form is the provisioning input, and the three fields it adds each
 * answer a question the peer's reality decides:
 *   · 装机方式 (`provision`): 推包 writes bytes, 复用档 writes none;
 *   · 出口策略 (`egress`): auto/relay/direct, where auto is decided by a probe;
 *   · 端口: the local port is probed free, the peer's port gets the one honest
 *     answer we can produce (`unknown` when neither our runtime nor ss can tell).
 * All three used to be unsettable or unpersisted — a form field that does not
 * survive `add` is a setting the user thinks they made.
 */

describe('provisionActions', () => {
  it('push mode describes the bytes it would write', () => {
    const lines = provisionActions({ provision: 'push', targetAppVersion: '2.3.3', engineOk: false })
    expect(lines.join('\n')).toContain('推送运行时 node')
    expect(lines.join('\n')).toContain('推送 OpenChamber 2.3.3')
    expect(lines.join('\n')).toContain('OpenCode 2.0.27')
  })

  it('push mode says when nothing would be written', () => {
    const lines = provisionActions({ provision: 'push', runtime: 'v24.22.0', app: '2.3.3', targetAppVersion: '2.3.3', engineOk: true })
    expect(lines).toEqual(['运行时与 OpenChamber 都在位，推送会跳过'])
  })

  it('reuse mode promises zero bytes and lists what is missing', () => {
    const lines = provisionActions({ provision: 'reuse', targetAppVersion: '2.3.3', engineOk: false, engineError: '只有 v1' })
    expect(lines[0]).toContain('不推送任何字节')
    expect(lines.filter((l) => l.startsWith('FAIL'))).toHaveLength(3) // runtime + app + engine
    expect(lines.join('\n')).toContain('把安装方式改回「推送安装」')
    expect(lines.join('\n')).not.toContain('推送 OpenChamber')
  })

  it('reuse mode passes when the peer already has everything', () => {
    const lines = provisionActions({ provision: 'reuse', runtime: 'v24.22.0', app: '2.3.3', targetAppVersion: '2.3.3', engineOk: true })
    expect(lines.some((l) => l.includes('检查通过'))).toBe(true)
    expect(lines.some((l) => l.startsWith('FAIL'))).toBe(false)
  })

  it('an app of the wrong version is a failure in reuse mode, not a push', () => {
    const lines = provisionActions({ provision: 'reuse', runtime: 'v24.22.0', app: '2.2.0', targetAppVersion: '2.3.3', engineOk: true })
    expect(lines.join('\n')).toContain('2.2.0 ≠ 2.3.3')
    expect(lines.some((l) => l.startsWith('FAIL'))).toBe(true)
  })
})

describe('peer port probe', () => {
  it('prefers the runtime we push, then ss/netstat, and admits when it cannot tell', () => {
    const cmd = buildPeerPortProbeCommand('2.3.3', 2610)
    expect(cmd.indexOf('-x ')).toBeLessThan(cmd.indexOf('command -v ss'))
    expect(cmd.indexOf('command -v ss')).toBeLessThan(cmd.indexOf('command -v netstat'))
    expect(cmd).toContain('echo unknown')
    // The old probe answered "closed" whenever the runtime was absent — a peer
    // that had never been provisioned was told its port was free.
    expect(cmd).toContain('[:.]2610 ')
  })

  it('parses open/closed and treats everything else as unknown', () => {
    expect(parsePortProbe('open\n')).toBe('open')
    expect(parsePortProbe('closed\n')).toBe('closed')
    expect(parsePortProbe('')).toBe('unknown')
    expect(parsePortProbe('MISSING')).toBe('unknown')
    expect(parsePortProbe('grep: not found\nopen')).toBe('open')
  })
})

describe('the form fields survive the store', () => {
  it('keeps provision and egress on a fresh record (they used to be dropped)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-a3-'))
    try {
      const path = join(dir, 'remote-instances.json')
      const store = createRemoteInstancesStore(path, { flushOnExit: false })
      const saved = store.upsert({ host: 'peer', user: 'demo', provision: 'reuse', egress: 'direct' })
      expect(saved.provision).toBe('reuse')
      expect(saved.egress).toBe('direct')
      store.flush()
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')).instances[0]
      expect(onDisk.provision).toBe('reuse')
      expect(onDisk.egress).toBe('direct')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes the closed-set fields: an unrecognized value is "not set", never a surprise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-a3-'))
    try {
      const store = createRemoteInstancesStore(join(dir, 'remote-instances.json'), { flushOnExit: false })
      const saved = store.upsert({ host: 'peer', provision: 'whatever' as never, egress: 'sideways' as never })
      // `undefined` is what the arg builders read as 推包 / auto — the defaults,
      // not a value nobody implemented.
      expect(saved.provision).toBeUndefined()
      expect(saved.egress).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
