import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode')
const GLOBAL_OPENCODE_JSON = join(OPENCODE_CONFIG_DIR, 'opencode.json')
const PKG_NAME = '@bd7pil/ocrc'

type PluginEntry = string | [string, Record<string, unknown>]

/** Every bridge layout any past install ever wrote (0.26.x scattered them). */
function bridgeFiles(): string[] {
  const homes = [OPENCODE_CONFIG_DIR, join(homedir(), '.opencode')]
  const dirs = ['plugins', 'plugin']
  const files: string[] = []
  for (const home of homes) {
    for (const dir of dirs) files.push(join(home, dir, 'ocrc.js'))
  }
  return files
}

/** Remove the ocrc npm entry (and any legacy directory-path entry) from an opencode config. */
function removeConfigEntry(path: string): boolean {
  if (!existsSync(path)) return false
  let config: Record<string, any>
  try { config = JSON.parse(readFileSync(path, 'utf-8')) } catch { return false }
  const plugins: PluginEntry[] = config.plugin ?? []
  const filtered = plugins.filter((e) => {
    const name = Array.isArray(e) ? e[0] : e
    return !(name === PKG_NAME || name === REPO_ROOT || name.startsWith('opencode-remote-control'))
  })
  if (filtered.length === plugins.length) return false
  if (filtered.length > 0) config.plugin = filtered
  else delete config.plugin
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return true
}

export async function runUninstall(): Promise<void> {
  let removed = false

  for (const f of bridgeFiles()) {
    if (existsSync(f)) {
      rmSync(f)
      console.log(`Removed plugin bridge: ${f}`)
      removed = true
    }
  }

  for (const path of [GLOBAL_OPENCODE_JSON, join(homedir(), '.opencode', 'opencode.json')]) {
    if (removeConfigEntry(path)) {
      console.log(`Removed ocrc plugin entry from ${path}`)
      removed = true
    }
  }

  if (!removed) {
    console.log('ocrc was not installed (no bridges or config entries found).')
    return
  }

  console.log('\nUninstalled. Restart opencode to apply.')
  console.log(`(Your .env at ${join(REPO_ROOT, '.env')} was left untouched.)`)
}

export async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
ocrc uninstall

USAGE:
  node dist/cli/uninstall.js

WHAT IT DOES:
  - Removes every plugin bridge from all config-home layouts (legacy 0.2x installs)
  - Removes the "@bd7pil/ocrc" npm entry (and legacy entries) from opencode configs
  - Leaves your .env untouched
`)
    return
  }
  await runUninstall()
}

if (process.argv[1]?.endsWith('uninstall.js') || process.argv[1]?.endsWith('uninstall.ts')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
