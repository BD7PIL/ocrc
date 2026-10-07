// @ts-nocheck
// v4 恢复链回归测试（N2 修复验证）：
// 根因——accessor 的 wire 帧固定 logicalFrameOrdinal:1，同订阅第二帧（recovery）
// 撞上已 settle 的 initial 帧 → proto.frameAssemblyOrdinalConflict → store 阶梯
// fail-closed → fault.subscription.recoveryFailed。修复：每订阅单调 ordinal +
// resync 如实回 resume/snapshot。本测试用真实 ConversationProjectionStore 与真实
// TopicWireFrameAssembler 验证修复后的完整恢复阶梯。
import { describe, expect, it } from 'vitest'
import { ConversationProjectionStore } from '@zcode/ui/v4/conversationProjectionStore.js'
import type { ConversationTransport } from '@zcode/ui/v4/transport.js'
import { TopicWireFrameAssembler } from '@zcode/shared/zcode-protocol-v4/wire-assembler.js'
import { conversationTopicFrameSchema } from '@zcode/shared/zcode-protocol-v4/transport.js'

const TOPIC = 'conversation/ses_test'
const SUB = 'ocrc-sub-test'

function snapshotPayload(seq: number, rowCount = 1) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    rowId: i + 1,
    turnId: 'turn-1',
    createdAt: 1700000000000,
    createdAtSeq: i + 1,
    kind: 'turnHeader',
    origin: 'userInput',
    state: 'completedSuccess',
    startedAt: 1700000000000,
  }))
  return {
    kind: 'snapshot',
    snapshot: {
      protocolVersion: 1,
      sessionId: 'ses_test',
      logEpoch: 'ocrc-1',
      seq,
      revision: 1,
      control: {
        phase: 'completedSuccess',
        sessionEnded: true,
        canStop: false,
        stopState: 'idle',
        stopTargetKind: 'unknown',
        activeWorks: [],
        lastError: null,
        apiRetry: null,
      },
      availability: {
        fork: { allowed: true },
        compact: { allowed: true },
        switchModelConfig: { allowed: true },
        setFollowupMode: { allowed: true },
        queueEdit: { allowed: true },
        sendQueuedNow: { allowed: true },
        pauseGoal: { allowed: true },
        resumeGoal: { allowed: true },
      },
      inputRouting: { mode: 'startNow' },
      config: { provider: 'p', model: 'm', thought: '', thoughtLevels: [], followupMode: 'queue' },
      usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      queue: { items: [], autoDrain: true },
      pendingInteractions: [],
      pendingCommands: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
      rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    },
  }
}

function wireCandidate(subscriptionId: string, ordinal: number, logicalFrameId: string, payload: any, deliveryKind: string, fromSeq: number, toSeq: number) {
  return {
    wireVersion: 3,
    kind: 'complete',
    deliveryKind,
    logicalFrameId,
    logicalFrameOrdinal: ordinal,
    topic: TOPIC,
    subscriptionId,
    frame: conversationTopicFrameSchema.parse({
      topic: TOPIC,
      subscriptionId,
      fromSeq,
      toSeq,
      sentAt: Date.now(),
      payload,
    }),
  }
}

