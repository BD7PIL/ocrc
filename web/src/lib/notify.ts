// Background session activity notifications (TG "后台会话已完成" parity, B1):
// while a session the user is NOT viewing produces activity, flash the tab
// title with a counter. Cleared when the user returns to the tab or opens the
// session. Baselines keep the first observed snapshot from notifying.

let baseline = new Map<string, number>()
const pending = new Set<string>()
let viewed: string | undefined
let titleTimer: ReturnType<typeof setInterval> | undefined
let flash = false

function refreshTitle(): void {
  if (typeof document === 'undefined') return
  const base = document.title.replace(/^(🔔 [\d]+ 新动态 — )/, '') || 'ocrc'
  if (pending.size === 0) {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = undefined }
    flash = false
    document.title = base
    return
  }
  if (titleTimer) return
  document.title = `🔔 ${pending.size} 新动态 — ${base}`
  titleTimer = setInterval(() => {
    flash = !flash
    document.title = flash ? `🔔 ${pending.size} 新动态 — ${base}` : base
  }, 1200)
}

/** The session the user is currently viewing — its own activity never notifies. */
export function setViewedSession(id: string | undefined): void {
  viewed = id
  if (id) { pending.delete(id); refreshTitle() }
}

/** Feed the latest session summaries (ws 'sessions' broadcast). */
export function noteSessionActivity(rows: Array<{ id: string; lastActiveAt: number }>): void {
  for (const r of rows) {
    const prev = baseline.get(r.id)
    baseline.set(r.id, r.lastActiveAt)
    // Skip the first sighting (cold baseline) and the viewed session.
    if (prev === undefined || r.id === viewed) continue
    if (r.lastActiveAt > prev + 1500) {
      pending.add(r.id)
      refreshTitle()
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pending.clear()
      refreshTitle()
    }
  })
}
