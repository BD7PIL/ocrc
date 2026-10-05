// shell-health.ts — pure launch-orchestration state machine for the ocrc
// Desktop thin shell (roadmap ⑥; Electron scaffold lives in desktop/, this
// module is the testable brain).
//
// Shell contract (PRODUCT.md 第三条): the shell owns WINDOW + TRAY + the
// launch chain. It never embeds the agent runtime — it waits for the panel
// HTTP endpoint the same way opencode desktop waits for its sidecar:
// poll → ready → open window, with capped backoff and a kill/exit verdict.

export type ShellPhase =
  | { state: 'idle' }
  | { state: 'launching'; attempt: number }
  | { state: 'waiting-healthy'; attempt: number; url: string }
  | { state: 'ready'; url: string }
  | { state: 'failed'; reason: string }

export interface HealthProbeLike {
  (url: string): Promise<boolean>
}

export interface ShellOrchestrationOptions {
  /** Panel base URL (default http://127.0.0.1:4099). */
  panelUrl?: string
  /** Total health-wait budget after a launch attempt (ms). */
  healthyTimeoutMs?: number
  /** Delay between health polls (ms). */
  pollIntervalMs?: number
  /** Max launch attempts before failed. */
  maxAttempts?: number
}

const DEFAULTS = { panelUrl: 'http://127.0.0.1:4099', healthyTimeoutMs: 60_000, pollIntervalMs: 500, maxAttempts: 3 }

/**
 * Poll `probe(panelUrl)` until true or the budget expires.
 * Pure w.r.t. time — the probe is injected so tests drive it.
 */
export async function waitHealthy(
  probe: HealthProbeLike,
  opts: ShellOrchestrationOptions = {},
  onTick?: (p: ShellPhase) => void,
): Promise<boolean> {
  const { panelUrl, healthyTimeoutMs, pollIntervalMs } = { ...DEFAULTS, ...opts }
  const deadline = Date.now() + healthyTimeoutMs
  while (Date.now() < deadline) {
    onTick?.({ state: 'waiting-healthy', attempt: 1, url: panelUrl })
    try {
      if (await probe(panelUrl)) {
        onTick?.({ state: 'ready', url: panelUrl })
        return true
      }
    } catch { /* probe errors = not healthy yet */ }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  onTick?.({ state: 'failed', reason: `panel did not become healthy within ${healthyTimeoutMs}ms at ${panelUrl}` })
  return false
}

/**
 * Backoff between launch attempts: 2s → 4s → 8s, capped 30s.
 * Mirrors the supervisor's respawn curve so the shell and the daemon agree.
 */
export function launchBackoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt - 1))
}

/**
 * Decide the next phase after a launch attempt outcome (pure).
 *  - probe healthy → ready
 *  - attempts left → launching (next attempt)
 *  - exhausted → failed
 */
export function nextPhaseAfter(
  attempt: number,
  healthy: boolean,
  opts: ShellOrchestrationOptions = {},
): ShellPhase {
  const { maxAttempts, panelUrl } = { ...DEFAULTS, ...opts }
  if (healthy) return { state: 'ready', url: panelUrl }
  if (attempt < maxAttempts) return { state: 'launching', attempt: attempt + 1 }
  return { state: 'failed', reason: `panel unreachable after ${maxAttempts} launch attempts` }
}
