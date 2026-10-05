import { randomBytes } from 'node:crypto'
import { buildPairCard, buildPairContext } from '../connectivity/pairing.js'

/**
 * `ocrc pair` — print the pairing QR + link.
 *
 * `--reset` — revoke EVERY paired device first: generates a fresh web token
 * and persists it over `~/.ocrc/token`. Running hosts pick the new token up
 * per-request (mtime check), so old devices 401 on their next call. Then
 * prints the fresh QR to re-pair. A token supplied via WEB_TOKEN config is
 * NOT rotated (config wins on every boot) — told to rotate it there instead.
 */
export async function main(args: string[] = []): Promise<void> {
  if (args.includes('--reset')) {
    if (process.env.WEB_TOKEN?.trim()) {
      console.error('令牌来自 WEB_TOKEN 配置 —— 请在配置中轮换；文件轮换会在下次启动被配置覆盖，已跳过。')
      process.exit(1)
    }
    const { ocrcHome } = await import('../utils/paths.js')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const token = randomBytes(32).toString('base64url')
    const path = join(ocrcHome(), 'token')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token, { mode: 0o600 })
    console.log(`Token rotated at ${path} — all paired devices are revoked (they will be asked to re-pair).`)
  }
  const { token, url } = await buildPairContext()
  const card = await buildPairCard(url, token)
  console.log(card.qr)
  console.log(card.lines.join('\n'))
}

if (process.argv[1]?.endsWith('pair.js') || process.argv[1]?.endsWith('pair.ts')) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1) })
}
