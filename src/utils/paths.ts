import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * OCRC's own config/state home. Everything the plugin persists (token,
 * primary lock, state, env file, logs) lives here — never in
 * ~/.config/opencode (that directory is the host's; we only allow the
 * plugins/ bridge there) and never in the legacy ~/.opencode paths.
 *
 * OCRC_HOME overrides the default for tests and sandboxed installs.
 */
export function ocrcHome(): string {
  return process.env.OCRC_HOME ?? join(homedir(), '.ocrc')
}

/** Legacy ~/.opencode-based path helper — used only to MIGRATE old files. */
export function legacyOpencodeHome(): string {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.opencode')
}
