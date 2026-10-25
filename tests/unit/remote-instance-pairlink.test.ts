import { describe, expect, it } from 'vitest'
import { buildPairLinkCommand, describePairLink, parsePairLink } from '../../src/core/remote-instance.js'

/**
 * The pairing path leans on openchamber for identity: the peer's own CLI mints a
 * single-use link, the desktop app redeems it for a per-device revocable token.
 * Our part is only the command and reading the link back out of a boxed report.
 */

/** A link shaped like `connect-url` prints, built the way the peer builds it. */
const linkFor = (payload: Record<string, unknown>) =>
  `openchamber://connect?v=2&p=${Buffer.from(JSON.stringify({ v: 2, ...payload }), 'utf8').toString('base64url')}`

describe('buildPairLinkCommand', () => {
  it('asks the peer CLI for a link pointed at the forward the control side holds', () => {
    const cmd = buildPairLinkCommand({
      appVersion: '2.3.3', instancePort: 2610, serverUrl: 'http://127.0.0.1:4610', label: 'EL7 box',
    })
    expect(cmd).toContain('$HOME/.ocrc/remote/runtime/node-v')
    expect(cmd).toContain('lib/node_modules/@openchamber/web/bin/cli.js')
    expect(cmd).toContain('connect-url --port 2610')
    expect(cmd).toContain("--server 'http://127.0.0.1:4610'")
    expect(cmd).toContain("--name 'EL7 box'")
    // loopback（默认）不带 --lan：对端不加 LAN 候选
    expect(cmd).not.toContain('--lan')
  })

  it('bind=lan 追加 --lan：LAN 候选由对端自己生成，--server 仍是控制端转发', () => {
    const cmd = buildPairLinkCommand({
      appVersion: '2.3.3', instancePort: 2610, serverUrl: 'http://127.0.0.1:4610', label: 'EL7 box', lan: true,
    })
    expect(cmd).toContain('connect-url --port 2610 --server')
    expect(cmd).toContain('--lan')
    expect(cmd).toContain("--server 'http://127.0.0.1:4610'")
  })

  it('quotes a label that would otherwise break the remote shell', () => {
    const cmd = buildPairLinkCommand({
      appVersion: '2.3.3', instancePort: 2610, serverUrl: 'http://127.0.0.1:4610', label: "it's here",
    })
    expect(cmd).toContain(`--name 'it'\\''s here'`)
  })
})

describe('parsePairLink', () => {
  it('pulls the link out of the boxed report connect-url prints', () => {
    const link = linkFor({ pairingId: 'pair_1', secret: 's', label: 'ocrc-demo' })
    const output = `┌\n│  Server URL: http://127.0.0.1:4610\n│  [LOOPBACK_URL]\n└\n${link}\n\npairing link generated\n`
    expect(parsePairLink(output)).toBe(link)
  })

  it('returns undefined when the peer printed no link', () => {
    expect(parsePairLink('error: no such port')).toBeUndefined()
  })
})

describe('describePairLink', () => {
  it('reports label, expiry and route count without the secret', () => {
    const link = linkFor({
      pairingId: 'pair_1', secret: 'super-secret', label: 'ocrc-demo',
      expiresAt: '2026-10-17T14:11:33.069Z',
      candidates: [{ type: 'lan', url: 'http://127.0.0.1:4610', priority: 10 }],
    })
    const info = describePairLink(link)
    expect(info).toEqual({ label: 'ocrc-demo', expiresAt: '2026-10-17T14:11:33.069Z', candidates: 1 })
    expect(JSON.stringify(info)).not.toContain('super-secret')
  })

  it('survives a payload it cannot read', () => {
    expect(describePairLink('openchamber://connect?v=2&p=not-base64-json')).toBeUndefined()
  })
})
