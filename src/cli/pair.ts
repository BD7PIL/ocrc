import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { buildPairCard, buildPairContext } from '../connectivity/pairing.js'
import { loadOrCreateToken } from '../connectivity/auth/token.js'

/**
 * `ocrc pair` — the remote-control session CLI (ZCode v3.15.1 pairing
 * semantics, LAN direct — no relay).
 *
 *  (no args)  Start/refresh the remote-control session and print the pending
 *             QR. The session lives in the RUNNING host's memory, so this
 *             drives it over the loopback management endpoint; the printed
 *             link carries a `#pair=` PENDING token — devices exchange it for
 *             a session credential that dies on refresh/stop. The permanent
 *             anchor token never appears here.
 *  --stop     Close the session: every session-paired phone is kicked.
 *  --reset    Rotate the ANCHOR token (revokes desktop anchor devices AND —
 *             because the session dies with it — phones). WEB_TOKEN config is
 *             not touched; told to rotate it there instead.
 *
 * Session management talks to the host on 127.0.0.1:WEB_PORT — the endpoints
 * are loopback-only, matching the panel's own console-only rule.
 */

const SESSION_ENDPOINTS: Record<string, string> = {
  '': '/api/pair/session/start',
  '--stop': '/api/pair/session/stop',
}

export async function main(args: string[] = []): Promise<void> {
  const { ocrcHome } = await import('../utils/paths.js')
  const webPort = process.env.OCRC_WEB_PORT ?? process.env.WEB_PORT ?? '4099'

  if (args.includes('--reset')) {
    if (process.env.WEB_TOKEN?.trim()) {
      console.error('令牌来自 WEB_TOKEN 配置 —— 请在配置中轮换；文件轮换会在下次启动被配置覆盖，已跳过。')
      process.exit(1)
    }
    const token = randomBytes(32).toString('base64url')
    const path = join(ocrcHome(), 'token')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token, { mode: 0o600 })
    console.log(`Token rotated at ${path} — anchor devices are revoked (they will need a fresh ocrc start link).`)
    // Best-effort: tell the RUNNING host to drop the session too (this is a
    // separate process — the rotation alone only reaches it via the token-file
    // stamp, which anchors pick up per-request but does not close the gate).
    // The session routes sit behind the auth guard, so ride the FRESH token
    // (just written above; the host picks it up via the file stamp).
    try {
      await fetch(`http://127.0.0.1:${webPort}/api/pair/session/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    } catch { /* host not running — nothing to stop */ }
    console.log('The remote-control session was closed too (its phones die with the anchor rotation).')
    // Fall through to print the fresh anchor card below — the immediate
    // re-pair surface, same as before.
    const ctx = await buildPairContext()
    const card = await buildPairCard(ctx.url, token)
    console.log(card.qr)
    console.log(card.lines.join('\n'))
    return
  }

  const endpoint = SESSION_ENDPOINTS[args.includes('--stop') ? '--stop' : '']
  // The session routes sit behind the auth guard (authed, loopback-only) —
  // this CLI runs ON the host, so it rides the anchor token file.
  const anchorToken = loadOrCreateToken({})
  const res = await fetch(`http://127.0.0.1:${webPort}${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${anchorToken}` },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.status === 409) {
      console.error('此实例的认证方式（CF Access）不支持远控会话。')
    } else if (res.status === 403) {
      console.error('远控会话管理仅限主机本机（loopback）——请在主机上运行 ocrc pair。')
    } else {
      console.error(`远控会话${args.includes('--stop') ? '停止' : '开启'}失败（HTTP ${res.status}）: ${body.error ?? 'host 未在运行?'}`)
    }
    process.exit(1)
  }
  const status = (await res.json()) as { active: boolean; epoch: number; paired: number }

  if (args.includes('--stop')) {
    console.log(`Remote-control session stopped (epoch ${status.epoch}) — session-paired devices are kicked.`)
    console.log('Anchor devices (desktop #token= links) are NOT affected.')
    return
  }

  // Session live → fetch the pending QR from the (authless) onboarding surface.
  console.log(`Remote-control session ${status.epoch > 1 && status.paired >= 0 ? 'refreshed' : 'started'} — scan to join:`)
  const { qrPendingFromOnboarding } = await import('./pair-qr.js')
  const qr = await qrPendingFromOnboarding(Number(webPort))
  if (qr) {
    console.log(qr)
    console.log([
      '手机扫码或打开链接进入：拿到的是会话凭证（内存态，主机重启即清）。',
      '会话刷新（再跑 ocrc pair）即踢全部手机；ocrc pair --stop 停会话；ocrc pair --reset 轮换锚 token。',
      '桌面锚设备用 ocrc start 打印的 #token= 链接，不受本会话刷新/停止影响。',
    ].join('\n'))
  }
}

if (process.argv[1]?.endsWith('pair.js') || process.argv[1]?.endsWith('pair.ts')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1) })
}
