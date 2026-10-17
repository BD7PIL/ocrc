/** Small helpers shared by the remote-host and remote-instance layers.
 *
 * Kept separate so the instance manager (which is bundled into the
 * openchamber extension service) does not pull in all of remote-host.ts just
 * for a version parser and a backoff curve.
 */

export function parseGlibcVersion(firstLine: string | undefined): string | undefined {
  const m = firstLine?.match(/(\d+\.\d+)/)
  return m?.[1]
}

/** Exponential respawn backoff: 2s → 4s → 8s … capped at 60s. */
export function nextRetryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1))
}
