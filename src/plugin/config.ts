import { config as dotenvConfig } from 'dotenv'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../utils/logger.js'
import { ocrcHome } from '../utils/paths.js'

const log = createLogger('config')

export interface PluginConfig {
  telegramBotToken: string
  allowedUserIds: number[]
  webEnabled: boolean
  webHost: string
  webPort: number
  webPublicUrl: string
  webStaticRoot: string
  webCacheSize: number
  webCfAccessTeam: string
  webCfAccessAud: string
  webCfAccessDevBypass: boolean
  webCfAccessDevEmail: string
  webAuth: 'token' | 'cf-access'
  webToken: string
  statePath: string
  tuiVisible: boolean
  transport: string
  chatTimeoutMs: number
  baseUrl: string
  tgChunkSoftLimit: number
  /** Standalone host only: the ACP agent to spawn, e.g. "kimi acp" / "gemini --acp". */
  acpCommand: string
  /**
   * Standalone host multi-backend spec (overrides acpCommand when set). Comma-
   * separated entries: `opencode` (spawns its own opencode server) or
   * `<id>=<acp command>` (e.g. `kimi=kimi acp`). Example:
   * `OCRC_BACKENDS="opencode, kimi=kimi acp"`.
   */
  backends: string
}

// Repo root resolved from this module's OWN location (<repo>/dist/plugin/config.js,
// or <repo>/src/plugin/config.ts in dev — both two levels below the root). The
// plugin is registered globally, so opencode can be launched from any folder;
// resolving .env and bundled web assets against this constant instead of cwd is
// what keeps it working regardless of the launch directory.
const PLUGIN_ROOT = (() => {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  } catch {
    return process.cwd()
  }
})()

// dotenv never overrides an already-set variable, so the FIRST file loaded
// wins. The plugin's own install directory is authoritative: opencode can be
// launched from any folder, and a project-level .env must not be able to
// hijack the bot identity / allowlist / web token. cwd is loaded LAST (lowest
// priority — it can still supply keys nothing else defines).
// Exported for tests.
export function dotEnvPaths(): string[] {
  const paths = [resolve(ocrcHome(), 'config.env'), resolve(PLUGIN_ROOT, '.env')]
  if (process.env.OPENCODE_CONFIG_DIR) {
    paths.push(resolve(process.env.OPENCODE_CONFIG_DIR, '.env'))
  }
  if (process.env.OPENCODE_PROJECT) {
    paths.push(resolve(process.env.OPENCODE_PROJECT, '.env'))
    paths.push(resolve(process.env.OPENCODE_PROJECT, '.opencode', '.env'))
  }
  paths.push(resolve(process.cwd(), '.env'))
  return paths
}

function loadDotEnv(): void {
  for (const path of dotEnvPaths()) dotenvConfig({ path, override: false })
}

function env(key: string, optionsVal?: string): string | undefined {
  return optionsVal ?? process.env[key]
}

/** Read an OCRC-owned setting by its fork name, falling back to the upstream
 *  pre-fork variable so existing .env files keep working after the rename. */
function envFork(key: string, legacy: string, optionsVal?: string): string | undefined {
  return optionsVal ?? process.env[key] ?? process.env[legacy]
}

