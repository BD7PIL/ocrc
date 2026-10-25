import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFirewallPortCommand, buildFirewallProbeCommand, isLanAddress, parseFirewallProbe,
} from '../../src/core/remote-instance.js'

/**
 * 0.11.2 LAN 直连成套：防火墙探测闭集、开关命令形状、地址校验，以及桥端的
 * 三态收口（可达 / needs-sudo / 修不动就不给链接）。两条铁律各有一条回归钉子：
 *   · 地址只来自显式点名——0.11.1 的「hostname -I 第一段」猜测路径不许复活；
 *   · sudo 密码只走 stdin（sshRun 带 -S），不进 argv、不落盘、不回显。
 */

// 桥端的 ssh 缝：sshRun/sshRunWithStdin 按命令内容回罐头输出，其余保持原样。
// （forward 层不 mock——被测路径在起转发之前就该收口，真的去连 ssh 会直接把测试打红。)
const sshScript = vi.hoisted(() => ({
  reply: null as null | ((command: string) => { code: number | null; stdout: string; stderr: string }),
}))
const stdinCalls = vi.hoisted(() => [] as Array<{ command: string; input: string }>)
vi.mock('../../src/core/remote-instance-push.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/remote-instance-push.js')>()
  return {
    ...actual,
    sshRun: async (_target: unknown, command: string) => {
      if (!sshScript.reply) throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      return sshScript.reply(command)
    },
    sshRunWithStdin: async (_target: unknown, command: string, input: string | Buffer) => {
      stdinCalls.push({ command, input: String(input) })
      if (!sshScript.reply) throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      return sshScript.reply(command)
    },
  }
})

const { createRemoteInstanceManager } = await import('../../src/core/remote-instance-bridge.js')
const { createRemoteInstancesStore } = await import('../../src/core/remote-instances.js')

const firewallBlock = (kv: Record<string, string>) =>
  `FIREWALL_BEGIN\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}\nFIREWALL_END\n`

describe('isLanAddress', () => {
  it('accepts IPv4 and hostnames', () => {
    expect(isLanAddress('192.168.26.101')).toBe(true)
    expect(isLanAddress('el7.lan')).toBe(true)
    expect(isLanAddress('a.b-c_d.example')).toBe(true)
  })

  it('rejects shell metacharacters, whitespace and empty input', () => {
    expect(isLanAddress('')).toBe(false)
    expect(isLanAddress('192.168.1.5; rm -rf /')).toBe(false)
    expect(isLanAddress('a b')).toBe(false)
    expect(isLanAddress("$(hostname)'")).toBe(false)
    expect(isLanAddress('-lead')).toBe(false)
    expect(isLanAddress('trail.')).toBe(false)
    expect(isLanAddress('x'.repeat(254))).toBe(false)
  })
})

describe('buildFirewallProbeCommand', () => {
  it('checks both backends and the port, with a passwordless-sudo attempt', () => {
    const cmd = buildFirewallProbeCommand(2610)
    expect(cmd).toContain('command -v firewall-cmd')
    expect(cmd).toContain('command -v ufw')
    expect(cmd).toContain('sudo -n true')
    expect(cmd).toContain('--query-port=2610/tcp')
    expect(cmd).toContain('FIREWALL_BEGIN')
    expect(cmd).toContain('FIREWALL_END')
  })
})

