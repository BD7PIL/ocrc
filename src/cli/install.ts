import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Repo root resolved from this module's own location: dist/cli/install.js (or
// src/cli/install.ts in dev) — two levels below the root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode')
const GLOBAL_OPENCODE_JSON = join(OPENCODE_CONFIG_DIR, 'opencode.json')
const ENTRY = join(REPO_ROOT, 'dist', 'plugin', 'entry.js')
const ENV_FILE = join(REPO_ROOT, '.env')
const DEFAULT_WEB_PORT = '4099' // pairs with opencode's own server port 4096

interface InstallOptions {
  yes: boolean
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise<string>((res) => rl.question(question, res))
}

/** Read existing .env (if any) into a key→value map, preserving comments isn't needed for upsert. */
function readEnv(): Map<string, string> {
  const map = new Map<string, string>()
  if (!existsSync(ENV_FILE)) return map
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** Upsert keys into .env, preserving existing keys/comments not being changed. */
function upsertEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8').split('\n') : []
  const remaining = { ...updates }
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/)
    if (m && m[1] in remaining) {
      const v = remaining[m[1]]
      delete remaining[m[1]]
      return `${m[1]}=${v}`
    }
    return line
  })
  for (const [k, v] of Object.entries(remaining)) out.push(`${k}=${v}`)
  // Contains the bot token — owner-only, like the web token file (token.ts).
  writeFileSync(ENV_FILE, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 })
  try {
    // mode only applies at creation; tighten permissions of a pre-existing file too.
    chmodSync(ENV_FILE, 0o600)
  } catch {
    /* best effort */
  }
}

/** Remove the legacy directory-path plugin entry from opencode.json (1.16 and earlier). */
function migrateLegacyConfig(): boolean {
  if (!existsSync(GLOBAL_OPENCODE_JSON)) return false
  let config: Record<string, any>
  try { config = JSON.parse(readFileSync(GLOBAL_OPENCODE_JSON, 'utf-8')) } catch { return false }
  const plugins: Array<string | [string, unknown]> = config.plugin ?? []
  const isLegacy = (e: string | [string, unknown]) => {
    const name = Array.isArray(e) ? e[0] : e
    return name === REPO_ROOT || name === 'opencode-remote-control@latest' || /opencode-remote-control$/.test(name)
  }
  const filtered = plugins.filter((e) => !isLegacy(e))
  if (filtered.length === plugins.length) return false
  config.plugin = filtered
  writeFileSync(GLOBAL_OPENCODE_JSON, JSON.stringify(config, null, 2) + '\n')
  return true
}

const PKG_NAME = '@bd7pil/ocrc'

/**
 * Ensure the npm plugin entry (`"@bd7pil/ocrc"`) exists in an opencode config.
 *
 * Verified on opencode 1.18.x (experiment 2026-10-05): the `plugin` array is
 * the only plugin load path in serve mode — opencode installs npm entries
 * itself and rejects anything but an OBJECT default export (see entry.ts).
 * Directory bridges were removed in 0.26.8: their load timing was
 * unpredictable (instances loaded them mid-session, fought the host for the
 * PRIMARY lock and the web port — "ghosts"). Only a plain opencode.json is
 * auto-edited (safe round-trip); a jsonc (comments allowed, possibly
 * user-managed on a synced share) is never rewritten — we print the exact
 * line for the user to add instead.
 */
function ensureNpmPluginEntry(): 'written' | 'present' | 'manual' {
  const candidates = [
    process.env.OPENCODE_CONFIG_DIR ? join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json') : null,
    GLOBAL_OPENCODE_JSON,
    join(homedir(), '.opencode', 'opencode.json'),
  ].filter((p): p is string => !!p)

  for (const path of candidates) {
    if (!existsSync(path)) continue
    let config: Record<string, any>
    try { config = JSON.parse(readFileSync(path, 'utf-8')) } catch { continue }
    const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : []
    const present = plugins.some((e) => (Array.isArray(e) ? e[0] : e) === PKG_NAME)
    if (present) return 'present'
    config.plugin = [...plugins, PKG_NAME]
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
    console.log(`  Added "${PKG_NAME}" to the plugin array in ${path}`)
    return 'written'
  }
  return 'manual'
}

