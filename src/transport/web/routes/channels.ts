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
 *
 * 0.27: the panel's credential field is REAL now — entry prefers the panel
 * token over config.env at boot (restart-effective). Credentials are
 * write-only here: GET redacts them to hasToken/tokenHint (the bot token
 * must not round-trip to any browser), and a PATCH carrying credentials is
 * validated against Telegram getMe before it is accepted. `telegramMeta`
 * carries the boot facts the panel cannot derive (env token presence, the
 * allowlist size) for the 绑定信息 line.
 */
export function registerChannels(
  app: Hono,
  channels?: ChannelsStore,
  tgStatus?: () => TelegramLiveStatus | null,
  telegramMeta?: { hasEnvToken: boolean; allowUsers: number },
) {
  if (!channels) return

  app.get('/api/channels', (c) => {
    const status = tgStatus?.() ?? null
    return c.json({
      channels: channels.list().map((b) => ({
        ...b,
        credentials: undefined,
        hasToken: !!b.credentials?.token,
        tokenHint: b.credentials?.token ? `••••${b.credentials.token.slice(-4)}` : undefined,
        live: b.channel === 'telegram' && status ? { connected: status.connected, username: status.username } : null,
      })),
      telegram: {
        // Panel token wins over config.env at boot — mirror that here live.
        tokenSource: channels.get('tg-default')?.credentials?.token ? 'panel' : telegramMeta?.hasEnvToken ? 'env' : 'none',
        allowUsers: telegramMeta?.allowUsers ?? 0,
      },
    })
  })

  /** Validate a draft bot token against Telegram before accepting it. */
  async function validateBotToken(token: string): Promise<{ ok: boolean; description?: string; networkError?: boolean }> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, {
        signal: AbortSignal.timeout(8000),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
      if (body.ok) return { ok: true }
      return { ok: false, description: body.description ?? `HTTP ${res.status}` }
    } catch (err) {
      // Unreachable network is NOT proof of a bad token — allow the save with
      // a warning instead of blocking an air-gapped-but-valid setup.
      return { ok: false, description: (err as Error).message, networkError: true }
    }
  }

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

    let warning: string | undefined
    const patch = { ...body }
    const draftToken = body.credentials?.token
    if (typeof draftToken === 'string' && draftToken.trim()) {
      const verdict = await validateBotToken(draftToken.trim())
      if (!verdict.ok && !verdict.networkError) {
        return c.json({ error: `Telegram 拒绝了这个 token：${verdict.description ?? '验证失败'}` }, 400)
      }
      if (verdict.networkError) {
        warning = `无法连通 Telegram 验证 token（${verdict.description}）——已保存，重启后若无效请重试`
      }
      patch.credentials = { token: draftToken.trim() }
    }

    const updated = channels.update(c.req.param('id'), patch)
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({
      channel: { ...updated, credentials: undefined, hasToken: !!updated.credentials?.token },
      ...(warning ? { warning } : {}),
    })
  })

  app.post('/api/channels/:id/reset', (c) => {
    const updated = channels.reset(c.req.param('id'))
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({ channel: { ...updated, credentials: undefined, hasToken: false } })
  })
}
