// offpeak.ts — 闲时任务（N5 裁决③：ZCode off-peak 取号语义，非 cron）。
//
// 每条任务是一次性工单：表单创建即取号排队（queued），低峰窗口开启后按 FIFO
// 逐条派发（新建 session → 发 prompt → running），会话转空闲即 completed。
// 与 core/scheduler.ts（M8 cron 周期提示，TG 面在用）互不替代——那个是周期
// 循环，这个是单发工单，状态机对齐 vendor ZCodeOffPeakTaskStatus。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('offpeak')

export type OffPeakStatus = 'queued' | 'paused' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface OffPeakTask {
  id: string
  title: string
  prompt: string
  /** vendor ZCodeTaskMode：yolo/plan/edit/auto/autoEdit/build；派发映射审批策略 */
  permissionMode: string
  /** 创建时固定的模型选择；派发前经 setNextModel 应到引擎（单并发下安全） */
  modelSelection?: { providerID: string; modelID: string }
  /** 目标工作区；空 = host 默认目录 */
  directory?: string
  status: OffPeakStatus
  queuedAt: number
  startedAt?: number
  endedAt?: number
  failureReason?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
}

export interface OffPeakWindow {
  /** "HH:MM" 本地时间；start>end 表示跨午夜（如 22:00-08:00） */
  start: string
  end: string
}

export interface OffPeakOptions {
  path: string
  window: OffPeakWindow
  createSession: (directory?: string, title?: string) => Promise<string>
  sendMessage: (sessionId: string, text: string) => Promise<void>
  applyModelSelection?: (m: { providerID: string; modelID: string }) => void
  applyApprovalPolicy?: (sessionId: string, policy: 'edit' | 'yolo' | undefined) => void
  isSessionBusy: (sessionId: string) => boolean
  tickMs?: number
}

export interface OffPeakManager {
  start(): void
  stop(): void
  tick(now?: Date): { dispatched: string[]; settled: string[] }
  list(): OffPeakTask[]
  get(id: string): OffPeakTask | undefined
  add(input: { title: string; prompt: string; permissionMode?: string; modelSelection?: { providerID: string; modelID: string }; directory?: string }): OffPeakTask | null
  pause(id: string): OffPeakTask | undefined
  continueTask(id: string): OffPeakTask | undefined
  cancel(id: string): OffPeakTask | undefined
  remove(id: string): boolean
}

const TERMINAL: OffPeakStatus[] = ['completed', 'failed', 'cancelled']

function now() {
  return Date.now()
}

