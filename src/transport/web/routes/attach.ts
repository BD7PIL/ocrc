import type { Hono } from 'hono'
import type { CardBus } from '../../../core/card-bus.js'
import { getVersionInfo } from '../../../utils/version.js'

/**
 * P0-3: the host channel an ATTACHED ocrc plugin talks to.
 *
 * When the standalone host owns the primary lock (`role: 'host'`), an ocrc plugin
 * loaded inside the engine the host spawned/adopted must NOT build its own
 * transports (that would double-bind the web port and fight over the Telegram
 * poller). It registers tools instead, and every tool implementation is a thin
 * HTTP call to these endpoints. That is also why the tools are idempotent and
 * carry no per-instance state: opencode keeps duplicate tool names on the list
 * and lets the last registration win at the model face (see
 * docs/workflow-p0-tool-registration.md), so whichever instance's copy is called
 * must behave identically — the host assigns ids, not the plugin.
 *
 * All of these sit behind the normal `/api/*` token guard.
 */
export interface AttachDeps {
  cardBus: CardBus
  /** Host mode marker reported to `rc-status` (always 'host' here). */
  telegramStatus?: () => { connected: boolean; username?: string } | null
  /** Web port the host listens on, reported back to the plugin. */
  webPort: number
  /** Probe tools are opt-in: `OCRC_WF_PROBE=1` (P0 gate only). */
  probe: boolean
}

/** Host-assigned run ids for the echo probe: process-local counter + pid, so the
 *  value proves the round trip went through the host and not the plugin. */
let echoSeq = 0

export function registerAttach(app: Hono, deps: AttachDeps) {
  /** `rc-status` in ATTACHED mode: the host owns everything, so report the host. */
  app.get('/api/attach/status', (c) => {
    const v = getVersionInfo()
    const tg = deps.telegramStatus?.() ?? null
    return c.json({
      version: v.version,
      mode: 'host',
      pid: process.pid,
      webPort: deps.webPort,
      telegram: tg ? { connected: tg.connected, username: tg.username } : null,
      uptimeSeconds: Math.round(process.uptime()),
    })
  })

  /** `notify`: publish an info card on the HOST's bus (the plugin has none). */
  app.post('/api/attach/notify', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; sessionId?: string }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) return c.json({ error: 'message required' }, 400)
    deps.cardBus.publish({
      kind: 'info',
      title: 'Notification',
      sections: [{ body: `🔔 ${message}` }],
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    })
    return c.json({ ok: true })
  })

  if (!deps.probe) return

  /** P0 gate probe: proves the tool → host round trip and that the HOST assigns
   *  the run id (the plugin sends no id of its own). */
  app.post('/api/attach/echo', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: string }
    const runId = `host-${process.pid}-${++echoSeq}`
    return c.json({ ok: true, value: typeof body.value === 'string' ? body.value : '', runId, hostPid: process.pid })
  })
}