export async function runInstall(options: InstallOptions): Promise<void> {
  console.log(`\nInstalling ocrc for opencode 1.17+...\n`)
  console.log(`   Repo:    ${REPO_ROOT}`)
  console.log(`   Env:     ${ENV_FILE}`)

  if (!existsSync(ENTRY)) {
    console.error(`\n  dist not built: ${ENTRY} is missing. Run \`npm run build\` first.`)
    process.exit(1)
  }

  const env = readEnv()
  let token = env.get('TELEGRAM_BOT_TOKEN') ?? process.env.TELEGRAM_BOT_TOKEN ?? ''
  let ids = env.get('ALLOWED_USER_IDS') ?? process.env.ALLOWED_USER_IDS ?? ''
  let web = env.get('WEB_ENABLED') ?? process.env.WEB_ENABLED ?? 'true'
  let port = env.get('OCRC_WEB_PORT') ?? env.get('WEB_PORT') ?? DEFAULT_WEB_PORT

  if (!options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('\n--- Configuration ---')
    token = (await ask(rl, `TELEGRAM_BOT_TOKEN [${token ? '***' : 'required'}]: `)).trim() || token
    ids = (await ask(rl, `ALLOWED_USER_IDS (comma-separated) [${ids || 'required'}]: `)).trim() || ids
    web = (await ask(rl, `Enable Web PWA? (true/false) [${web}]: `)).trim() || web
    port = (await ask(rl, `Web port (opencode itself uses 4096) [${port}]: `)).trim() || port
    rl.close()
  }

  // M12: Telegram is optional — a web-only install is a first-class shape.
  // Leave the token empty and only the Web panel starts.
  if (!token) console.log('  (no Telegram token — web-only install; the bot surface will not start)')
  if (!ids) console.log('  (no ALLOWED_USER_IDS — Telegram allowlist left empty)')

  upsertEnv({
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_USER_IDS: ids,
    OCRC_WEB_ENABLED: web,
    OCRC_WEB_PORT: port,
  })
  console.log(`\n  Wrote config to ${ENV_FILE}`)

  if (migrateLegacyConfig()) {
    console.log(`  Removed legacy directory-path plugin entry from ${GLOBAL_OPENCODE_JSON}`)
  }
  // Clean up bridges that pre-0.26.8 installs scattered across the config
  // homes — they are dead weight at best and ghost-PRIMARY sources at worst.
  cleanupLegacyBridges()

  // npm installs must appear in the plugin array — the only supported
  // plugin-mode load path on 1.18.x.
  if (ensureNpmPluginEntry() === 'manual') {
    console.log(`\n  ACTION NEEDED — add the npm package to your opencode config`)
    console.log(`  (opencode.json / opencode.jsonc "plugin" array):`)
    console.log(`\n      "plugin": [ "@bd7pil/ocrc" ]\n`)
    console.log(`  opencode installs it on next start; upgrades ship via npm + restart.`)
  }

  console.log(`\nInstallation complete!`)
  console.log(`\nNext steps:`)
  console.log(`   1. Plugin mode: start opencode — it installs the npm entry and loads`)
  console.log(`      the plugin (restart once after npm -g upgrades).`)
  console.log(`      Host mode (headless servers): \`ocrc host\` — touches nothing.`)
  console.log(`   2. Send "hello" in Telegram to confirm the bot responds.`)
  console.log(`   3. For the Web PWA: \`ocrc pair\` (or /pair in Telegram) → open the`)
  console.log(`      URL/QR. To reach it from another device, expose http://localhost:${port}`)
  console.log(`      over a tunnel or VPN (e.g. \`tailscale serve ${port}\`).`)
}

/** Delete bridge files older installs dropped into every known config-home layout. */
function cleanupLegacyBridges(): void {
  const homes = [OPENCODE_CONFIG_DIR, join(homedir(), '.opencode')]
  const dirs = ['plugins', 'plugin']
  for (const home of homes) {
    for (const dir of dirs) {
      const f = join(home, dir, 'ocrc.js')
      try {
        if (existsSync(f)) {
          unlinkSync(f)
          console.log(`  Removed legacy bridge → ${f}`)
        }
      } catch { /* best effort */ }
    }
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ocrc install (opencode 1.17+)

USAGE:
  npm run build && node dist/cli/install.js [OPTIONS]

OPTIONS:
  --yes, -y   Skip interactive prompts (uses existing .env / env vars)
  --help, -h  Show this help

WHAT IT DOES:
  1. Saves TELEGRAM_BOT_TOKEN / ALLOWED_USER_IDS / OCRC_WEB_ENABLED / OCRC_WEB_PORT
     to the repo's .env (plugins receive no options object, so config lives in .env)
  2. Adds "@bd7pil/ocrc" to the opencode config plugin array (auto for a plain
     opencode.json; exact edit printed for jsonc) — the ONLY reliable plugin
     load path on 1.18.x; opencode installs the npm package itself
  3. Removes legacy plugin bridges and legacy config entries

NOTES:
  - Default web port is ${DEFAULT_WEB_PORT} (opencode's own server occupies 4096).
  - Host mode (\`ocrc host\`) is an alternative that touches no opencode config at all.
`)
    return
  }
  await runInstall({ yes: args.includes('--yes') || args.includes('-y') })
}

if (process.argv[1]?.endsWith('install.js') || process.argv[1]?.endsWith('install.ts')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
