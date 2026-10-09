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
  /** 会话内创建（对齐 vendor ZCodeOffPeakTaskCreateParams.boundSessionId）：
   *  首跑 resume 该会话而不是新建。会话已不在则回落新建。 */
  boundSessionId?: string
  /** 携带目标（N12）：派发后自动挂 goal，让工单跑完目标循环（含续跑）。 */
  goal?: string
  /** 排队位次（1 起，FIFO）。**派生字段**——只在 list()/get() 输出里填，
   *  不落盘：队一动位次就变，存下来只会是陈旧值。 */
  queuePosition?: number
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
  /** boundSessionId 仍存在？缺省视为不存在（回落新建会话）。 */
  sessionExists?: (sessionId: string) => Promise<boolean>
  /** 派发后挂目标（N12）。kickoff 由任务自己的 prompt 承担，不再另发一轮。 */
  setGoal?: (sessionId: string, objective: string) => void
  /** 取消 running 任务时中止引擎回合。缺省则只改状态（回合会自然跑完）。 */
  abortSession?: (sessionId: string) => Promise<void>
  tickMs?: number
}

export interface OffPeakManager {
  start(): void
  stop(): void
  tick(now?: Date): { dispatched: string[]; settled: string[] }
  list(): OffPeakTask[]
  get(id: string): OffPeakTask | undefined
  add(input: { title: string; prompt: string; permissionMode?: string; modelSelection?: { providerID: string; modelID: string }; directory?: string; boundSessionId?: string; goal?: string }): OffPeakTask | null
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

  /** 首跑目标会话：绑定的会话仍在就用它，否则新建。 */
  async function resolveTargetSession(t: OffPeakTask): Promise<string> {
    if (t.boundSessionId && opts.sessionExists) {
      try {
        if (await opts.sessionExists(t.boundSessionId)) return t.boundSessionId
        log.info(`offpeak task ${t.id}: bound session ${t.boundSessionId.slice(-8)} gone, creating a new one`)
      } catch (e) {
        log.warn(`offpeak task ${t.id}: sessionExists check failed: ${(e as Error).message}`)
      }
    }
    return await opts.createSession(t.directory, t.title)
  }

  /** FIFO 位次（1 起）。队一动就变，所以只在读出时算，不落盘。 */
  function queuedPositions(): Map<string, number> {
    const ordered = store.tasks
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.queuedAt - b.queuedAt)
    return new Map(ordered.map((t, i) => [t.id, i + 1]))
  }

  /** 读出投影：给 queued 补 queuePosition，其余态剥掉（避免陈旧值）。 */
  function present(t: OffPeakTask, positions: Map<string, number>): OffPeakTask {
    const pos = t.status === 'queued' ? positions.get(t.id) : undefined
    const { queuePosition: _drop, ...rest } = t
    return pos === undefined ? rest : { ...rest, queuePosition: pos }
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
          // 会话内创建的任务首跑 resume 绑定会话（对齐 vendor CronCreate
          // targetTaskId）；会话已不在则回落新建，不让工单死在陈旧绑定上。
          void resolveTargetSession(next)
            .then(async (sessionId) => {
              next.sessionId = sessionId
              opts.applyApprovalPolicy?.(sessionId, policyFromMode(next.permissionMode))
              persist(next)
              await opts.sendMessage(sessionId, next.prompt)
              // 目标挂在任务自己的那轮之后：kickoff 不再另发，避免双轮。
              if (next.goal) opts.setGoal?.(sessionId, next.goal)
              dispatched.push(next.id)
              log.info(`offpeak task ${next.id} dispatched → session ${sessionId}${next.goal ? ' (goal attached)' : ''}`)
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
      const positions = queuedPositions()
      return store.tasks.map((t) => present(t, positions))
    },
    get(id) {
      const t = store.tasks.find((x) => x.id === id)
      return t ? present(t, queuedPositions()) : undefined
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
        ...(typeof input.boundSessionId === 'string' && input.boundSessionId.trim() ? { boundSessionId: input.boundSessionId.trim() } : {}),
        ...(typeof input.goal === 'string' && input.goal.trim() ? { goal: input.goal.trim() } : {}),
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
      // paused 之外，failed/cancelled 也允许重取号（对齐 vendor Continue：
      // 失败或误取消的工单不该只能删了重建）。
      const t = store.tasks.find(
        (x) => x.id === id && (x.status === 'paused' || x.status === 'failed' || x.status === 'cancelled'),
      )
      if (!t) return undefined
      t.status = 'queued'
      // 重新排队排到队尾（对齐 vendor Continue 重取号语义）。queuedAt 是毫秒，
      // 连续操作会同刻打平、FIFO 退化成数组序——所以取「当前队尾 + 1」保证严格靠后。
      t.queuedAt = Math.max(now(), store.tasks.reduce((m, x) => Math.max(m, x.queuedAt), 0) + 1)
      delete t.failureReason
      delete t.endedAt
      t.sessionId = undefined
      persist(t)
      return t
    },
    cancel(id) {
      // running 也可取消：有 abortSession 就真中止引擎回合，没有就只改状态
      // （回合自然跑完，但工单不再被 tick 收口）。
      const t = store.tasks.find(
        (x) => x.id === id && (x.status === 'queued' || x.status === 'paused' || x.status === 'running'),
      )
      if (!t) return undefined
      if (t.status === 'running' && t.sessionId && opts.abortSession) {
        void opts.abortSession(t.sessionId).catch((e) => log.warn(`offpeak abort failed: ${(e as Error).message}`))
      }
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
