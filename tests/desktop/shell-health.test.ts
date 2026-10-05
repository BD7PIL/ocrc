import { describe, it, expect } from 'vitest'
import { waitHealthy, launchBackoffMs, nextPhaseAfter, type ShellPhase } from '../../desktop/shell-health'

describe('waitHealthy', () => {
  it('resolves ready on first successful probe', async () => {
    const phases: ShellPhase[] = []
    const ok = await waitHealthy(async () => true, {}, (p) => phases.push(p))
    expect(ok).toBe(true)
    expect(phases.at(-1)?.state).toBe('ready')
  })

  it('keeps polling through failures until the budget, then failed', async () => {
    let calls = 0
    const ok = await waitHealthy(
      async () => { calls++; return false },
      { healthyTimeoutMs: 120, pollIntervalMs: 30 },
    )
    expect(ok).toBe(false)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('probe throws count as not-healthy, not crashes', async () => {
    const ok = await waitHealthy(
      async () => { throw new Error('ECONNREFUSED') },
      { healthyTimeoutMs: 80, pollIntervalMs: 20 },
    )
    expect(ok).toBe(false)
  })
})

describe('launchBackoffMs', () => {
  it('doubles 2s→4s→8s and caps at 30s', () => {
    expect(launchBackoffMs(1)).toBe(2000)
    expect(launchBackoffMs(2)).toBe(4000)
    expect(launchBackoffMs(3)).toBe(8000)
    expect(launchBackoffMs(10)).toBe(30_000)
  })
})

describe('nextPhaseAfter', () => {
  it('healthy → ready regardless of attempt', () => {
    expect(nextPhaseAfter(2, true).state).toBe('ready')
  })
  it('unhealthy with attempts left → launching next attempt', () => {
    const p = nextPhaseAfter(1, false)
    expect(p.state).toBe('launching')
    expect((p as any).attempt).toBe(2)
  })
  it('exhausted → failed with reason', () => {
    const p = nextPhaseAfter(3, false)
    expect(p.state).toBe('failed')
    expect((p as any).reason).toContain('3 launch attempts')
  })
})
