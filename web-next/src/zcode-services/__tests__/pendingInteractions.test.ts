// pendingInteractions.test.ts — U1 dock 投影与应答换算的单测钉死。
// 投影输出直接过 vendor zod schema（pendingInteractionSchema）——形状漂移当场爆。
import { describe, expect, it } from 'vitest'
import { pendingInteractionSchema } from '@zcode/shared/zcode-protocol-v4/snapshot'
import {
  APPROVAL_OPTIONS,
  contentToAnswerRows,
  decisionFromOptionId,
  projectPendingInteractions,
  type InteractionCard,
} from '../pendingInteractions.js'

const approvalCard: InteractionCard = {
  kind: 'approval',
  requestId: 'perm-1',
  title: 'bash',
  args: { command: 'rm -rf /tmp/x' },
}

const questionCard: InteractionCard = {
  kind: 'question',
  requestId: 'q-1',
  questions: [
    {
      question: '用哪个库？',
      header: '选型',
      options: [
        { label: 'vitest', description: '快' },
        { label: 'jest' },
      ],
      multiple: false,
      custom: true,
    },
    {
      question: '要覆盖哪些目录？',
      options: [{ label: 'src' }, { label: 'tests' }],
      multiple: true,
    },
  ],
}

describe('projectPendingInteractions', () => {
  it('approval 卡 → schema 合法的 permission 交互（三选项与 host decision 同词）', () => {
    const out = projectPendingInteractions([approvalCard])
    expect(out).toHaveLength(1)
    const parsed = pendingInteractionSchema.parse(out[0])
    expect(parsed.kind).toBe('permission')
    if (parsed.payload.kind !== 'permission') return
    expect(parsed.interactionId).toBe('perm-1')
    expect(parsed.anchorRowId).toBeNull()
    expect(parsed.payload.toolName).toBe('bash')
    expect(parsed.payload.summary).toBe('bash')
    expect(parsed.payload.detail).toEqual({ command: 'rm -rf /tmp/x' })
    expect(parsed.payload.options.map((o) => o.optionId)).toEqual(['once', 'always', 'reject'])
    expect(parsed.payload.options.map((o) => o.kind)).toEqual(['allowOnce', 'allowAlways', 'deny'])
  })

  it('question 卡 → schema 合法的 userInput 交互（options value=label，multiple→multiSelect，custom→freeText）', () => {
    const out = projectPendingInteractions([questionCard])
    const parsed = pendingInteractionSchema.parse(out[0])
    expect(parsed.kind).toBe('userInput')
    if (parsed.payload.kind !== 'userInput') return
    expect(parsed.payload.prompt).toBe('用哪个库？')
    expect(parsed.payload.freeText).toBe(true)
    expect(parsed.payload.questions).toHaveLength(2)
    const [q1, q2] = parsed.payload.questions!
    expect(q1.header).toBe('选型')
    expect(q1.multiSelect).toBeUndefined()
    expect(q1.options[0]).toEqual({ value: 'vitest', label: 'vitest', description: '快' })
    expect(q1.options[1]).toEqual({ value: 'jest', label: 'jest' })
    expect(q2.multiSelect).toBe(true)
    expect(q2.header).toBe('要覆盖哪些目录？')
  })

  it('resolved 卡（host 原 id 重发布）不投影 = dock 清除信号', () => {
    expect(projectPendingInteractions([{ ...approvalCard, resolved: 'approved' }])).toHaveLength(0)
    expect(projectPendingInteractions([{ ...questionCard, resolved: 'replied' }])).toHaveLength(0)
    expect(projectPendingInteractions([{ ...questionCard, resolved: 'rejected' }])).toHaveLength(0)
  })

  it('空 questions 的 question 卡不投影（resolved 重发布即此形状）', () => {
    expect(projectPendingInteractions([{ kind: 'question', requestId: 'q-2', questions: [] }])).toHaveLength(0)
  })

  it('无 requestId / 非交互卡跳过；普通卡混入不影响', () => {
    const out = projectPendingInteractions([
      { kind: 'assistant' },
      { kind: 'approval' },
      { kind: 'user' },
      approvalCard,
    ])
    expect(out).toHaveLength(1)
  })

  it('createdAt 兜底 0（卡无 ts；now 会让 live 签名抖动）', () => {
    const parsed = pendingInteractionSchema.parse(projectPendingInteractions([approvalCard])[0])
    expect(parsed.createdAt).toBe(0)
  })
})

describe('decisionFromOptionId', () => {
  it('三选项恒等映射，其余拒绝', () => {
    expect(decisionFromOptionId('once')).toBe('once')
    expect(decisionFromOptionId('always')).toBe('always')
    expect(decisionFromOptionId('reject')).toBe('reject')
    expect(decisionFromOptionId('fullAccess')).toBeNull()
    expect(decisionFromOptionId('')).toBeNull()
  })
})

describe('contentToAnswerRows（vendor buildElicitationResponseContent 的逆换算）', () => {
  const questions = questionCard.questions!

  it('answer_i 精确路径：字符串与数组各按题落位', () => {
    const rows = contentToAnswerRows(questions, {
      answers: { '用哪个库？': 'vitest', '要覆盖哪些目录？': 'src, tests' },
      answer_0: 'vitest',
      answer_1: ['src', 'tests'],
    })
    expect(rows).toEqual([['vitest'], ['src', 'tests']])
  })

  it('跳题留空行保位（answer_0 缺、answer_1 在）', () => {
    const rows = contentToAnswerRows(questions, { answer_1: ['tests'] })
    expect(rows).toEqual([[], ['tests']])
  })

  it('answer_i 缺失时回落 answers 映射（", " join 的逆操作）', () => {
    const rows = contentToAnswerRows(questions, {
      answers: { '用哪个库？': 'vitest', '要覆盖哪些目录？': 'src, tests' },
    })
    expect(rows).toEqual([['vitest'], ['src', 'tests']])
  })

  it('无题单：连续 answer_i 扫描', () => {
    expect(contentToAnswerRows(undefined, { answer_0: 'a', answer_1: ['b', 'c'] })).toEqual([['a'], ['b', 'c']])
  })

  it('无题单：单题旧路径 answer', () => {
    expect(contentToAnswerRows(undefined, { answer: 'x' })).toEqual([['x']])
    expect(contentToAnswerRows(undefined, { answer: ['x', 'y'] })).toEqual([['x', 'y']])
  })

  it('全缺 → []（引擎语义：未作答继续）；空白串不算答案', () => {
    expect(contentToAnswerRows(questions, {})).toEqual([[], []])
    expect(contentToAnswerRows(undefined, {})).toEqual([])
    expect(contentToAnswerRows(undefined, { answer: '  ' })).toEqual([])
    expect(contentToAnswerRows(questions, { answer_0: ['  ', 'a'] })).toEqual([['a'], []])
  })
})

describe('APPROVAL_OPTIONS', () => {
  it('optionId 与 host /api/approval 的 decision 集合同词', () => {
    for (const o of APPROVAL_OPTIONS) expect(decisionFromOptionId(o.optionId)).not.toBeNull()
  })
})
