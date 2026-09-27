import type { Hono } from 'hono'
import type { ChannelsStore, ReplyGranularity, WorkspaceScope } from '../../../core/channels.js'

export interface TelegramLiveStatus {
  connected: boolean
  username?: string
}

/**
 * M9: bot-channel settings — list + update. `tgStatus` (injected by entry)
 * reports the live Telegram polling state so the web panel can show
 * connected/未绑定 like the ZCode reference.
 */
export function registerChannels(
  app: Hono,
  channels?: ChannelsStore,
  tgStatus?: () => TelegramLiveStatus | null,
) {
  if (!channels) return

  app.get('/api/channels', (c) => {
    const status = tgStatus?.() ?? null
    return c.json({
      channels: channels.list().map((b) => ({
        ...b,
        live: b.channel === 'telegram' && status ? { connected: status.connected, username: status.username } : null,
      })),
    })
  })

  app.patch('/api/channels/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean
      replyGranularity?: ReplyGranularity
      workspaces?: WorkspaceScope
      credentials?: Record<string, string>
    }
    if (body.replyGranularity && body.replyGranularity !== 'standard' && body.replyGranularity !== 'detailed') {
      return c.json({ error: 'replyGranularity must be standard|detailed' }, 400)
    }
    if (body.workspaces && body.workspaces.mode !== 'all' && body.workspaces.mode !== 'custom') {
      return c.json({ error: 'invalid workspaces' }, 400)
    }
    const updated = channels.update(c.req.param('id'), body)
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({ channel: updated })
  })

  app.post('/api/channels/:id/reset', (c) => {
    const updated = channels.reset(c.req.param('id'))
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({ channel: updated })
  })

  // Pairing QR — the pair URL carries the token in its fragment, so this is
  // only ever rendered inside an already-paired session (same trust model as
  // TG's /pair command).
  app.get('/api/pair/qr', async (c) => {
    try {
      const { buildPairContext } = await import('../../../connectivity/pairing.js')
      const QRCode = (await import('qrcode')).default
      const { token, url } = await buildPairContext()
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1 })
      return c.json({ url, svg })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })
}
