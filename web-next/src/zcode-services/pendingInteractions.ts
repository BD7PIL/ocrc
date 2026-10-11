// zcode-services/pendingInteractions.ts — U1 权限/提问 dock 投影（纯函数）。
// ocrc cardBus 的 approval/question 卡 → vendor PendingInteraction（形状锚点：
// vendor shared zcode-protocol-v4/snapshot.ts 的 pendingInteractionSchema）。
// 不 fetch、不持状态——投影与应答换算的正确性由 __tests__/pendingInteractions.test.ts
// 对 vendor zod schema 逐字段钉死。

/** 桥内 OcrcCard 里投影关心的字段（zcodeAgentService 的 OcrcCard 的结构子集）。 */
export interface InteractionCard {
  kind: string
  ts?: number
  requestId?: string
  title?: string
  args?: unknown
  questions?: Array<{
    question: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiple?: boolean
    custom?: boolean
  }>
  resolved?: string
}

/** vendor resolveInteraction 的 answer（command.ts:220）。 */
export interface OcInteractionAnswer {
  optionId?: string
  freeText?: string
  action?: string
  content?: Record<string, unknown>
}

/** 审批三选项：optionId 与 host /api/approval 的 decision（once|always|reject）
 *  同词——回程零换算。语义与 TG inline 键盘（Once/Always/Reject）对齐。 */
export const APPROVAL_OPTIONS = [
  { optionId: 'once', label: '允许一次', kind: 'allowOnce' },
  { optionId: 'always', label: '总是允许', kind: 'allowAlways' },
  { optionId: 'reject', label: '拒绝', kind: 'deny' },
] as const

export function decisionFromOptionId(optionId: string): 'once' | 'always' | 'reject' | null {
  return optionId === 'once' || optionId === 'always' || optionId === 'reject' ? optionId : null
}

/** 未 resolved 的 approval/question 卡 → vendor PendingInteraction[]。
 *  resolved 的同 id 卡（host 在 resolution 时原 id 重发布）是权威清除信号：
 *  这里不投影 = dock 清除。anchorRowId 固定 null（会话级）——卡没有可信的行锚，
 *  vendor 对 null 的语义就是「不锚行、走底部 dock」。createdAt 兜底 0：卡无 ts，
 *  用 now 会让 live 重投影签名每 tick 都变（spurious state.updated 风暴）；
 *  三个 dock 对话框都不消费 createdAt。 */
export function projectPendingInteractions(cards: InteractionCard[], now = 0): unknown[] {
  const out: unknown[] = []
  for (const c of cards) {
    if (c.kind === 'approval') {
      if (c.resolved || !c.requestId) continue
      out.push({
        interactionId: c.requestId,
        kind: 'permission',
        anchorRowId: null,
        createdAt: c.ts ?? now,
        payload: {
          kind: 'permission',
          toolCallId: `perm-${c.requestId}`,
          toolName: c.title || 'permission',
          summary: c.title || '引擎请求权限',
          detail: c.args ?? {},
          options: APPROVAL_OPTIONS.map((o) => ({ ...o })),
        },
      })
    } else if (c.kind === 'question') {
      if (c.resolved || !c.requestId) continue
      const qs = c.questions ?? []
      if (!qs.length) continue
      out.push({
        interactionId: c.requestId,
        kind: 'userInput',
        anchorRowId: null,
        createdAt: c.ts ?? now,
        payload: {
          kind: 'userInput',
          prompt: qs[0]?.question ?? '',
          // 引擎 question 工具的 custom 选项 → 顶部文本输入（ElicitationDialog 的
          // freeText 档）。多题时任一题可自定义即开。
          freeText: qs.some((q) => q.custom === true),
          questions: qs.map((q) => ({
            question: q.question,
            // vendor 的 header 是必填 string；ocrc 缺 header 用题干兜底。
            header: q.header || q.question,
            options: (q.options ?? []).map((o) => ({
              value: o.label,
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            ...(q.multiple ? { multiSelect: true } : {}),
          })),
          // vendor 用 toolName 识别 AskUserQuestion 族；ocrc 的 question 卡全部
          // 来自引擎 question 工具，如实标注。
          toolName: 'askuserquestion',
        },
      })
    }
  }
  return out
}

function normalizeAnswerRow(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.trim() ? [raw] : []
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return []
}

/** vendor ElicitationDialog 的 content（buildElicitationResponseContent）→ host
 *  /api/question/reply 的 answers: string[][]（每题一行，按题序）。
 *  ① 有题单：`answer_${i}` 精确取行，跳题留空行保位（引擎按题序消费）；
 *  ② 题内兜底 answers 映射（题干 → "a, b"，dialog 的 join(", ") 逆操作）；
 *  ③ 无题单（历史窗口裁掉）：连续 answer_i 扫描 + 单题旧路径 answer。
 *  全缺 → []：引擎语义「用户未作答，自行判断继续」。 */
export function contentToAnswerRows(
  questions: ReadonlyArray<{ question: string }> | undefined,
  content: Record<string, unknown> | undefined,
): string[][] {
  const c = content ?? {}
  if (questions?.length) {
    const answersMap = (c.answers && typeof c.answers === 'object' ? c.answers : {}) as Record<string, unknown>
    return questions.map((q, i) => {
      const direct = normalizeAnswerRow(c[`answer_${i}`])
      if (direct.length) return direct
      const byText = answersMap[q.question]
      if (typeof byText === 'string' && byText.trim()) {
        return byText.split(',').map((s) => s.trim()).filter(Boolean)
      }
      return []
    })
  }
  const rows: string[][] = []
  for (let i = 0; ; i++) {
    const row = normalizeAnswerRow(c[`answer_${i}`])
    if (!row.length) break
    rows.push(row)
  }
  if (rows.length) return rows
  const single = normalizeAnswerRow(c.answer)
  if (single.length) return [single]
  return []
}
