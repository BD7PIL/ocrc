// tool-stream-bridge.ts — wires the ported-but-never-connected grinev live
// tool-card modules (ToolCallStreamer + RunningToolTracker) into ocrc's
// CardBus flow.
//
// Streaming cards carry tool blocks keyed by partId with relay-mapped status.
// The bridge renders each tool as one plain-text line in a live message
// (ToolCallStreamer owns throttled send/edit/delete), and RunningToolTracker
// drives elapsed-time suffixes on its own interval — a tool that blocks
// without emitting output still visibly ticks. `standard` granularity hides
// the tool process entirely (ZCode 标准回复); `detailed` streams the card.

import type { Api } from 'grammy'
import { ToolCallStreamer } from './streaming/tool-call-streamer.js'
import { RunningToolTracker } from './streaming/running-tool-tracker.js'
import {
  appendDuration,
  formatDuration,
  RUNNING_ICON,
  TOOL_ELAPSED_THRESHOLD_MS,
} from './streaming/duration-formatter.js'
import { getSessionStreamThrottleMs } from './streaming/stream-throttle.js'
import type { StructuredCard } from '../../core/structured-card.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('tg-tools')

/** TG API calls must never hang the bridge (same posture as streaming-render). */
function withTimeout<T>(p: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('telegram call timeout')), ms))])
}

const DONE_ICON = '✅'
const ERROR_ICON = '❌'
const MAX_ARGS = 80

interface ToolInput {
  tool: string
  args: string
  status: 'running' | 'done' | 'error'
}

export interface ToolStreamBridgeDeps {
  api: Api
  chatId: string
  /** standard = no tool card at all; detailed = live tool card. */
  granularity: () => 'standard' | 'detailed'
}

export class ToolStreamBridge {
  private readonly streamer: ToolCallStreamer
  private readonly tracker: RunningToolTracker
  /** sessionId → partId → the block's current shape (lines are formatted on demand). */
  private readonly inputs = new Map<string, Map<string, ToolInput>>()

  constructor(private readonly deps: ToolStreamBridgeDeps) {
    this.streamer = new ToolCallStreamer({
      throttleMs: (sessionId) => getSessionStreamThrottleMs(sessionId),
      sendText: async (_sessionId, text) => {
        const res = await withTimeout(deps.api.sendMessage(deps.chatId, text, {
          parse_mode: undefined,
          link_preview_options: { is_disabled: true },
        } as any))
        return res.message_id
      },
      editText: async (_sessionId, messageId, text) => {
        try {
          await withTimeout(deps.api.editMessageText(deps.chatId, messageId, text, {
            parse_mode: undefined,
            link_preview_options: { is_disabled: true },
          } as any))
        } catch (err) {
          if (!(err as Error)?.message?.includes('message is not modified')) throw err
        }
      },
      deleteText: async (_sessionId, messageId) => {
        await withTimeout(deps.api.deleteMessage(deps.chatId, messageId)).catch(() => {})
      },
    })
    this.tracker = new RunningToolTracker({
      thresholdMs: TOOL_ELAPSED_THRESHOLD_MS,
      tickIntervalMs: 1000,
      maxTrackingMs: 15 * 60_000,
      onTick: (tick) => this.onTrackerTick(tick),
      // No heartbeat: the streaming card itself proves turn liveness here.
      onHeartbeat: () => {},
    })
  }

  /** Feed one `streaming` card: diff its tool blocks into the live card. */
  onStreamingCard(card: Extract<StructuredCard, { kind: 'streaming' }>): void {
    if (this.deps.granularity() !== 'detailed') return
    const sid = card.sessionId
    let map = this.inputs.get(sid)
    if (!map) {
      map = new Map()
      this.inputs.set(sid, map)
    }

    const seen = new Set<string>()
    for (const b of card.blocks) {
      if (b.type !== 'tool' || !b.partId) continue
      seen.add(b.partId)
      const input: ToolInput = { tool: b.tool, args: b.args ?? '', status: b.status }
      const prev = map.get(b.partId)
      if (prev && prev.status === input.status && prev.args === input.args && prev.tool === input.tool) continue

      map.set(b.partId, input)
      if (b.status === 'running') {
        this.tracker.track(sid, b.partId)
        this.streamer.replaceByPrefix(sid, b.partId, this.formatLine(input))
      } else {
        // Release BEFORE formatting so the final line carries the duration.
        const elapsed = this.tracker.release(b.partId)
        this.streamer.replaceByPrefix(sid, b.partId, this.formatLine(input, elapsed))
      }
    }

    // Tool parts that dropped out of the card (retractions) lose their line.
    for (const partId of [...map.keys()]) {
      if (!seen.has(partId)) {
        map.delete(partId)
        this.tracker.release(partId)
        this.streamer.removeByPrefix(sid, partId)
      }
    }
  }

  /** Turn ended: flush the final tool state into the record message and stop. */
  async onTurnEnd(sessionId: string): Promise<void> {
    this.tracker.clearSession(sessionId, 'turn-end')
    this.inputs.delete(sessionId)
    if (this.deps.granularity() !== 'detailed') return
    try {
      await this.streamer.breakSession(sessionId, 'turn-end')
    } catch (err) {
      log.warn(`[${sessionId}] tool stream flush failed`, err as Error)
    }
  }

  dispose(): void {
    this.tracker.clearAll('dispose')
    this.streamer.clearAll('dispose')
    this.inputs.clear()
  }

  private onTrackerTick(tick: { sessionId: string; callId: string; elapsedMs: number; isFinal: boolean }): void {
    const input = this.inputs.get(tick.sessionId)?.get(tick.callId)
    if (!input || input.status !== 'running') return
    this.streamer.replaceByPrefix(
      tick.sessionId,
      tick.callId,
      this.formatLine(input, tick.elapsedMs),
    )
  }

  private formatLine(input: ToolInput, elapsedMs?: number): string {
    const icon = input.status === 'error' ? ERROR_ICON : input.status === 'done' ? DONE_ICON : RUNNING_ICON
    let text = `${icon} ${input.tool}`
    if (input.args) text += ` · ${input.args.slice(0, MAX_ARGS)}`
    if (elapsedMs !== undefined && elapsedMs >= TOOL_ELAPSED_THRESHOLD_MS) {
      text = appendDuration(text, formatDuration(elapsedMs))
    }
    return text
  }
}
