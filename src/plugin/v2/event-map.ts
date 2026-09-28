/**
 * V2 event → V1 event (OcEvent) mapping.
 *
 * This is the "V2 入口映射" from the development plan (§7.3): the core
 * consumers (relay normalizer, push engine, Telegram permission handlers)
 * keep speaking the V1 event shapes; V2's renamed/reshaped events are
 * translated HERE and nowhere else.
 *
 * Field renames handled (confirmed against @opencode-ai/client beta types):
 *   permission.asked  data.{action, resources}  → properties.{permission, patterns}
 *   session.execution.{started,succeeded,failed,interrupted} → session.status / session.error / session.idle
 *   session.text|reasoning|tool.* granular stream → message.part.updated / message.part.delta
 *
 * Tool NAME only rides on `session.tool.input.started`; the called/success/
 * failed events carry just the call id — so names are tracked in a registry
 * keyed by tool-call id (pruned on success/failure).
 */
import type { OcEvent } from '../../core/opencode-events.js'
import type { V2Event } from './types.js'

export interface V2EventMapper {
  /** Map one raw V2 event into 0..n V1-shaped OcEvents. */
  map(raw: V2Event): OcEvent[]
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function createV2EventMapper(): V2EventMapper {
  /** tool-call id → tool name (from session.tool.input.started). */
  const toolNames = new Map<string, string>()

  return {
    map(raw: V2Event): OcEvent[] {
      const type = raw?.type
      if (!type) return []
      const d = (raw.data ?? {}) as NonNullable<V2Event['data']>
      const sid = typeof d.sessionID === 'string' ? d.sessionID : undefined

      switch (type) {
        // ── permissions (field renames) ─────────────────────────────────────
        case 'permission.asked':
          if (!sid || !d.id) return []
          return [{
            type: 'permission.asked',
            properties: {
              id: d.id,
              sessionID: sid,
              permission: d.action,
              patterns: d.resources,
              title: d.action,
              args: d.metadata,
              metadata: d.metadata,
            },
          }]
        case 'permission.replied':
          if (!d.requestID && !d.id) return []
          return [{
            type: 'permission.replied',
            properties: {
              permissionID: d.requestID ?? d.id,
              requestID: d.requestID ?? d.id,
              sessionID: sid,
              response: d.reply,
              reply: d.reply,
            },
          }]

        // ── streaming: text ──────────────────────────────────────────────────
        case 'session.text.delta': {
          if (!sid || !d.assistantMessageID || typeof d.ordinal !== 'number' || typeof d.delta !== 'string') return []
          return [{
            type: 'message.part.delta',
            properties: {
              sessionID: sid,
              messageID: d.assistantMessageID,
              partID: `${d.assistantMessageID}:${d.ordinal}`,
              field: 'text',
              delta: d.delta,
            },
          }]
        }
        case 'session.text.ended': {
          if (!sid || !d.assistantMessageID || typeof d.ordinal !== 'number') return []
          return [{
            type: 'message.part.updated',
            properties: {
              sessionID: sid,
              part: {
                id: `${d.assistantMessageID}:${d.ordinal}`,
                type: 'text',
                text: typeof d.text === 'string' ? d.text : '',
                messageID: d.assistantMessageID,
                sessionID: sid,
              },
            },
          }]
        }

        // ── streaming: tools (name from input.started registry) ─────────────
        case 'session.tool.input.started': {
          if (!sid || !d.id) return []
          if (typeof d.name === 'string') {
            toolNames.set(d.id, d.name)
            if (toolNames.size > 500) {
              // bound the registry; oldest entries are long-finished calls
              const first = toolNames.keys().next().value
              if (first !== undefined) toolNames.delete(first)
            }
          }
          const name = (typeof d.name === 'string' ? d.name : undefined) ?? toolNames.get(d.id) ?? 'tool'
          return [{
            type: 'message.part.updated',
            properties: {
              sessionID: sid,
              part: { id: d.id, type: 'tool', tool: name, messageID: d.assistantMessageID, sessionID: sid, state: { status: 'running', input: {} } },
            },
          }]
        }
        case 'session.tool.called': {
          if (!sid || !d.id) return []
          return [{
            type: 'message.part.updated',
            properties: {
              sessionID: sid,
              part: { id: d.id, type: 'tool', tool: d.id ? toolNames.get(d.id) ?? 'tool' : 'tool', messageID: d.assistantMessageID, sessionID: sid, state: { status: 'running', input: d.input ?? {} } },
            },
          }]
        }
        case 'session.tool.success': {
          if (!sid || !d.id) return []
          return [{
            type: 'message.part.updated',
            properties: {
              sessionID: sid,
              part: { id: d.id, type: 'tool', tool: toolNames.get(d.id) ?? 'tool', messageID: d.assistantMessageID, sessionID: sid, state: { status: 'done', input: {}, output: textOfContent(d.content) } },
            },
          }]
        }
        case 'session.tool.failed': {
          if (!sid || !d.id) return []
          const message = d.error?.message ?? 'tool failed'
          return [{
            type: 'message.part.updated',
            properties: {
              sessionID: sid,
              part: { id: d.id, type: 'tool', tool: toolNames.get(d.id) ?? 'tool', messageID: d.assistantMessageID, sessionID: sid, state: { status: 'error', input: {}, output: message } },
            },
          }]
        }

        // ── turn lifecycle ───────────────────────────────────────────────────
        case 'session.idle':
          if (!sid) return []
          return [{ type: 'session.idle', properties: { sessionID: sid } }]
        case 'session.execution.started':
          if (!sid) return []
          return [{ type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } }]
        case 'session.execution.succeeded':
        case 'session.execution.interrupted':
          if (!sid) return []
          return [{ type: 'session.idle', properties: { sessionID: sid } }]
        case 'session.execution.failed': {
          if (!sid) return []
          const message = d.error?.message
          const out: OcEvent[] = [{ type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } }]
          if (message) out.push({ type: 'session.error', properties: { sessionID: sid, error: { message } } })
          return out
        }

        // ── session registry feeders (web/TG session lists) ──────────────────
        case 'session.created':
          if (!sid) return []
          return [{
            type: 'session.created',
            properties: { sessionID: sid, info: { id: sid, sessionID: sid, directory: raw.location?.directory } },
          }]
        case 'session.deleted':
          if (!sid) return []
          return [{ type: 'session.deleted', properties: { sessionID: sid } }]

        // ── interactive questions: V2 payloads are field-identical to V1 ─────
        case 'question.v2.asked': {
          const q = d as any
          return (q?.id && q?.questions) ? [{ type: 'question.asked', properties: q }] : []
        }
        case 'question.v2.replied': {
          const q = d as any
          return (sid && q?.requestID) ? [{ type: 'question.replied', properties: q }] : []
        }
        case 'question.v2.rejected': {
          const q = d as any
          return (sid && q?.requestID) ? [{ type: 'question.rejected', properties: q }] : []
        }

        // Everything else (usage, vcs, mcp, pty, ...) is not core-relevant yet.
        default:
          return []
      }
    },
  }
}