function mkId() {
  return `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function parseHHMM(v: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function inWindow(t: Date, w: OffPeakWindow): boolean {
  const start = parseHHMM(w.start)
  const end = parseHHMM(w.end)
  if (start === null || end === null) return true // 窗口非法 = 不设限（fail-open，只影响何时派发）
  const minutes = t.getHours() * 60 + t.getMinutes()
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** vendor ZCodeTaskMode → ocrc 审批策略（0.27 四档：edit/yolo；plan 无对应档，落 ask） */
function policyFromMode(mode: string): 'edit' | 'yolo' | undefined {
  if (mode === 'yolo') return 'yolo'
  if (mode === 'edit' || mode === 'autoEdit') return 'edit'
  return undefined // default/auto/plan → 引擎默认询问
}

export function createOffPeakManager(opts: OffPeakOptions): OffPeakManager {
  interface Store {
    tasks: OffPeakTask[]
  }
  let store: Store = { tasks: [] }
  let timer: ReturnType<typeof setInterval> | null = null

  function load(): void {
    if (!existsSync(opts.path)) return
    try {
      store = JSON.parse(readFileSync(opts.path, 'utf8')) as Store
    } catch (e) {
      log.warn(`offpeak store corrupt, starting empty: ${(e as Error).message}`)
      store = { tasks: [] }
    }
  }

  function save(): void {
    mkdirSync(dirname(opts.path), { recursive: true })
    const tmp = `${opts.path}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2))
    renameSync(tmp, opts.path)
  }

  function persist(t: OffPeakTask): void {
    t.updatedAt = now()
    save()
  }

  function tick(nowDate = new Date()): { dispatched: string[]; settled: string[] } {
    const dispatched: string[] = []
    const settled: string[] = []
    // ① 收口 running：会话已空闲 → completed
    const running = store.tasks.find((t) => t.status === 'running')
    if (running?.sessionId && !opts.isSessionBusy(running.sessionId)) {
      running.status = 'completed'
      running.endedAt = now()
      persist(running)
      settled.push(running.id)
      log.info(`offpeak task ${running.id} completed (session ${running.sessionId})`)
    }
    // ② 派发：窗口开 + 单并发（严格 FIFO）+ 有排队
    if (inWindow(nowDate, opts.window) && !running) {
      const next = store.tasks
        .filter((t) => t.status === 'queued')
        .sort((a, b) => a.queuedAt - b.queuedAt)[0]
      if (next) {
        next.status = 'running'
        next.startedAt = now()
        persist(next)
        try {
          if (next.modelSelection) opts.applyModelSelection?.(next.modelSelection)
          void opts
            .createSession(next.directory, next.title)
            .then(async (sessionId) => {
              next.sessionId = sessionId
              opts.applyApprovalPolicy?.(sessionId, policyFromMode(next.permissionMode))
              persist(next)
              await opts.sendMessage(sessionId, next.prompt)
              dispatched.push(next.id)
              log.info(`offpeak task ${next.id} dispatched → session ${sessionId}`)
            })
            .catch((e) => {
              next.status = 'failed'
              next.failureReason = (e as Error).message
              next.endedAt = now()
              persist(next)
              log.warn(`offpeak task ${next.id} dispatch failed: ${(e as Error).message}`)
            })
        } catch (e) {
          next.status = 'failed'
          next.failureReason = (e as Error).message
          next.endedAt = now()
          persist(next)
        }
      }
    }
    return { dispatched, settled }
  }

  load()

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        try {
          tick()
        } catch (e) {
          log.warn(`offpeak tick error: ${(e as Error).message}`)
        }
      }, opts.tickMs ?? 30_000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    list() {
      return [...store.tasks]
    },
    get(id) {
      return store.tasks.find((t) => t.id === id)
    },
    add(input) {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (!title || !prompt.trim()) return null
      const task: OffPeakTask = {
        id: mkId(),
        title,
        prompt,
        permissionMode: typeof input.permissionMode === 'string' && input.permissionMode ? input.permissionMode : 'default',
        modelSelection: input.modelSelection,
        directory: typeof input.directory === 'string' && input.directory.trim() ? input.directory.trim() : undefined,
        status: 'queued',
        queuedAt: now(),
        createdAt: now(),
        updatedAt: now(),
      }
      store.tasks.push(task)
      save()
      return task
    },
    pause(id) {
      const t = store.tasks.find((x) => x.id === id && x.status === 'queued')
      if (!t) return undefined
      t.status = 'paused'
      persist(t)
      return t
    },
    continueTask(id) {
      const t = store.tasks.find((x) => x.id === id && x.status === 'paused')
      if (!t) return undefined
      t.status = 'queued'
      t.queuedAt = now() // 重新排队排到队尾（对齐 vendor Continue 重取号语义）
      persist(t)
      return t
    },
    cancel(id) {
      const t = store.tasks.find((x) => x.id === id && (x.status === 'queued' || x.status === 'paused'))
      if (!t) return undefined
      t.status = 'cancelled'
      t.endedAt = now()
      persist(t)
      return t
    },
    remove(id) {
      const before = store.tasks.length
      // 终态/任意态都可删 History 行（vendor 语义：只删本地行）；running 行删除后
      // tick 的收口自然失效（找不到 running 任务）。
      store.tasks = store.tasks.filter((t) => t.id !== id)
      if (store.tasks.length !== before) save()
      return store.tasks.length !== before
    },
  }
}

export { TERMINAL as OFF_PEAK_TERMINAL_STATUSES }
