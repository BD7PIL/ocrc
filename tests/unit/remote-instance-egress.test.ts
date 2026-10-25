import { describe, expect, it } from 'vitest'
import {
  CURL_EXIT_MAP, EGRESS_PROBE_URL, WGET_EXIT_MAP,
  buildEgressProbeCommand, buildInstanceProxyProbeCommand, egressProbeFromAttempts, parseEgressProbe,
  parseInstanceProxyProbe, relayHostFor, relayProxyUrl, resolveEgressPolicy,
} from '../../src/core/remote-instance.js'

/**
 * A peer with its own internet must not be routed through the control side: the
 * detour costs latency and makes the control machine a single point of failure
 * for a peer that was never offline. `auto` is the default policy — probe the
 * peer, relay only when it cannot get out itself.
 */

describe('resolveEgressPolicy', () => {
  it('defaults to auto and relays when the peer has no egress', () => {
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'none' })).toEqual({ relay: true, reason: '远程机器出不了网' })
  })

  it('keeps a peer with its own egress direct', () => {
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'direct' })).toEqual({ relay: false, reason: '远程机器自己能出网' })
  })

  it('still relays when the peer has a route but no resolver', () => {
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'dns-only' }).relay).toBe(true)
  })

  it('is conservative when the probe could not run', () => {
    // Silently losing egress is worse than an unnecessary detour.
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'unknown' }).relay).toBe(true)
    expect(resolveEgressPolicy({ relayAllowed: true }).relay).toBe(true)
  })

  it('honours explicit choices over the probe', () => {
    expect(resolveEgressPolicy({ mode: 'direct', relayAllowed: true, probe: 'none' }).relay).toBe(false)
    expect(resolveEgressPolicy({ mode: 'relay', relayAllowed: true, probe: 'direct' }).relay).toBe(true)
  })

  it('relay-off beats everything', () => {
    expect(resolveEgressPolicy({ mode: 'relay', relayAllowed: false, probe: 'none' }).relay).toBe(false)
  })
})

describe('parseEgressProbe', () => {
  it('reads the probe verdict, tolerating trailing noise', () => {
    expect(parseEgressProbe('direct\n')).toBe('direct')
    expect(parseEgressProbe('warning: something\nnone')).toBe('none')
    expect(parseEgressProbe('dns-only')).toBe('dns-only')
  })

  it('treats anything else as unknown', () => {
    expect(parseEgressProbe('')).toBe('unknown')
    expect(parseEgressProbe('Error: spawn failed')).toBe('unknown')
  })
})

describe('buildEgressProbeCommand', () => {
  it('runs on the pushed runtime and is bounded by one deadline', () => {
    const cmd = buildEgressProbeCommand({ appVersion: '2.3.3' })
    expect(cmd).toContain('$HOME/.ocrc/remote/runtime/node-v')
    expect(cmd).toContain('models.dev')
    expect(cmd).toContain('setTimeout')
    expect(cmd).toContain('6000') // node-fallback deadline, so a host that cannot be measured answers instead of hanging
  })

  it('accepts a different host and budget', () => {
    const cmd = buildEgressProbeCommand({ appVersion: '2.3.3', host: 'api.deepseek.com', timeoutMs: 1500, deadlineMs: 2500 })
    expect(cmd).toContain('api.deepseek.com')
    expect(cmd).toContain('1500')
    expect(cmd).toContain('2500')
  })
})

/**
 * The relay env is decided when the instance **starts**, so a peer whose
 * connectivity changes keeps running with the old decision. That produced a real
 * "online but can't work" state (EL7 with its internet cut: policy flipped to
 * relay, running instance had zero proxy variables, `up` still reported online).
 * `up` now compares the running instance's env against the decision before
 * reusing it — which needs a way to read that env off the peer.
 */
describe('instance egress probe (what the running instance actually carries)', () => {
  it('reports the relay URL the instance was started with', () => {
    expect(parseInstanceProxyProbe('PROXY=http://127.0.0.1:2711\n')).toBe('http://127.0.0.1:2711')
  })

  it('reports "none" when the instance carries no proxy at all', () => {
    expect(parseInstanceProxyProbe('PROXY=none\n')).toBe('none')
  })

  it('reports "unknown" when no serve process was found or the output is junk', () => {
    expect(parseInstanceProxyProbe('PROXY=unknown\n')).toBe('unknown')
    expect(parseInstanceProxyProbe('')).toBe('unknown')
    expect(parseInstanceProxyProbe('bash: /proc: Permission denied\n')).toBe('unknown')
  })

  it('the probe matches on the instance port, as a shell variable, and prefers our own tree', () => {
    const cmd = buildInstanceProxyProbeCommand('2.3.3', 2610)
    // A `sh -c` script carries its own text in argv: a literal `--port 2610`
    // would match the probing shell and report the wrong process.
    expect(cmd).toContain('PORT=2610')
    expect(cmd).toContain('--port $PORT')
    expect(cmd).not.toContain('--port 2610')
    // The listener is openchamber's own child (`server/index.js --port 2610`),
    // not our `serve --hostname …` line — matching on the command shape found
    // nothing on a live peer, so the port is the discriminator.
    expect(cmd).not.toContain('serve --hostname')
    expect(cmd).toContain('.ocrc/remote')
    expect(cmd).toContain('HTTPS_PROXY')
  })

  it('relayProxyUrl is the single source of the injected URL', () => {
    expect(relayProxyUrl(2711)).toBe('http://127.0.0.1:2711')
  })
})

