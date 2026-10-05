import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// OCRC's own root (src/utils or dist/utils → two levels up). The plugin runs
// with cwd = the USER's project, so anything resolved against cwd (package.json,
// git) must anchor here instead.
const OCRC_ROOT = join(__dirname, '..', '..')
const pkg = JSON.parse(readFileSync(join(OCRC_ROOT, 'package.json'), 'utf-8')) as { version: string }

const START_TIME = Date.now()

function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', cwd: OCRC_ROOT }).trim()
  } catch {
    return 'unknown'
  }
}

const GIT_COMMIT = getGitCommit()

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export interface VersionInfo {
  version: string
  commit: string
  uptime: string
  uptimeMs: number
  node: string
  startedAt: string
  /** Which entry owns this process: 'host' = standalone `ocrc host`,
   *  'plugin' = loaded inside opencode. See README "Two ways to run". */
  mode: 'plugin' | 'host'
}

export function getVersionInfo(): VersionInfo {
  return {
    version: pkg.version,
    commit: GIT_COMMIT,
    uptime: formatUptime(Date.now() - START_TIME),
    uptimeMs: Date.now() - START_TIME,
    node: process.version,
    startedAt: new Date(START_TIME).toISOString(),
    mode: process.env.OCRC_MODE === 'host' ? 'host' : 'plugin',
  }
}
