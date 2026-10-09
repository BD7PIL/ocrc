// P3 — the world.run approval gate. Fail-closed everywhere: no session to ask, no
// answer in time, a decision for an unknown request — all deny. `always` is
// remembered per (run, command) so a loop asks once.
import { describe, it, expect, vi } from 'vitest'
import { createWorkflowApproval } from '../../src/core/workflow/approval'
import { createCardBus } from '../../src/core/card-bus'

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

function make(opts: { timeoutMs?: number } = {}) {
  const cardBus = createCardBus()
  const cards: any[] = []
  cardBus.subscribeAll((c) => cards.push(c))
  const approval = createWorkflowApproval({ cardBus, timeoutMs: opts.timeoutMs ?? 1000 })
  return { approval, cards }
}

const REQ = { runId: 'dwfrun-1', sessionId: 'ses_parent', cmd: 'npm', args: ['test'] }

describe('world.run approval', () => {
  it('publishes an approval card and waits for the decision', async () => {
    const { approval, cards } = make()
    const pending = approval.request(REQ)
    await new Promise((r) => setTimeout(r, 5))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'approval', sessionId: 'ses_parent' })
    expect(cards[0].title).toContain('npm test')
    expect(cards[0].args).toMatchObject({ runId: 'dwfrun-1', command: 'npm', argv: ['test'] })

    const requestId = cards[0].requestId
    expect(approval.resolve(requestId, 'once')).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(approval.pending()).toHaveLength(0)
  })

  it('reject denies', async () => {
    const { approval, cards } = make()
    const pending = approval.request(REQ)
    await new Promise((r) => setTimeout(r, 5))
    approval.resolve(cards[0].requestId, 'reject')
    await expect(pending).resolves.toBe(false)
  })

  it('always is remembered per run+command, so a loop asks once', async () => {
    const { approval, cards } = make()
    const first = approval.request(REQ)
    await new Promise((r) => setTimeout(r, 5))
    approval.resolve(cards[0].requestId, 'always')
    await expect(first).resolves.toBe(true)

    // Same command, same run: no second card.
    await expect(approval.request(REQ)).resolves.toBe(true)
    expect(cards).toHaveLength(1)

    // A different command in the same run still asks.
    const other = approval.request({ ...REQ, cmd: 'rm', args: ['-rf', 'build'] })
    await new Promise((r) => setTimeout(r, 5))
    expect(cards).toHaveLength(2)
    approval.resolve(cards[1].requestId, 'reject')
    await expect(other).resolves.toBe(false)
  })

  it('a different run does not inherit the remembered decision', async () => {
    const { approval, cards } = make()
    const first = approval.request(REQ)
    await new Promise((r) => setTimeout(r, 5))
    approval.resolve(cards[0].requestId, 'always')
    await first

    const second = approval.request({ ...REQ, runId: 'dwfrun-2' })
    await new Promise((r) => setTimeout(r, 5))
    expect(cards).toHaveLength(2)
    approval.resolve(cards[1].requestId, 'reject')
    await expect(second).resolves.toBe(false)
  })

  it('an unanswered request denies when the timeout fires (fail-closed)', async () => {
    const { approval } = make({ timeoutMs: 30 })
    await expect(approval.request(REQ)).resolves.toBe(false)
  })

  it('an unknown requestId is not a decision', () => {
    const { approval } = make()
    expect(approval.resolve('nope', 'once')).toBe(false)
  })

  it('stop() denies everything still waiting', async () => {
    const { approval } = make()
    const pending = approval.request(REQ)
    await new Promise((r) => setTimeout(r, 5))
    approval.stop()
    await expect(pending).resolves.toBe(false)
    await expect(approval.request(REQ)).resolves.toBe(false) // stopped = deny
  })

  it('pending() lists what is still waiting (the run view uses it)', async () => {
    const { approval } = make()
    const pending = approval.request(REQ)
    await new Promise((r) => setTimeout(r, 5))
    expect(approval.pending()).toEqual([{ requestId: expect.stringContaining('wfrun-approval:'), runId: 'dwfrun-1', cmd: 'npm' }])
    approval.stop()
    await pending
  })
})