/**
 * The probe's verdict decides whether a peer is routed through us, so a false
 * "no egress" is expensive: it detours a peer that could get out itself (measured
 * on Ubuntu — our probe said none while a plain `curl` returned 200). Two causes,
 * both now pinned here:
 *   · `dns.lookup` without `{all:true}` could outlive the whole budget, and the
 *     deadline used to answer **none** — turning "could not measure" into a claim;
 *   · only one resolved address was tried, so a broken IPv6 route decided alone.
 */
describe('egress probe robustness', () => {
  const cmd = () => buildEgressProbeCommand({ appVersion: '2.3.3' })

  it('resolves every address and prefers IPv4', () => {
    const script = cmd()
    expect(script).toContain('{all:true}')
    expect(script).toContain('x.family-y.family')
  })

  it('reports "unknown" when the budget runs out, not "no egress"', () => {
    const script = cmd()
    expect(script).toContain('unknown')
    expect(script).not.toContain("done('none')")
    // `none` may only come from a failed connect to a literal IP.
    expect(script).toContain("done(viaDns?\"dns-only\":\"none\")")
  })

  it('races a dead resolver against a short timer instead of waiting on it', () => {
    const script = cmd()
    expect(script).toContain('setTimeout(fallback,1500)')
    expect(script).toContain('1.1.1.1')
  })
})

/**
 * Probe v2 — the verdict must be about the **consumer's** path, and the two ways
 * the first implementation got it wrong are pinned here:
 *   · it probed the install channel (npmjs) instead of what the instance needs
 *     (models.dev — the provider catalogue);
 *   · it tried one address family, so a peer with a v6 default route and a broken
 *     v6 egress was judged offline (measured: `curl -6` timed out while `curl -4`
 *     returned 200 in 3.3 s).
 */
describe('egress probe v2', () => {
  const cmd = () => buildEgressProbeCommand({ appVersion: '2.3.3' })

  it('asks the question the instance actually needs answered', () => {
    expect(EGRESS_PROBE_URL).toBe('https://models.dev/api.json')
    expect(cmd()).toContain('https://models.dev/api.json')
  })

  it('prefers IPv4 and only then tries IPv6', () => {
    const script = cmd()
    const v4 = script.indexOf('curl -4')
    const v6 = script.indexOf('curl -6')
    expect(v4).toBeGreaterThan(-1)
    expect(v6).toBeGreaterThan(v4)
    // v6 is attempted only when v4 failed, and never after a killed attempt.
    expect(script).toContain('if [ "$r4" != 124 ]; then')
  })

  it('lets the peer use its own proxy (curl/wget honour the env; nothing clears it)', () => {
    const script = cmd()
    expect(script).not.toContain('--noproxy')
    expect(script).not.toMatch(/unset .*PROXY/)
    expect(script).not.toContain('http_proxy=')
  })

  it('caps a hanging resolver from outside curl, then falls back to the node probe', () => {
    const script = cmd()
    expect(script).toContain('timeout 5')
    // A killed attempt is not a verdict: it falls through to the node probe, which
    // bounds the resolver itself.
    expect(script.indexOf('timeout 5')).toBeLessThan(script.indexOf('node -e'))
  })

  it('keeps the fallback chain in order: curl → wget → pushed node', () => {
    const script = cmd()
    expect(script.indexOf('command -v curl')).toBeLessThan(script.indexOf('command -v wget'))
    expect(script.indexOf('command -v wget')).toBeLessThan(script.indexOf('node -e'))
  })

  it('maps exit codes without guessing', () => {
    // curl: 0 = any response counts (a 401 from models.dev still proves a route).
    expect(egressProbeFromAttempts([0, 0], CURL_EXIT_MAP)).toBe('direct')
    expect(egressProbeFromAttempts([0, 28], CURL_EXIT_MAP)).toBe('direct')
    expect(egressProbeFromAttempts([7, 28], CURL_EXIT_MAP)).toBe('none')
    expect(egressProbeFromAttempts([6, 6], CURL_EXIT_MAP)).toBe('dns-only')
    expect(egressProbeFromAttempts([6, 7], CURL_EXIT_MAP)).toBe('none')
    expect(egressProbeFromAttempts([5, 5], CURL_EXIT_MAP)).toBe('unknown') // proxy error: do not guess
    expect(egressProbeFromAttempts([35, 35], CURL_EXIT_MAP)).toBe('unknown') // TLS: do not guess
    // wget: 8 = the server answered with an error status, which still proves a route.
    expect(egressProbeFromAttempts([8, 4], WGET_EXIT_MAP)).toBe('direct')
    expect(egressProbeFromAttempts([4, 4], WGET_EXIT_MAP)).toBe('none')
  })
})

describe('relayHostFor（0.11.1 条件注入判据）', () => {
  it('只有「探测确认出不了网且没有 R9 代理」才注入 off', () => {
    expect(relayHostFor('none', false)).toBe('off')
    // 拿不准的一律不注入：在线对端被 off = relay 全断（代价不对称）
    expect(relayHostFor('none', true)).toBeUndefined()
    expect(relayHostFor('direct', false)).toBeUndefined()
    expect(relayHostFor('dns-only', false)).toBeUndefined()
    expect(relayHostFor('unknown', false)).toBeUndefined()
    expect(relayHostFor(undefined, false)).toBeUndefined()
  })
})
