import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPluginConfig, dotEnvPaths } from '../../src/plugin/config'

// Keep the config logger's file writes out of the real ~/.opencode during tests.
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ocrc-config-test-'))

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('loadPluginConfig', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    for (const k of [
      'TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'WEB_HOST', 'WEB_ENABLED',
      'WEB_CF_ACCESS_DEV_BYPASS', 'WEB_CF_ACCESS_TEAM', 'WEB_CF_ACCESS_AUD',
      'WEB_PORT', 'WEB_SESSION_CACHE_SIZE', 'CHAT_TIMEOUT_MS', 'TG_CHUNK_SOFT_LIMIT',
    ]) delete process.env[k]
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  function base(opts: Record<string, unknown> = {}) {
    return loadPluginConfig({ telegramBotToken: 't', allowedUserIds: '123', ...opts })
  }

  it('requires a telegram token', () => {
    // Set empty (present) so loadDotEnv's dotenv call won't repopulate from .env.
    process.env.TELEGRAM_BOT_TOKEN = ''
    expect(() => loadPluginConfig({ allowedUserIds: '123' })).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('requires at least one allowed user id', () => {
    process.env.ALLOWED_USER_IDS = ''
    expect(() => loadPluginConfig({ telegramBotToken: 't' })).toThrow(/ALLOWED_USER_IDS/)
  })

  it('parses comma-separated allowed user ids', () => {
    expect(base({ allowedUserIds: '1, 2 ,3' }).allowedUserIds).toEqual([1, 2, 3])
  })

  it('defaults CF Access dev bypass to OFF even on a loopback bind', () => {
    // A loopback bind is not a safe bypass signal behind a tunnel.
    expect(base({ webHost: '127.0.0.1' }).webCfAccessDevBypass).toBe(false)
  })

  it('honors explicit dev bypass opt-in', () => {
    expect(base({ webCfAccessDevBypass: 'true' }).webCfAccessDevBypass).toBe(true)
    process.env.WEB_CF_ACCESS_DEV_BYPASS = 'true'
    expect(base().webCfAccessDevBypass).toBe(true)
  })

  // ── Telegram token/allowlist pairing ──

  it('rejects a telegram token without ALLOWED_USER_IDS even when telegram is optional (host mode)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.env.ALLOWED_USER_IDS = ''
    expect(() => loadPluginConfig(undefined, { requireTelegram: false })).toThrow(/ALLOWED_USER_IDS/)
  })

  it('allows web-only host mode (no token, no ids)', () => {
    process.env.TELEGRAM_BOT_TOKEN = ''
    process.env.ALLOWED_USER_IDS = ''
    const cfg = loadPluginConfig(undefined, { requireTelegram: false })
    expect(cfg.telegramBotToken).toBe('')
    expect(cfg.allowedUserIds).toEqual([])
  })

  // ── Numeric env validation ──

  it('falls back to the default port for a non-numeric WEB_PORT', () => {
    process.env.WEB_PORT = 'abc'
    expect(base().webPort).toBe(17081)
  })

  it('accepts a valid numeric WEB_PORT', () => {
    process.env.WEB_PORT = '1234'
    expect(base().webPort).toBe(1234)
  })

  it('falls back for non-numeric chatTimeoutMs / tgChunkSoftLimit / webCacheSize', () => {
    process.env.CHAT_TIMEOUT_MS = 'soon'
    process.env.TG_CHUNK_SOFT_LIMIT = 'NaN'
    process.env.WEB_SESSION_CACHE_SIZE = 'Infinity'
    const cfg = base()
    expect(cfg.chatTimeoutMs).toBe(600000)
    expect(cfg.tgChunkSoftLimit).toBe(3500)
    expect(cfg.webCacheSize).toBe(100)
  })

  // ── .env precedence ──

  it('loads the plugin install dir .env first and the cwd .env last', () => {
    // Note: process.chdir is unsupported in vitest workers, and the test cwd
    // usually IS the repo root — so the cwd .env may duplicate paths[0];
    // lastIndexOf still proves it is loaded last (dotenv: first loaded wins).
    process.env.OPENCODE_PROJECT = '/some/project'
    try {
      const paths = dotEnvPaths()
      // dotenv never overrides, so the first path wins: it must be the plugin's
      // own install dir, never a user-controlled project .env.
      expect(paths[0]).toBe(resolve(REPO_ROOT, '.env'))
      const cwdEnv = resolve(process.cwd(), '.env')
      expect(paths.lastIndexOf(cwdEnv)).toBe(paths.length - 1)
      const projectEnv = resolve('/some/project', '.env')
      expect(paths.indexOf(projectEnv)).toBeGreaterThan(0)
      expect(paths.indexOf(projectEnv)).toBeLessThan(paths.length - 1)
    } finally {
      delete process.env.OPENCODE_PROJECT
    }
  })
})
