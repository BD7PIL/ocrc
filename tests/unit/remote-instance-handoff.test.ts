import { describe, expect, it } from 'vitest'
import { buildDesktopHandoff, PROXY_DEFAULTS, RECONNECT_DEFAULTS, type RemoteInstance } from '../../src/core/remote-instance.js'

/** 「一键 external」的可落地形态：把桌面版要的三项算好、验好、一次交出去。
 *  这里量的是「交出的是什么」——尤其是密码只在有档案时出现、在线状态如实说。 */

const base: RemoteInstance = {
  id: 'user@10.0.0.5',
  host: '10.0.0.5',
  user: 'user',
  port: 22,
  instancePort: 2610,
  localPort: 4610,
  uiPassword: 'pw-123',
  appVersion: '2.3.3',
  enabled: true,
  reconnect: RECONNECT_DEFAULTS.reconnect,
  restoreOnStart: RECONNECT_DEFAULTS.restoreOnStart,
  replayQueued: RECONNECT_DEFAULTS.replayQueued,
  proxy: PROXY_DEFAULTS,
}

describe('桌面版交接（buildDesktopHandoff）', () => {
  it('在线：给出地址/密码/端口，并说明可以直接打开', () => {
    const h = buildDesktopHandoff(base, { state: 'online', engine: { path: '/home/user/.ocrc/remote/engine/opencode', version: '2.0.27' } })
    expect(h.url).toBe('http://127.0.0.1:4610')
    expect(h.port).toBe(4610)
    expect(h.instancePort).toBe(2610)
    expect(h.uiPassword).toBe('pw-123')
    expect(h.running).toBe(true)
    expect(h.engine?.version).toBe('2.0.27')
    expect(h.lines.join('\n')).toContain('地址 : http://127.0.0.1:4610')
    expect(h.lines.join('\n')).toContain('密码 : pw-123')
    expect(h.lines.join('\n')).toContain('在线，可以直接打开')
  })

  it('不在线：如实说状态并指向 up（不许让人拿着地址去撞墙）', () => {
    const h = buildDesktopHandoff(base, { state: 'offline' })
    expect(h.running).toBe(false)
    expect(h.lines.join('\n')).toContain('offline')
    expect(h.lines.join('\n')).toContain('ocrc remote up user@10.0.0.5')
  })

  it('档案没有密码时不留空白行（指向 add），端口缺省来自档案而非猜', () => {
    const h = buildDesktopHandoff({ ...base, uiPassword: undefined, localPort: 4699 }, undefined)
    expect(h.uiPassword).toBeUndefined()
    expect(h.lines.join('\n')).toContain('档案里没有')
    expect(h.port).toBe(4699)
    expect(h.url).toBe('http://127.0.0.1:4699')
    expect(h.running).toBe(false)
  })
})
