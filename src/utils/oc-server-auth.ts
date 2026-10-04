import { createLogger } from './logger.js'

const log = createLogger('oc-auth')

/**
 * Authorization headers for RAW fetches against the opencode server.
 *
 * The in-process SDK client (ctx.client) authenticates itself — but ocrc's
 * direct `fetch(${baseUrl}/…)` calls bypass it. On servers started with
 * OPENCODE_SERVER_PASSWORD (HTTP Basic — verified against the production
 * octg instance: 401 + `www-authenticate: Basic realm="Secure Area"`) those
 * raw calls would 401. Same env contract as grinev, so the production env
 * carries over unchanged: OPENCODE_SERVER_PASSWORD + optional
 * OPENCODE_SERVER_USERNAME (default "opencode").
 */
export function ocServerHeaders(): Record<string, string> {
  return buildBasicHeaders(process.env.OPENCODE_SERVER_USERNAME || 'opencode', process.env.OPENCODE_SERVER_PASSWORD)
}

/** HTTP Basic headers from explicit credentials — the env-backed ocServerHeaders()
 *  for the LOCAL server, plus per-remote variants (0.26.0) whose passwords live
 *  in remotes.json rather than the environment. */
export function buildBasicHeaders(user: string, password: string | undefined): Record<string, string> {
  if (!password) return {}
  const b64 = Buffer.from(`${user}:${password}`).toString('base64')
  return { Authorization: `Basic ${b64}` }
}

/** fetch with ocServerHeaders() merged in — use for EVERY direct call to the
 * opencode server (baseUrl/serverUrl). Plain fetch stays fine for unrelated
 * hosts (telegram api, our own web server). Without a password configured
 * this is exactly fetch(url, init) — call shape unchanged. */
export function ocFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const auth = ocServerHeaders()
  if (Object.keys(auth).length === 0) return fetch(url, init)
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...auth } })
}