describe('parseFirewallProbe', () => {
  it('reads firewalld verdict and sudo mode', () => {
    expect(parseFirewallProbe(firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'nopasswd', FW_STATE: 'running', PORT: 'open', UFW: 'inactive', UFW_PORT: 'closed' })))
      .toEqual({ backend: 'firewalld', portOpen: 'open', sudo: 'nopasswd' })
    expect(parseFirewallProbe(firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'closed' })))
      .toEqual({ backend: 'firewalld', portOpen: 'closed', sudo: 'needed' })
  })

  it('polkit denial is honest unknown, not closed', () => {
    // EL7 实测：demo 用户 `firewall-cmd --state` → "Authorization failed."
    expect(parseFirewallProbe(firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed' })))
      .toEqual({ backend: 'firewalld', portOpen: 'unknown', sudo: 'needed' })
  })

  it('active ufw owns the verdict; installed-but-inactive ufw filters nothing', () => {
    expect(parseFirewallProbe(firewallBlock({ HAS_UFW: '1', UFW: 'active', UFW_PORT: 'open', SUDO: 'nopasswd' })))
      .toEqual({ backend: 'ufw', portOpen: 'open', sudo: 'nopasswd' })
    expect(parseFirewallProbe(firewallBlock({ HAS_UFW: '1', UFW: 'inactive', UFW_PORT: 'closed', SUDO: 'needed' })))
      .toEqual({ backend: 'none', portOpen: 'unknown', sudo: 'needed' })
  })

  it('no firewall tooling and garbage output both degrade to none/unknown', () => {
    expect(parseFirewallProbe(firewallBlock({ SUDO: 'needed' })))
      .toEqual({ backend: 'none', portOpen: 'unknown', sudo: 'needed' })
    expect(parseFirewallProbe('') as { backend: string }).toEqual({ backend: 'none', portOpen: 'unknown', sudo: 'needed' })
  })
})

describe('buildFirewallPortCommand', () => {
  it('firewalld: permanent change + reload, FW_DONE as the success marker', () => {
    const open = buildFirewallPortCommand('firewalld', 2610, true, false)
    expect(open).toContain('sudo -n firewall-cmd --permanent --add-port=2610/tcp')
    // reload 走同一条命令里的第二个 sudo（凭据已在缓存窗口内，免密）。
    expect(open).toContain('&& sudo firewall-cmd --reload')
    expect(open.endsWith('&& echo FW_DONE')).toBe(true)
    const close = buildFirewallPortCommand('firewalld', 2610, false, false)
    expect(close).toContain('--remove-port=2610/tcp')
    expect(close).not.toContain('add-port')
  })

  it('ufw: allow / delete allow', () => {
    expect(buildFirewallPortCommand('ufw', 2610, true, false)).toContain('sudo -n ufw allow 2610/tcp')
    expect(buildFirewallPortCommand('ufw', 2610, false, false)).toContain('sudo -n ufw delete allow 2610/tcp')
  })

  it('password mode reads sudo credentials from stdin (-S), not argv', () => {
    const cmd = buildFirewallPortCommand('firewalld', 2610, true, true)
    expect(cmd).toContain("sudo -S -p '' firewall-cmd")
    expect(cmd).not.toContain('-n')
    expect(cmd).not.toContain('sudo -n')
    expect(cmd).toContain('&& sudo firewall-cmd --reload')
  })
})