export function loadPluginConfig(
  options?: Record<string, unknown>,
  opts?: { requireTelegram?: boolean },
): PluginConfig {
  loadDotEnv()
  // The opencode plugin always needs Telegram; the standalone host can run
  // web-only (no bot), so it passes requireTelegram=false.
  const requireTelegram = opts?.requireTelegram ?? true

  const token = (options?.telegramBotToken as string) ?? process.env.TELEGRAM_BOT_TOKEN
  if (!token && requireTelegram) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required. Set it via opencode.json plugin options or TELEGRAM_BOT_TOKEN environment variable.',
    )
  }

  const userIdsRaw = (options?.allowedUserIds as string) ?? process.env.ALLOWED_USER_IDS ?? ''
  const ids = userIdsRaw
    .toString()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n))

  // Token and allowlist must come as a pair: with a token but no IDs the
  // transport would start and address every push to chat "undefined".
  if (ids.length === 0 && (requireTelegram || token)) {
    throw new Error(
      'ALLOWED_USER_IDS is required (comma-separated Telegram user IDs) whenever Telegram is enabled. Set it, or unset TELEGRAM_BOT_TOKEN to run web-only.',
    )
  }

  // Fork defaults (2026-09-25 decisions): bind 0.0.0.0 — the product is
  // LAN-first (phone on the same network), and the token gate below is not
  // optional; port 4099 pairs with opencode's own 4096. Upstream variable
  // names keep working via envFork().
  const webHost = envFork('OCRC_WEB_HOST', 'WEB_HOST', options?.webHost as string) ?? '0.0.0.0'

  const devBypassExplicit = bool(options?.webCfAccessDevBypass as string)
  const devBypassEnv = process.env.OCRC_WEB_CF_ACCESS_DEV_BYPASS ?? process.env.WEB_CF_ACCESS_DEV_BYPASS

  return {
    telegramBotToken: token ?? '',
    allowedUserIds: ids,
    webEnabled: bool(options?.webEnabled as string) ??
      (process.env.OCRC_WEB_ENABLED ?? process.env.WEB_ENABLED) === 'true',
    webHost,
    webPort: num(options?.webPort ?? process.env.OCRC_WEB_PORT ?? process.env.WEB_PORT, 4099, 'OCRC_WEB_PORT'),
    webPublicUrl: envFork('OCRC_WEB_PUBLIC_URL', 'WEB_PUBLIC_URL', options?.webPublicUrl as string) ?? '',
    webStaticRoot: envFork('OCRC_WEB_STATIC_ROOT', 'WEB_STATIC_ROOT', options?.webStaticRoot as string) ?? resolve(PLUGIN_ROOT, 'web', 'dist'),
    webCacheSize: num(options?.webCacheSize ?? process.env.OCRC_WEB_SESSION_CACHE_SIZE ?? process.env.WEB_SESSION_CACHE_SIZE, 100, 'OCRC_WEB_SESSION_CACHE_SIZE'),
    webCfAccessTeam: envFork('OCRC_WEB_CF_ACCESS_TEAM', 'WEB_CF_ACCESS_TEAM', options?.webCfAccessTeam as string) ?? '',
    webCfAccessAud: envFork('OCRC_WEB_CF_ACCESS_AUD', 'WEB_CF_ACCESS_AUD', options?.webCfAccessAud as string) ?? '',
    // Default OFF: a loopback bind is not a safe bypass signal when traffic
    // arrives via a tunnel (cloudflared connects from 127.0.0.1). Local dev
    // must opt in explicitly with OCRC_WEB_CF_ACCESS_DEV_BYPASS=true.
    webCfAccessDevBypass: devBypassExplicit ?? (devBypassEnv !== undefined ? devBypassEnv === 'true' : false),
    webCfAccessDevEmail: envFork('OCRC_WEB_CF_ACCESS_DEV_EMAIL', 'WEB_CF_ACCESS_DEV_EMAIL', options?.webCfAccessDevEmail as string) ?? 'dev@localhost',
    webAuth: (envFork('OCRC_WEB_AUTH', 'WEB_AUTH', options?.webAuth as string) ?? 'token') === 'cf-access' ? 'cf-access' : 'token',
    webToken: envFork('OCRC_WEB_TOKEN', 'WEB_TOKEN', options?.webToken as string) ?? '',
    statePath: envFork('OCRC_STATE_PATH', 'STATE_PATH', options?.statePath as string) ?? join(ocrcHome(), 'state.json'),
    tuiVisible: bool(options?.tuiVisible as string) ?? process.env.TUI_VISIBLE !== 'false',
    transport: env('TRANSPORT', options?.transport as string) ?? 'telegram',
    chatTimeoutMs: num(options?.chatTimeoutMs ?? process.env.CHAT_TIMEOUT_MS, 600000, 'CHAT_TIMEOUT_MS'),
    baseUrl: env('OPENCODE_BASE_URL', options?.baseUrl as string) ?? '',
    tgChunkSoftLimit: num(options?.tgChunkSoftLimit ?? process.env.TG_CHUNK_SOFT_LIMIT, 3500, 'TG_CHUNK_SOFT_LIMIT'),
    acpCommand: env('OCRC_ACP_CMD', options?.acpCommand as string) ?? 'kimi acp',
    backends: env('OCRC_BACKENDS', options?.backends as string) ?? '',
  }
}

function bool(val?: string): boolean | undefined {
  if (val === undefined) return undefined
  if (val === 'true' || val === '1' || val === 'yes') return true
  if (val === 'false' || val === '0' || val === 'no') return false
  return undefined
}

/** Parse a numeric setting; a non-finite value falls back to the default with a warning. */
function num(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    log.warn(`invalid number for ${name}: ${JSON.stringify(String(raw))} — using default ${fallback}`)
    return fallback
  }
  return n
}
