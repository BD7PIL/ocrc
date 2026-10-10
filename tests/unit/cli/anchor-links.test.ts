import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// printAnchorLinks — the `ocrc start` tail: two permanent `#token=` anchor
// links (localhost + LAN) + hints. Home is pointed at a scratch dir so the
// test never reads/writes the real ~/.ocrc/token.
describe('printAnchorLinks (ocrc start output)', () => {
  let scratchHome = ''
  let prevHome = ''
  let prevOcrcHome = ''
  let prevWebHost = ''
  let out = ''

  beforeEach(() => {
    scratchHome = mkdtempSync(join(tmpdir(), 'ocrc-anchor-'))
    mkdirSync(join(scratchHome, '.ocrc'), { recursive: true })
    writeFileSync(join(scratchHome, '.ocrc', 'token'), 'anchor-token-0123456789abcdef\n')
    prevHome = process.env.HOME ?? ''
    prevOcrcHome = process.env.OCRC_HOME ?? ''
    prevWebHost = process.env.OCRC_WEB_HOST ?? ''
    process.env.HOME = scratchHome
    process.env.OCRC_HOME = join(scratchHome, '.ocrc')
    delete process.env.OCRC_WEB_HOST
    out = ''
    // minimal console.log capture
    const orig = console.log
    console.log = (...args: unknown[]) => { out += args.map(String).join(' ') + '\n'; void orig }
    ;(console as any).__restore = () => { console.log = orig }
  })

  afterEach(() => {
    ;(console as any).__restore?.()
    process.env.HOME = prevHome
    if (prevOcrcHome) process.env.OCRC_HOME = prevOcrcHome; else delete process.env.OCRC_HOME
    if (prevWebHost) process.env.OCRC_WEB_HOST = prevWebHost; else delete process.env.OCRC_WEB_HOST
    rmSync(scratchHome, { recursive: true, force: true })
  })

  it('prints localhost + LAN anchor links carrying the token file value', async () => {
    const { printAnchorLinks } = await import('../../../src/cli/service')
    await printAnchorLinks('4199')
    expect(out).toContain('#token=anchor-token-0123456789abcdef')
    expect(out).toContain('http://localhost:4199/#token=')
    expect(out).toContain('ocrc pair --reset')
  })

  it('no LAN variant when the bind is explicitly loopback', async () => {
    process.env.OCRC_WEB_HOST = '127.0.0.1'
    const { printAnchorLinks } = await import('../../../src/cli/service')
    await printAnchorLinks('4199')
    expect(out).toContain('http://localhost:4199/#token=')
    expect(out).not.toContain('http://192.168.')
  })
})