describe('pairLink address flow (bridge)', () => {
  function tempManager() {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-lan-'))
    const store = createRemoteInstancesStore(join(dir, 'remote-instances.json'), { flushOnExit: false })
    const m = createRemoteInstanceManager({ store })
    return { m, store, cleanup: () => { m.dispose(); rmSync(dir, { recursive: true, force: true }) } }
  }

  afterEach(() => {
    sshScript.reply = null
    stdinCalls.length = 0
  })

  it('never picks an address on its own: address without bind=lan is refused', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo' }) // bind 未设 = loopback
      const r = await m.pairLink('demo@peer', { address: '192.168.26.101' })
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/访问范围/)
      expect(r.needsSudo).toBeUndefined()
    } finally { cleanup() }
  })

  it('refuses an address that cannot be spoken safely', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', bind: 'lan' })
      const r = await m.pairLink('demo@peer', { address: '192.168.1.5; rm -rf /' })
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/地址不合法/)
    } finally { cleanup() }
  })

  it('firewalld blocking without passwordless sudo → needsSudo, password to stdin reopens', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', bind: 'lan', instancePort: 26100 })
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'closed' }), stderr: '' }
        }
        if (command.includes('--add-port') || command.includes('FW_DONE')) return { code: 0, stdout: 'FW_DONE\n', stderr: '' }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const first = await m.pairLink('demo@peer', { address: '127.0.0.2' })
      expect(first.ok).toBe(false)
      expect(first.needsSudo).toBe(true)
      expect(first.backend).toBe('firewalld')
      expect(stdinCalls).toHaveLength(0) // 没有密码就不该碰 sudo
      // 面板/CLI 收到密码后重试：密码走 stdin（-S），绝不进 argv
      const second = await m.pairLink('demo@peer', { address: '127.0.0.2', sudoPassword: 'hunter2' })
      expect(second.ok).toBe(false) // 放行成功了，但 127.0.0.2 上没有实例在听——仍不给链接
      expect(second.needsSudo).toBeUndefined()
      expect(second.detail).toMatch(/仍连不上/)
      expect(stdinCalls).toHaveLength(1)
      expect(stdinCalls[0]!.input).toBe('hunter2\n')
      expect(stdinCalls[0]!.command).toContain("sudo -S -p ''")
      expect(stdinCalls[0]!.command).toContain('--add-port=26100/tcp')
      expect(JSON.stringify(second)).not.toContain('hunter2')
    } finally { cleanup() }
  })

  it('polkit-blinded probe (port unknown) still attempts the password-gated open — it is idempotent', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', bind: 'lan', instancePort: 26100 })
      // EL7 实测：demo 用户连 firewall-cmd --query-port 都被 polkit 拒 → PORT 缺失 = unknown。
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed' }), stderr: '' }
        }
        if (command.includes('--add-port') || command.includes('FW_DONE')) return { code: 0, stdout: 'FW_DONE\n', stderr: '' }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const first = await m.pairLink('demo@peer', { address: '127.0.0.2' })
      expect(first.needsSudo).toBe(true) // unknown 不是拒绝开火的理由，只是要先要密码
      const second = await m.pairLink('demo@peer', { address: '127.0.0.2', sudoPassword: 'hunter2' })
      expect(second.ok).toBe(false)
      expect(second.detail).toMatch(/仍连不上/)
      expect(stdinCalls).toHaveLength(1)
      expect(stdinCalls[0]!.command).toContain('--add-port=26100/tcp')
    } finally { cleanup() }
  })

  it('firewall already open but port unreachable → closed with the 0.0.0.0 hint, no sudo asked', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', bind: 'lan', instancePort: 26100 })
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'open' }), stderr: '' }
        }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const r = await m.pairLink('demo@peer', { address: '127.0.0.2' })
      expect(r.ok).toBe(false)
      expect(r.needsSudo).toBeUndefined()
      expect(r.detail).toMatch(/0\.0\.0\.0|重启/)
      expect(stdinCalls).toHaveLength(0)
    } finally { cleanup() }
  })

  it('no firewall backend → closed and honest, not a fake link', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', bind: 'lan', instancePort: 26100 })
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ SUDO: 'needed' }), stderr: '' }
        }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const r = await m.pairLink('demo@peer', { address: '127.0.0.2' })
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/手工放行|没有识别到/)
    } finally { cleanup() }
  })
})

