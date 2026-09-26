// scheduler.ts — cross-channel scheduled prompts (P2b-M7).
//
// The engine is deliberately channel-free: it persists schedules to a JSON
// file, ticks on an interval, and dispatches due prompts as ordinary
// IncomingMessages through the relay — so Telegram, Web and any future
// channel are all just front-ends over the same store.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IncomingMessage } from './types.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('scheduler')

export type ScheduleSpec =
  | { kind: 'every'; minutes: number }
  | { kind: 'daily'; time: string } // "HH:MM" — local time

export interface Schedule {
  id: string
  name: string
  prompt: string
  spec: ScheduleSpec
  enabled: boolean
  createdAt: number
  lastRunAt?: number
}

export interface ScheduleInput {
  name?: string
  prompt: string
  spec: ScheduleSpec
  enabled?: boolean
}

interface Store {
  schedules: Schedule[]
}

const TICK_MS = 30_000

/** Validate a spec at the boundary (TG wizard / web API both funnel here). */
export function normalizeSpec(raw: unknown): ScheduleSpec | null {
  const r = raw as any
  if (!r || typeof r !== 'object') return null
  if (r.kind === 'every') {
    const m = Number(r.minutes)
    if (!Number.isFinite(m) || m <= 0) return null
    return { kind: 'every', minutes: Math.max(1, Math.floor(m)) }
  }
  if (r.kind === 'daily') {
    const t = typeof r.time === 'string' ? r.time : ''
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return null
    return { kind: 'daily', time: t }
  }
  return null
}

function isDue(s: Schedule, now: Date): boolean {
  if (!s.enabled) return false
  if (s.spec.kind === 'every') {
    if (!s.lastRunAt) return true // first tick after creation fires immediately
    return now.getTime() - s.lastRunAt >= s.spec.minutes * 60_000
  }
  // daily: due when the current HH:MM matches and we haven't run today yet
  const [hh, mm] = s.spec.time.split(':').map(Number)
  const due = now.getHours() === hh && now.getMinutes() >= mm && now.getMinutes() < mm + TICK_MS / 60_000
  if (!due) return false
  const last = s.lastRunAt ? new Date(s.lastRunAt) : undefined
  return !(last && last.toDateString() === now.toDateString())
}

export interface SchedulerOptions {
  /** Persistence path, e.g. ~/.ocrc/schedules.json (atomic write). */
  path: string
  /** Where due prompts go — typically the relay. */
  dispatch: (msg: IncomingMessage) => Promise<void>
  /** Tick override for tests (default 30s). */
  tickMs?: number
}

export interface Scheduler {
  start(): void
  stop(): void
  /** One manual pass — exposed for tests. Returns the schedules it fired. */
  tick(now?: Date): Schedule[]
  list(): Schedule[]
  add(input: ScheduleInput): Schedule | null
  remove(id: string): boolean
  setEnabled(id: string, enabled: boolean): Schedule | undefined
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  let store: Store = { schedules: [] }

  // ── persistence (atomic tmp+rename, same pattern as state.ts) ──
  function load(): void {
    if (!existsSync(opts.path)) return
    try {
      const raw = JSON.parse(readFileSync(opts.path, 'utf-8')) as Store
      store.schedules = Array.isArray(raw.schedules) ? raw.schedules : []
    } catch (err) {
      log.warn(`failed to load ${opts.path}: ${(err as Error).message}`)
    }
  }

  let writeQueued: ReturnType<typeof setTimeout> | undefined
  function persist(): void {
    if (writeQueued) clearTimeout(writeQueued)
    writeQueued = setTimeout(() => {
      try {
        mkdirSync(dirname(opts.path), { recursive: true })
        const tmp = `${opts.path}.tmp`
        writeFileSync(tmp, JSON.stringify({ schedules: store.schedules }, null, 2))
        renameSync(tmp, opts.path)
      } catch (err) {
        log.warn(`persist failed: ${(err as Error).message}`)
      }
    }, 100)
    writeQueued.unref?.()
  }

  load()

  let timer: ReturnType<typeof setInterval> | undefined

  function tick(now: Date = new Date()): Schedule[] {
    const fired: Schedule[] = []
    for (const s of store.schedules) {
      if (!isDue(s, now)) continue
      s.lastRunAt = now.getTime()
      fired.push(s)
      const msg: IncomingMessage = {
        userId: 'ocrc-scheduler',
        chatId: 'ocrc-scheduler',
        text: s.prompt,
        messageId: `sched_${s.id}_${now.getTime()}`,
        origin: 'scheduler',
      }
      void opts.dispatch(msg).catch((err) => log.error(`dispatch failed for ${s.id}`, err as Error))
    }
    if (fired.length > 0) persist()
    return fired
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => tick(), opts.tickMs ?? TICK_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    tick,
    list: () => [...store.schedules].sort((a, b) => b.createdAt - a.createdAt),
    add(input) {
      const spec = normalizeSpec(input.spec)
      if (!spec || !input.prompt.trim()) return null
      const s: Schedule = {
        id: `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: input.name?.trim() || input.prompt.trim().slice(0, 24),
        prompt: input.prompt.trim(),
        spec,
        enabled: input.enabled ?? true,
        createdAt: Date.now(),
      }
      store.schedules.push(s)
      persist()
      return s
    },
    remove(id) {
      const before = store.schedules.length
      store.schedules = store.schedules.filter((s) => s.id !== id)
      const removed = store.schedules.length < before
      if (removed) persist()
      return removed
    },
    setEnabled(id, enabled) {
      const s = store.schedules.find((x) => x.id === id)
      if (!s) return undefined
      s.enabled = enabled
      if (!enabled) delete s.lastRunAt
      persist()
      return s
    },
  }
}