/** 模拟修复后的 ocrc accessor 行为：单调 ordinal + 如实 ack mode + 对应恢复帧。 */
function makeFixedAccessBehavior() {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema)
  const frameListeners = new Set<(frame: any, ctx?: any) => void>()
  const faultListeners = new Set<(fault: any) => void>()
  let ordinal = 0
  let lastSeq = 0
  let frameId = 0
  const resyncCalls: any[] = []
  const emit = (payload: any, deliveryKind: string, fromSeq: number, toSeq: number) => {
    const wire = wireCandidate(SUB, ++ordinal, `lf-${++frameId}`, payload, deliveryKind, fromSeq, toSeq)
    for (const event of assembler.accept(wire)) {
      if (event.kind === 'complete') {
        for (const l of frameListeners) l(event.frame, { deliveryKind: event.deliveryKind })
      } else {
        for (const l of faultListeners) l(event.fault)
      }
    }
  }
  const transport = {
    subscribe: async () => ({ ack: { subscriptionId: SUB, mode: 'snapshot', logEpoch: 'ocrc-1' } }),
    activate: () => {},
    unsubscribe: async () => {},
    resync: async (params: any) => {
      resyncCalls.push(params)
      if (!params.forceSnapshot && params.base && params.base.seq === lastSeq) {
        emit({ kind: 'deltas', deltas: [] }, 'recovery', params.base.seq, lastSeq)
        return { ack: { subscriptionId: SUB, mode: 'resume', logEpoch: 'ocrc-1' } }
      }
      emit(snapshotPayload(lastSeq), 'recovery', 0, lastSeq)
      return { ack: { subscriptionId: SUB, mode: 'snapshot', logEpoch: 'ocrc-1' } }
    },
    sendCommand: async () => ({}),
    queryCommands: async () => ({ commands: [] }),
    rowsRange: async () => ({ rows: [], totalCount: 0, hasMore: false, firstRowId: null }),
    plans: async () => ({ plans: [] }),
    onFrame: (l: any) => {
      frameListeners.add(l)
      return () => frameListeners.delete(l)
    },
    onAssemblyFault: (l: any) => {
      faultListeners.add(l)
      return () => faultListeners.delete(l)
    },
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport
  return {
    transport,
    resyncCalls,
    faults: faultListeners,
    initial: () => {
      lastSeq = 21
      emit(snapshotPayload(21, 6), 'initial', 0, 21)
    },
    fireFault: (reasonCode: string, deliveryKind = 'recovery') => {
      for (const l of faultListeners)
        l({ topic: TOPIC, subscriptionId: SUB, deliveryKind, reasonCode, logicalFrameOrdinal: ordinal })
    },
  }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

describe('v4 recovery ladder with fixed ocrc accessor contract', () => {
  it('initial snapshot applies, then same-sub recovery settles cleanly', async () => {
    const fx = makeFixedAccessBehavior()
    const store = new ConversationProjectionStore(TOPIC, fx.transport)
    fx.transport.onFrame((frame, ctx) => store.handleFrame(frame, ctx))
    await store.connect()
    fx.initial()
    await settle()
    expect(store.getState().status).toBe('live')
    expect(store.getState().snapshot?.seq).toBe(21)

    store.recoverFromStaleAuthority()
    await settle()
    expect(fx.resyncCalls).toHaveLength(1)
    expect(fx.resyncCalls[0].base).toEqual({ logEpoch: 'ocrc-1', seq: 21 })
    expect(store.getState().status).toBe('live')
    expect(store.getState().lastError).toBeNull()
    await store.close()
  })

  it('fault during in-flight recovery upgrades to forceSnapshot and settles (old code: recoveryFailed)', async () => {
    const fx = makeFixedAccessBehavior()
    const store = new ConversationProjectionStore(TOPIC, fx.transport)
    fx.transport.onFrame((frame, ctx) => store.handleFrame(frame, ctx))
    await store.connect()
    fx.initial()
    await settle()

    // 挂起 resync：模拟 ack 未回时第二个 recovery event 到达（upgradePending 路径）
    let releaseResync: () => void = () => {}
    const gate = new Promise<void>((r) => (releaseResync = r))
    const originalResync = fx.transport.resync
    ;(fx.transport as any).resync = async (params: any) => {
      await gate
      return originalResync(params)
    }

    store.recoverFromStaleAuthority()
    await settle(10)
    fx.fireFault('proto.frameAssemblyOrdinalConflict') // 旧代码正是这个 fault 触发阶梯
    releaseResync()
    await settle(120)

    expect(store.getState().status).toBe('live')
    expect(store.getState().lastError).toBeNull()
    expect(store.getState().snapshot?.seq).toBe(21)
    // 第二次 resync（forceSnapshot）应被发出且如实回 snapshot
    expect(fx.resyncCalls.length).toBeGreaterThanOrEqual(2)
    expect(fx.resyncCalls[1].forceSnapshot).toBe(true)
    await store.close()
  })

  it('regression: old accessor shape (recovery frame reuses ordinal 1 with new id) faults OrdinalConflict', async () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema)
    const initial = wireCandidate(SUB, 1, 'lf-a', snapshotPayload(21, 1), 'initial', 0, 21)
    const events1 = assembler.accept(initial)
    expect(events1.some((e) => e.kind === 'complete')).toBe(true)
    // 旧代码的 recovery 帧：ordinal 仍为 1，但换了新 logicalFrameId
    const brokenRecovery = wireCandidate(SUB, 1, 'lf-b', snapshotPayload(21, 1), 'recovery', 0, 21)
    const events2 = assembler.accept(brokenRecovery)
    expect(events2.some((e) => e.kind === 'fault' && e.fault.reasonCode === 'proto.frameAssemblyOrdinalConflict')).toBe(true)
    // 修复后的形状：ordinal 递增则正常 complete
    const fixedRecovery = wireCandidate(SUB, 2, 'lf-c', snapshotPayload(21, 1), 'recovery', 0, 21)
    const events3 = assembler.accept(fixedRecovery)
    expect(events3.some((e) => e.kind === 'complete' && e.deliveryKind === 'recovery')).toBe(true)
  })
})