describe('lanInfo (bridge)', () => {
  it('lists every address from the peer (no first-segment pick) with per-address reachability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-laninfo-'))
    const store = createRemoteInstancesStore(join(dir, 'remote-instances.json'), { flushOnExit: false })
    store.upsert({ host: 'peer', user: 'demo', bind: 'lan', instancePort: 26100 })
    // 127.0.0.1:26100 真有东西在听；127.0.0.2 立刻 refused——一真一假，两行都得在。
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(26100, '127.0.0.1', resolve))
    sshScript.reply = (command) => {
      if (command.includes('FIREWALL_BEGIN')) {
        return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'closed' }), stderr: '' }
      }
      if (command.includes('IPS=')) return { code: 0, stdout: 'UNAME=Linux\nIPS=127.0.0.1 127.0.0.2\n', stderr: '' }
      throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
    }
    try {
      const m = createRemoteInstanceManager({ store })
      const r = await m.lanInfo('demo@peer')
      m.dispose()
      expect(r.ok).toBe(true)
      expect(r.addresses).toEqual(['127.0.0.1', '127.0.0.2'])
      expect(r.reachable).toEqual({ '127.0.0.1': true, '127.0.0.2': false })
      expect(r.port).toBe(26100)
      expect(r.bind).toBe('lan')
      expect(r.firewall).toEqual({ backend: 'firewalld', portOpen: 'closed', sudo: 'needed' })
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('closeLanPort (bridge, 0.11.3 bind→loopback 收尾)', () => {
  function tempManager() {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-lanclose-'))
    const store = createRemoteInstancesStore(join(dir, 'remote-instances.json'), { flushOnExit: false })
    const m = createRemoteInstanceManager({ store })
    return { m, store, cleanup: () => { m.dispose(); rmSync(dir, { recursive: true, force: true }) } }
  }

  afterEach(() => {
    sshScript.reply = null
    stdinCalls.length = 0
  })

  it('opens→removes the rule with the password on stdin and verifies by re-probe', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', instancePort: 26100 })
      let probes = 0
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          probes += 1
          // 第一次探测：规则还在；收回后的复测：没了。
          const block = probes === 1
            ? firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'open' })
            : firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'closed' })
          return { code: 0, stdout: block, stderr: '' }
        }
        if (command.includes('--remove-port') || command.includes('FW_DONE')) return { code: 0, stdout: 'FW_DONE\n', stderr: '' }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const r = await m.closeLanPort('demo@peer', { sudoPassword: 'hunter2' })
      expect(r.ok).toBe(true)
      expect(r.changed).toBe(true)
      expect(r.detail).toMatch(/已收回 26100/)
      expect(stdinCalls).toHaveLength(1)
      expect(stdinCalls[0]!.input).toBe('hunter2\n')
      expect(stdinCalls[0]!.command).toContain('--remove-port=26100/tcp')
      expect(JSON.stringify(r)).not.toContain('hunter2')
    } finally { cleanup() }
  })

  it('nothing to do when the rule is already gone; honest failure when the command errors', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', instancePort: 26100 })
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'nopasswd', PORT: 'closed' }), stderr: '' }
        }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const idle = await m.closeLanPort('demo@peer')
      expect(idle.ok).toBe(true)
      expect(idle.changed).toBeUndefined()
      expect(idle.detail).toMatch(/无事可做/)
      expect(stdinCalls).toHaveLength(0)

      // 规则在、免密 sudo 在，但 remove 命令本身失败（如 NOT_ENABLED）→ ok:false 带原文
      let flip = false
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'nopasswd', PORT: 'open' }), stderr: '' }
        }
        if (command.includes('--remove-port')) {
          flip = true
          return { code: 1, stdout: '', stderr: 'Error: NOT_ENABLED\n' }
        }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const failed = await m.closeLanPort('demo@peer')
      expect(failed.ok).toBe(false)
      expect(failed.detail).toMatch(/NOT_ENABLED/)
      expect(flip).toBe(true)
    } finally { cleanup() }
  })

  it('asks for sudo first (needsSudo handshake), same as pairing', async () => {
    const { m, store, cleanup } = tempManager()
    try {
      store.upsert({ host: 'peer', user: 'demo', instancePort: 26100 })
      sshScript.reply = (command) => {
        if (command.includes('FIREWALL_BEGIN')) {
          return { code: 0, stdout: firewallBlock({ HAS_FIREWALLD: '1', SUDO: 'needed', PORT: 'open' }), stderr: '' }
        }
        throw new Error(`unexpected ssh: ${command.slice(0, 100)}`)
      }
      const r = await m.closeLanPort('demo@peer')
      expect(r.ok).toBe(false)
      expect(r.needsSudo).toBe(true)
      expect(r.backend).toBe('firewalld')
      expect(stdinCalls).toHaveLength(0)
    } finally { cleanup() }
  })
})
