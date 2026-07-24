import type { AuthStrategy } from './index.js'
import { createRemoteJWKSet } from 'jose'
import { cfAccessMiddleware, verifyUpgradeJwt, type CfAccessOpts } from '../../transport/web/middleware/cf-access.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('auth-cf-access')

/** Wrap the existing Cloudflare Access middleware/verifier as an AuthStrategy. */
export function createCfAccessAuth(opts: CfAccessOpts): AuthStrategy {
  if (opts.devBypass) {
    log.warn(
      '⚠ CF Access devBypass is ON — requests from a loopback peer skip authentication entirely. ' +
      'If cloudflared (or any same-host tunnel/proxy) fronts this server, ALL remote traffic arrives ' +
      'from 127.0.0.1 and is let through UNAUTHENTICATED. Never combine devBypass with a tunnel.',
    )
  }
  const jwks = opts.team
    ? createRemoteJWKSet(new URL(`https://${opts.team}.cloudflareaccess.com/cdn-cgi/access/certs`))
    : undefined
  return {
    httpMiddleware: () => cfAccessMiddleware(opts),
    verifyUpgrade: (req) => verifyUpgradeJwt(req, opts, jwks),
  }
}
