import type { MiddlewareHandler } from 'hono'

export interface AuthUser {
  email: string
  sub: string
}

/** Pluggable web auth. Both surfaces set/return the same AuthUser shape that the
 * rest of the web transport already expects (`c.set('user', AuthUser)`). */
export interface AuthStrategy {
  /** Hono middleware: authenticate the request → `c.set('user', AuthUser)`, or respond 401. */
  httpMiddleware(): MiddlewareHandler
  /** Authenticate a WebSocket upgrade request. Returns the user or null. */
  verifyUpgrade(req: {
    headers: Record<string, string | string[] | undefined>
    url?: string
    socket?: { remoteAddress?: string }
  }): Promise<AuthUser | null>
  /** Generate a fresh credential, persist it, and accept ONLY it from now on —
   * every previously paired device is logged out. Optional: strategies with no
   * app-side credential (e.g. CF Access) can't rotate. */
  rotate?(): void
}
