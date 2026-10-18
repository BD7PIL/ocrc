import type { GuestRequestMethod, GuestRequestResult } from '@openchamber/sdk'

/** The subset of the guest-service bridge the panel components need.
 *  Kept structural (not a type re-export) so tests can fake it. */
export type RequestFn = (path: string, method?: GuestRequestMethod, body?: unknown) => Promise<GuestRequestResult>

/** Issue a request and parse the JSON body, turning a non-2xx into an error.
 *  The service answers every error with `{ error }`, and that message is what
 *  the user should read — not `HTTP 403`. */
export async function call<T = unknown>(
  request: RequestFn,
  path: string,
  method: GuestRequestMethod = 'GET',
  body?: unknown,
): Promise<T> {
  const r = await request(path, method, body)
  const parsed = JSON.parse(r.body) as unknown
  if (r.status >= 400) throw new Error((parsed as { error?: string } | null)?.error ?? `HTTP ${r.status}`)
  return parsed as T
}

export const post = <T = unknown>(request: RequestFn, path: string, body?: unknown) => call<T>(request, path, 'POST', body)
