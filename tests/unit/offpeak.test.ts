// N12 G8 — off-peak task manager. N5 shipped this module with no unit tests at
// all (the debt is paid here): FIFO dispatch, window gating, single-concurrency,
// queue positions, bound-session resume, failure/cancel re-queue, and the goal
// attachment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOffPeakManager, inWindow, type OffPeakOptions } from '../../src/core/offpeak'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'offpeak-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

interface H {
  manager: ReturnType<typeof createOffPeakManager>
  created: Array<{ directory?: string; title?: string }>
  sent: Array<{ sessionId: string; text: string }>
  goals: Array<{ sessionId: string; objective: string }>
  policies: Array<{ sessionId: string; policy: string | undefined }>
  aborted: string[]
  busy: Set<string>
  opts: OffPeakOptions
}

function harness(over: Partial<OffPeakOptions> = {}): H {
  const created: H['created'] = []
  const sent: H['sent'] = []
  const goals: H['goals'] = []
  const policies: H['policies'] = []
  const aborted: string[] = []
  const busy = new Set<string>()
  let n = 0
  const opts: OffPeakOptions = {
    path: join(dir, 'offpeak.json'),
    window: { start: '00:00', end: '23:59' }, // always open unless a test overrides
    createSession: async (directory, title) => { created.push({ directory, title }); return `ses_${++n}` },
    sendMessage: async (sessionId, text) => { sent.push({ sessionId, text }) },
    applyApprovalPolicy: (sessionId, policy) => { policies.push({ sessionId, policy }) },
    setGoal: (sessionId, objective) => { goals.push({ sessionId, objective }) },
    abortSession: async (id) => { aborted.push(id) },
    isSessionBusy: (id) => busy.has(id),
    ...over,
  }
  return { manager: createOffPeakManager(opts), created, sent, goals, policies, aborted, busy, opts }
}

