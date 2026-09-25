/**
 * ControlPlane — the seam that narrows host (opencode V1 vs V2) differences to
 * one interface (development plan §7.2). The core (relay, CardBus, transports,
 * push) is host-agnostic; each host adapter provides:
 *
 *   - an AgentBackend implementing host operations over the host's own API
 *   - a normalized event feed (V1 events — the shapes core consumers speak)
 *   - the few host-only extras (serverUrl for TUI navigation, session lookup
 *     for the TUI-selected-session poll, the V1 plugin event hook)
 *
 * Event shapes: V2 events are renamed/reshaped (permission.asked
 * {action,resources} vs V1 {permission,patterns}; session.execution.* vs
 * session.status). Adapters translate INTO V1 shapes so the core consumers
 * never change (docs/v2-api-notes.md §4).
 */
import type { AgentBackend, PermissionDecision } from '../core/agent/backend.js'
import type { OcEvent } from '../core/opencode-events.js'
import { createOpencodeBackend } from '../core/agent/opencode-backend.js'
import { startGlobalEvents } from '../opencode/global-events.js'
import { createV2Backend } from '../core/agent/v2-backend.js'
import { createV2EventMapper } from './v2/event-map.js'
import type { V2Context } from './v2/types.js'

/** Minimal structural view of the V1 plugin context we consume. */
export interface V1Context {
  serverUrl: URL | string
  client: any
  worktree?: string
  [key: string]: unknown
}

export interface ControlPlane {
  /** Host server base URL when the host exposes one (V1). Used for TUI navigation. */
  readonly serverUrl?: string
  /** The directory this instance runs in (V1 worktree / V2 location.directory). */
  readonly directory?: string
  readonly backend: AgentBackend
  /** V1-only: session lookup for the TUI-selected-session poll. */
  getSession?(id: string): Promise<{ agent?: string } | undefined>
  /**
   * Wire the host's event stream(s) into dispatch; returns a stop fn.
   *  - V1: the /global/event SSE for OTHER workspaces (own-workspace events
   *    arrive via the plugin `event` hook — see eventHook()).
   *  - V2: ctx.event.subscribe mapped to V1 shapes for ALL workspaces (V2 has
   *    no plugin event hook).
   */
  wireEvents(dispatchEvent: (ev: OcEvent) => Promise<void>): () => void
  /** V1-only: build the plugin `event` hook (host pushes own-workspace events). */
  eventHook?(dispatchEvent: (ev: OcEvent) => Promise<void>): (args: { event: unknown }) => Promise<void>
}

export function createV1ControlPlane(ctx: V1Context): ControlPlane {
  const serverUrl = ctx.serverUrl.toString().replace(/\/+$/, '')
  const backend = createOpencodeBackend({ client: ctx.client, baseUrl: serverUrl })
  return {
    serverUrl,
    directory: ctx.worktree,
    backend,
    async getSession(id: string) {
      const res = await ctx.client.session.get({ path: { id } })
      return res?.data as { agent?: string } | undefined
    },
    wireEvents(dispatchEvent) {
      // The pulled /global/event SSE connects but does NOT reliably deliver
      // events inside opencode's plugin worker (verified at runtime), whereas
      // the plugin `event` hook — opencode PUSHING events — works. So the hook
      // is the primary dispatch source for THIS workspace; the global stream is
      // best-effort for OTHER workspaces only (directory !== worktree), which
      // also prevents double-processing.
      const globalEvents = startGlobalEvents({
        client: ctx.client,
        onEvent: (ev, directory) => {
          if (directory && ctx.worktree && directory !== ctx.worktree) void dispatchEvent(ev)
        },
      })
      return () => globalEvents.stop()
    },
    eventHook(dispatchEvent) {
      return async ({ event }) => {
        await dispatchEvent(event as unknown as OcEvent)
      }
    },
  }
}

export function createV2ControlPlane(ctx: V2Context): ControlPlane {
  const { backend, observeSessionEvent } = createV2Backend(ctx)
  const mapper = createV2EventMapper()
  return {
    directory: ctx.location?.directory,
    backend,
    wireEvents(dispatchEvent) {
      // V2 has no plugin event hook: everything arrives via the async event
      // iterator. Map V2Event → V1 shapes, feed the session registry, and
      // dispatch — the same dispatchEvent the V1 hook path uses.
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              const ev = raw as any
              const sid = ev?.data?.sessionID
              if (typeof sid === 'string') {
                observeSessionEvent({
                  type: ev.type,
                  sessionID: sid,
                  title: ev?.data?.title ?? (ev?.data?.info?.title ?? undefined),
                })
              }
              for (const mapped of mapper.map(ev)) {
                await dispatchEvent(mapped)
              }
            } catch (err) {
              // one bad event must not kill the loop
            }
          }
        } catch (err) {
          if (!controller.signal.aborted) throw err
        }
      })()
      return () => controller.abort()
    },
  }
}
