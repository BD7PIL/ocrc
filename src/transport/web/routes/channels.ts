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
  telegramMeta?: { hasEnvToken: boolean; allowUsers: number; envTokenHint?: string },
) {
  if (!channels) return

  /** Every credential value is write-only: the panel sees a last-4 hint. */
  function redactedCredentials(b: { credentials?: Record<string, string> }): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(b.credentials ?? {})) {
      if (v) out[k] = `••••${v.slice(-4)}`
    }
    return out
  }

  app.get('/api/channels', (c) => {
    const status = tgStatus?.() ?? null
    const tg = channels.get('tg-default')
    // Effective allowlist follows the boot precedence: panel value (when
    // non-empty) wins over the env allowlist.
    const panelAllow = tg?.allowUsers?.length ? tg.allowUsers : undefined
    return c.json({
      channels: channels.list().map((b) => ({
        ...b,
        credentials: redactedCredentials(b),
        hasToken: !!b.credentials?.token,
        tokenHint: b.credentials?.token ? `••••${b.credentials.token.slice(-4)}` : undefined,
        live: b.channel === 'telegram' && status ? { connected: status.connected, username: status.username } : null,
      })),
      telegram: {
        // Panel token wins over config.env at boot — mirror that here live.
        tokenSource: tg?.credentials?.token ? 'panel' : telegramMeta?.hasEnvToken ? 'env' : 'none',
        allowSource: panelAllow ? 'panel' : 'env',
        allowUsers: (panelAllow?.length ?? telegramMeta?.allowUsers) ?? 0,
        // Bot API proxy egress source, same precedence the transport applies at boot:
        // panel credential > TELEGRAM_PROXY > HTTPS_PROXY > https_proxy.
        proxySource: tg?.credentials?.proxy
          ? 'panel'
          : (process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy)
            ? 'env'
            : 'none',
        // Masked hint for an env-sourced token (the panel credential already
        // shows its own tokenHint on the row) — write-only, last 4 only.
        envTokenHint: !tg?.credentials?.token && telegramMeta?.hasEnvToken ? telegramMeta.envTokenHint : undefined,
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
      allowUsers?: unknown
    }
    if (body.replyGranularity && body.replyGranularity !== 'standard' && body.replyGranularity !== 'detailed') {
      return c.json({ error: 'replyGranularity must be standard|detailed' }, 400)
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }
    if (body.workspaces && body.workspaces.mode !== 'all' && body.workspaces.mode !== 'custom') {
      return c.json({ error: 'invalid workspaces' }, 400)
    }

    let allowUsers: number[] | undefined
    if (body.allowUsers !== undefined) {
      if (!Array.isArray(body.allowUsers)) {
        return c.json({ error: 'allowUsers must be an array of numeric Telegram user ids' }, 400)
      }
      const bad = body.allowUsers.find((n) => typeof n !== 'number' || !Number.isInteger(n) || n <= 0)
      if (bad !== undefined) {
        return c.json({ error: `allowUsers 含非法 id：${JSON.stringify(bad)}（必须是正整数）` }, 400)
      }
      if (body.allowUsers.length > 50) {
        return c.json({ error: 'allowUsers 上限 50 个' }, 400)
      }
      allowUsers = [...new Set(body.allowUsers)]
    }

    let warning: string | undefined
    // Assemble explicitly — body.allowUsers is unvalidated `unknown` and must
    // reach the store only through the sanitized `allowUsers` below.
    const patch: Parameters<ChannelsStore['update']>[1] = {}
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.replyGranularity !== undefined) patch.replyGranularity = body.replyGranularity
    if (body.workspaces !== undefined) patch.workspaces = body.workspaces
    // Credentials: persist ANY object — non-telegram channels carry
    // app_id/secrets (OCR review: they were silently dropped before). The
    // TELEGRAM token additionally gets live getMe validation, and only on
    // the tg-default binding.
    if (body.credentials !== undefined && typeof body.credentials === 'object') {
      const cleaned: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.credentials)) {
        if (typeof v === 'string' && v.trim()) cleaned[k] = v.trim()
      }
      if (Object.keys(cleaned).length > 0) patch.credentials = cleaned
      if (typeof cleaned.token === 'string' && c.req.param('id') === 'tg-default') {
        const verdict = await validateBotToken(cleaned.token)
        if (!verdict.ok && !verdict.networkError) {
          return c.json({ error: `Telegram 拒绝了这个 token：${verdict.description ?? '验证失败'}` }, 400)
        }
        if (verdict.networkError) {
          warning = `无法连通 Telegram 验证 token（${verdict.description}）——已保存，重启后若无效请重试`
        }
      }
    }

    const updated = channels.update(c.req.param('id'), allowUsers !== undefined ? { ...patch, allowUsers } : patch)
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({
      channel: { ...updated, credentials: redactedCredentials(updated), hasToken: !!updated.credentials?.token },
      ...(warning ? { warning } : {}),
    })
  })

  app.post('/api/channels/:id/reset', (c) => {
    const updated = channels.reset(c.req.param('id'))
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({ channel: { ...updated, credentials: redactedCredentials(updated), hasToken: !!updated.credentials?.token } })
  })
}
