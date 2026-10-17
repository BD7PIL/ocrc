import { connectHost, type HostClient } from '@openchamber/sdk'
import { applyHostReady } from '@openchamber/sdk/ui'

/**
 * Connect to the host and keep this frame painted in the running theme.
 *
 * A sandboxed guest frame inherits nothing from the shell around it: the host
 * answers `ready` with the theme of the moment as a snapshot, and the guest has
 * to paint those tokens itself (as both `--oc-*` aliases and the host's own
 * variable names). Registering here — before the first component paints — is
 * what keeps the frame from flashing unstyled defaults, and re-applying on
 * every snapshot is what makes a host theme switch follow through.
 */
export function connectThemedHost(): HostClient {
  const host = connectHost()
  host.onReady((ctx) => applyHostReady(ctx, document.documentElement))
  return host
}
