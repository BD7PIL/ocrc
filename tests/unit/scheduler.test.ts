import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScheduler } from '../../src/core/scheduler'

function tmpPath() {
  return join(mkdtempSync(join(tmpdir(), 'ocrc-sched-')), 'schedules.json')
}

describe('createScheduler', () => {
  it('validates specs at the boundary — bad shapes return null and are not stored', () => {
    const sched = createScheduler({ path: tmpPath(), dispatch: vi.fn(async () => {}) })
    expect(sched.add({ prompt: 'x', spec: { kind: 'bogus' } as any })).toBeNull()
    expect(sched.add({ prompt: 'x', spec: { kind: 'every', minutes: 0 } })).toBeNull()
    expect(sched.add({ prompt: 'x', spec: { kind: 'daily', time: '25:00' } })).toBeNull()
    expect(sched.add({ prompt: '   ', spec: { kind: 'every', minutes: 5 } })).toBeNull()
    expect(sched.list()).toHaveLength(0)
  })

  it('every-N: first tick fires immediately, then respects the interval', () => {
    const dispatch = vi.fn(async () => {})
    const sched = createScheduler({ path: tmpPath(), dispatch })
    const s = sched.add({ prompt: 'run tests', spec: { kind: 'every', minutes: 10 } })!
    const t0 = new Date('2026-10-05T10:00:00')

    expect(sched.tick(t0).map((x) => x.id)).toEqual([s.id])
    expect(dispatch).toHaveBeenCalledTimes(1)

    // within the interval → not due
    expect(sched.tick(new Date(t0.getTime() + 5 * 60_000))).toHaveLength(0)
    // at the interval boundary → due again
    expect(sched.tick(new Date(t0.getTime() + 10 * 60_000)).map((x) => x.id)).toEqual([s.id])
    // a disabled schedule never fires
    sched.setEnabled(s.id, false)
    expect(sched.tick(new Date(t0.getTime() + 20 * 60_000))).toHaveLength(0)
  })

  it('daily: fires once per day at HH:MM', () => {
    const sched = createScheduler({ path: tmpPath(), dispatch: vi.fn(async () => {}) })
    const s = sched.add({ prompt: 'standup', spec: { kind: 'daily', time: '09:00' } })!
    const day1 = new Date('2026-10-05T09:00:00')

    expect(sched.tick(new Date('2026-10-05T08:59:00'))).toHaveLength(0)
    expect(sched.tick(day1).map((x) => x.id)).toEqual([s.id])
    // the 30s due window later the same day → already ran today
    expect(sched.tick(new Date('2026-10-05T09:00:20'))).toHaveLength(0)
    // next day → due again
    expect(sched.tick(new Date('2026-10-06T09:00:10')).map((x) => x.id)).toEqual([s.id])
  })

  it('remove() deletes and persists; a fresh store sees the same list', async () => {
    const path = tmpPath()
    const sched = createScheduler({ path, dispatch: vi.fn() })
    const a = sched.add({ prompt: 'a', spec: { kind: 'every', minutes: 5 } })!
    const b = sched.add({ prompt: 'b', spec: { kind: 'daily', time: '08:00' } })!
    expect(sched.remove(a.id)).toBe(true)
    expect(sched.remove(a.id)).toBe(false)
    // persistence is 100ms-debounced — let the write land before reloading
    await new Promise((r) => setTimeout(r, 150))

    const again = createScheduler({ path, dispatch: vi.fn(async () => {}) })
    expect(again.list().map((x) => x.id)).toEqual([b.id])
  })

  it('setEnabled(false) clears lastRunAt so re-enabling starts fresh', () => {
    const sched = createScheduler({ path: tmpPath(), dispatch: vi.fn(async () => {}) })
    const s = sched.add({ prompt: 'p', spec: { kind: 'every', minutes: 5 } })!
    const t0 = new Date('2026-10-05T10:00:00')
    sched.tick(t0)
    sched.setEnabled(s.id, false)
    const stored = sched.list().find((x) => x.id === s.id)!
    expect(stored.enabled).toBe(false)
    expect(stored.lastRunAt).toBeUndefined()
  })
})
