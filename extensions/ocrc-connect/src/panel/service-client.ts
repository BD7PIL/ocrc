import type { GuestRequestMethod, GuestRequestResult } from '@openchamber/sdk'

/** The subset of the guest-service bridge the panel components need.
 *  Kept structural (not a type re-export) so tests can fake it. */
export type RequestFn = (path: string, method?: GuestRequestMethod, body?: unknown) => Promise<GuestRequestResult>