/** dispatch is fire-and-forget; let its promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('inWindow', () => {
  it('same-day window', () => {
    expect(inWindow(new Date('2026-01-01T09:00:00'), { start: '08:00', end: '18:00' })).toBe(true)
    expect(inWindow(new Date('2026-01-01T07:59:00'), { start: '08:00', end: '18:00' })).toBe(false)
    expect(inWindow(new Date('2026-01-01T18:00:00'), { start: '08:00', end: '18:00' })).toBe(false)
  })
  it('overnight window (start > end)', () => {
    expect(inWindow(new Date('2026-01-01T23:00:00'), { start: '22:00', end: '08:00' })).toBe(true)
    expect(inWindow(new Date('2026-01-01T03:00:00'), { start: '22:00', end: '08:00' })).toBe(true)
    expect(inWindow(new Date('2026-01-01T12:00:00'), { start: '22:00', end: '08:00' })).toBe(false)
  })
  it('a malformed window fails open (never blocks dispatch)', () => {
    expect(inWindow(new Date('2026-01-01T12:00:00'), { start: 'nope', end: 'x' })).toBe(true)
  })
})

describe('add / validation', () => {
  it('rejects an empty title or prompt', () => {
    const h = harness()
    expect(h.manager.add({ title: '', prompt: 'x' })).toBeNull()
    expect(h.manager.add({ title: 'x', prompt: '   ' })).toBeNull()
  })

  it('persists across a reload', () => {
    const h = harness()
    const t = h.manager.add({ title: '夜跑', prompt: '跑测试' })!
    expect(t.status).toBe('queued')
    const reloaded = createOffPeakManager(h.opts)
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0]).toMatchObject({ title: '夜跑', status: 'queued' })
  })

  it('carries boundSessionId and goal', () => {
    const h = harness()
    const t = h.manager.add({ title: 'x', prompt: 'y', boundSessionId: 'ses_bound', goal: '让测试全绿' })!
    expect(t.boundSessionId).toBe('ses_bound')
    expect(t.goal).toBe('让测试全绿')
  })
})

describe('queue position', () => {
  it('numbers queued tasks in FIFO order and drops the field for other states', () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    const b = h.manager.add({ title: 'B', prompt: 'b' })!
    const c = h.manager.add({ title: 'C', prompt: 'c' })!
    h.manager.pause(b.id)
    const byId = Object.fromEntries(h.manager.list().map((t) => [t.id, t.queuePosition]))
    expect(byId[a.id]).toBe(1)
    expect(byId[c.id]).toBe(2)
    expect(byId[b.id]).toBeUndefined() // paused is not in the queue
    // 派生值不落盘
    const onDisk = JSON.parse(readFileSync(h.opts.path, 'utf8')) as { tasks: any[] }
    expect(onDisk.tasks.every((t) => t.queuePosition === undefined)).toBe(true)
  })

  it('re-queuing sends the task to the back of the line', () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    const b = h.manager.add({ title: 'B', prompt: 'b' })!
    h.manager.pause(a.id)
    h.manager.continueTask(a.id)
    const order = h.manager.list().filter((t) => t.status === 'queued').sort((x, y) => (x.queuePosition ?? 0) - (y.queuePosition ?? 0))
    expect(order.map((t) => t.id)).toEqual([b.id, a.id])
  })
})

describe('dispatch', () => {
  it('window closed → nothing dispatched', async () => {
    const h = harness({ window: { start: '22:00', end: '23:00' } })
    h.manager.add({ title: 'A', prompt: 'a' })
    const res = h.manager.tick(new Date('2026-01-01T12:00:00'))
    await settle()
    expect(res.dispatched).toEqual([])
    expect(h.created).toHaveLength(0)
  })

  it('FIFO: one at a time, oldest queuedAt first', async () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.add({ title: 'B', prompt: 'b' })
    h.manager.tick()
    await settle()
    expect(h.created).toHaveLength(1) // single concurrency
    expect(h.sent).toEqual([{ sessionId: 'ses_1', text: 'a' }])
    expect(h.manager.get(a.id)!.status).toBe('running')
    expect(h.manager.get(a.id)!.sessionId).toBe('ses_1')
  })

  it('applies the permission mode as an approval policy', async () => {
    const h = harness()
    h.manager.add({ title: 'A', prompt: 'a', permissionMode: 'yolo' })
    h.manager.tick()
    await settle()
    expect(h.policies).toEqual([{ sessionId: 'ses_1', policy: 'yolo' }])
  })

  it('settles a running task once its session goes idle', async () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.tick()
    await settle()
    h.busy.add('ses_1')
    expect(h.manager.tick().settled).toEqual([])
    h.busy.delete('ses_1')
    expect(h.manager.tick().settled).toEqual([a.id])
    expect(h.manager.get(a.id)!.status).toBe('completed')
    expect(h.manager.get(a.id)!.endedAt).toBeGreaterThan(0)
  })

  it('a dispatch failure lands as failed with the reason kept', async () => {
    const h = harness({ sendMessage: async () => { throw new Error('engine down') } })
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.tick()
    await settle()
    expect(h.manager.get(a.id)).toMatchObject({ status: 'failed', failureReason: 'engine down' })
  })
})

describe('bound session (会话内创建)', () => {
  it('resumes the bound session instead of creating one', async () => {
    const h = harness({ sessionExists: async (id) => id === 'ses_bound' })
    const a = h.manager.add({ title: 'A', prompt: 'a', boundSessionId: 'ses_bound' })!
    h.manager.tick()
    await settle()
    expect(h.created).toHaveLength(0)
    expect(h.sent).toEqual([{ sessionId: 'ses_bound', text: 'a' }])
    expect(h.manager.get(a.id)!.sessionId).toBe('ses_bound')
  })

  it('falls back to a new session when the bound one is gone', async () => {
    const h = harness({ sessionExists: async () => false })
    h.manager.add({ title: 'A', prompt: 'a', boundSessionId: 'ses_dead' })
    h.manager.tick()
    await settle()
    expect(h.created).toHaveLength(1)
    expect(h.sent[0]!.sessionId).toBe('ses_1')
  })

  it('a throwing existence check falls back rather than failing the task', async () => {
    const h = harness({ sessionExists: async () => { throw new Error('transport') } })
    const a = h.manager.add({ title: 'A', prompt: 'a', boundSessionId: 'ses_x' })!
    h.manager.tick()
    await settle()
    expect(h.manager.get(a.id)!.status).toBe('running')
    expect(h.created).toHaveLength(1)
  })
})

describe('goal attachment (N12)', () => {
  it('attaches the goal after the task prompt is sent', async () => {
    const h = harness()
    h.manager.add({ title: 'A', prompt: '把测试跑绿', goal: '让测试全绿' })
    h.manager.tick()
    await settle()
    expect(h.sent).toEqual([{ sessionId: 'ses_1', text: '把测试跑绿' }])
    expect(h.goals).toEqual([{ sessionId: 'ses_1', objective: '让测试全绿' }])
  })

  it('no goal configured → no setGoal call', async () => {
    const h = harness()
    h.manager.add({ title: 'A', prompt: 'a' })
    h.manager.tick()
    await settle()
    expect(h.goals).toEqual([])
  })
})

describe('pause / continue / cancel', () => {
  it('continue resumes paused, failed and cancelled alike, clearing the failure', async () => {
    const h = harness({ sendMessage: async () => { throw new Error('boom') } })
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.tick()
    await settle()
    expect(h.manager.get(a.id)!.status).toBe('failed')
    const resumed = h.manager.continueTask(a.id)!
    expect(resumed).toMatchObject({ status: 'queued' })
    expect(resumed.failureReason).toBeUndefined()
    expect(resumed.endedAt).toBeUndefined()
    expect(resumed.sessionId).toBeUndefined()
  })

  it('continue works from cancelled too', () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.cancel(a.id)
    expect(h.manager.get(a.id)!.status).toBe('cancelled')
    expect(h.manager.continueTask(a.id)!.status).toBe('queued')
  })

  it('continue refuses a running or completed task', async () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.tick()
    await settle()
    expect(h.manager.continueTask(a.id)).toBeUndefined() // running
    h.manager.tick()
    expect(h.manager.get(a.id)!.status).toBe('completed')
    expect(h.manager.continueTask(a.id)).toBeUndefined() // completed
  })

  it('cancelling a running task aborts the engine turn', async () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    h.manager.tick()
    await settle()
    const c = h.manager.cancel(a.id)!
    expect(c.status).toBe('cancelled')
    expect(h.aborted).toEqual(['ses_1'])
  })

  it('remove deletes any state and is idempotent', () => {
    const h = harness()
    const a = h.manager.add({ title: 'A', prompt: 'a' })!
    expect(h.manager.remove(a.id)).toBe(true)
    expect(h.manager.remove(a.id)).toBe(false)
    expect(h.manager.list()).toHaveLength(0)
  })
})

describe('start/stop', () => {
  it('start is idempotent and stop clears the interval', () => {
    vi.useFakeTimers()
    try {
      const h = harness({ tickMs: 1000 })
      h.manager.start()
      h.manager.start() // no second interval
      h.manager.add({ title: 'A', prompt: 'a' })
      vi.advanceTimersByTime(1000)
      expect(h.created).toHaveLength(1)
      h.manager.stop()
      vi.advanceTimersByTime(5000)
      expect(h.created).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
