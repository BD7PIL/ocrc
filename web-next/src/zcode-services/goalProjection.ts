// N12 — ocrc goal record → vendor GoalState projection.
//
// 权威记录在 host state.json（四态 active|paused|budget_limited|complete）；
// vendor 协议要的是六态 active|paused|verifying|verified|notSatisfied|failed。
// 上游同样把投影态排除在存储之外（「投影态从不落库」），这里逐条对齐它的映射：
//   mapGoalStatus：complete → verified；active → active；其余（paused/budget_limited）
//   → paused（预算耗尽与被 stop 一样等用户显式 resume）。
// 事件驱动的两处覆盖：
//   verifierRunning → verifying（验收进行中，瞬时）；
//   当前轮已有 notSatisfied 验收结论 → notSatisfied。
// 刻意不投影 failed：fail-closed 停机时记录是 paused，投影成 failed 会让 vendor 的
//   resumeGoal 门（goalStatus === 'paused'）关死，用户再也拉不起来。失败由
//   goalVerify 时间线 marker 的 outcome=failed + detail 如实呈现。

/** host state.json 里的 GoalRecord（结构子集；不 import 后端类型）。 */
export interface OcrcGoalRecord {
  targetId: string
  objective: string
  summaryTitle?: string
  status: 'active' | 'paused' | 'budget_limited' | 'complete'
  iteration: number
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  activeRunStartedAtMs?: number
  verifications: Array<{
    iteration: number
    outcome: 'pass' | 'notSatisfied' | 'failed'
    at: number
    reason?: string
    nextAction?: string
  }>
  iterations: Array<{
    iteration: number
    items: Array<{ id: string; content: string; status: string }>
    updatedAt: number
  }>
}

export type GoalProjectionStatus = 'active' | 'paused' | 'verifying' | 'verified' | 'notSatisfied' | 'failed'

export interface GoalProjection {
  targetId: string
  objective: string
  summaryTitle: string | null
  timeUsedSeconds: number
  activeRunStartedAtMs: number | null
  status: GoalProjectionStatus
  iteration: number
  verifications: Array<{
    iteration: number
    outcome: 'pass' | 'notSatisfied' | 'failed'
    at: number
    anchorRowId: number | null
    reason?: string
    nextAction?: string
  }>
  iterations: Array<{
    iteration: number
    items: Array<{ id: string; content: string; status: 'pending' | 'inProgress' | 'completed' }>
    updatedAt: number
  }>
}

/** 当前轮（goal.iteration）的最后一条验收结论。 */
function lastVerificationForCurrentIteration(goal: OcrcGoalRecord) {
  for (let i = goal.verifications.length - 1; i >= 0; i--) {
    const v = goal.verifications[i]!
    if (v.iteration === goal.iteration) return v
  }
  return undefined
}

export function projectGoalStatus(goal: OcrcGoalRecord, verifying: boolean): GoalProjectionStatus {
  if (verifying) return 'verifying'
  if (goal.status === 'complete') return 'verified'
  if (goal.status === 'active') {
    return lastVerificationForCurrentIteration(goal)?.outcome === 'notSatisfied' ? 'notSatisfied' : 'active'
  }
  // paused / budget_limited — 上游 mapGoalStatus 的 default 分支。
  return 'paused'
}

/** vendor 的 availability 门（projection-state.ts:143-153）：pause 只在目标可续
 *  时开；resume 只在 paused 时开。null goal 各自带 noGoalToPause/Resume 原因码。 */
export function projectGoalAvailability(status: GoalProjectionStatus | null): {
  pauseGoal: { allowed: true } | { allowed: false; reasonCode: string }
  resumeGoal: { allowed: true } | { allowed: false; reasonCode: string }
} {
  if (status === null) {
    return {
      pauseGoal: { allowed: false, reasonCode: 'noGoalToPause' },
      resumeGoal: { allowed: false, reasonCode: 'noGoalToResume' },
    }
  }
  const pausable = status === 'active' || status === 'verifying' || status === 'notSatisfied'
  return {
    pauseGoal: pausable ? { allowed: true } : { allowed: false, reasonCode: 'goalNotActive' },
    resumeGoal: status === 'paused' ? { allowed: true } : { allowed: false, reasonCode: 'goalNotPaused' },
  }
}

/** todo 状态归一：vendor planItem 只认 pending/inProgress/completed。 */
function planItemStatus(status: string): 'pending' | 'inProgress' | 'completed' {
  if (status === 'completed' || status === 'cancelled') return 'completed'
  if (status === 'inProgress' || status === 'in_progress') return 'inProgress'
  return 'pending'
}

/** 记录 → vendor GoalState。anchors 把每轮验收钉到时间线行（见 goalVerifyRows）。 */
export function projectGoal(
  goal: OcrcGoalRecord,
  verifying: boolean,
  anchors?: Map<number, number>,
): GoalProjection {
  return {
    targetId: goal.targetId,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle?.trim() ? goal.summaryTitle : null,
    timeUsedSeconds: goal.timeUsedSeconds,
    activeRunStartedAtMs: goal.activeRunStartedAtMs ?? null,
    status: projectGoalStatus(goal, verifying),
    iteration: goal.iteration,
    verifications: goal.verifications.map((v) => ({
      iteration: v.iteration,
      outcome: v.outcome,
      at: v.at,
      anchorRowId: anchors?.get(v.iteration) ?? null,
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.nextAction ? { nextAction: v.nextAction } : {}),
    })),
    iterations: goal.iterations.map((it) => ({
      iteration: it.iteration,
      items: it.items.map((item) => ({ id: item.id, content: item.content, status: planItemStatus(item.status) })),
      updatedAt: it.updatedAt,
    })),
  }
}
