import { writable } from 'svelte/store'

const RAIL_OPEN_KEY = 'ocrc.railOpen'

/** Desktop left panel open/collapsed state — persisted (ZCode/opencode parity:
    a reload must not undo the user's collapse; the restore strip makes it
    findable again). */
function persistedRailOpen() {
  let initial = true
  try { initial = localStorage.getItem(RAIL_OPEN_KEY) !== '0' } catch { /* private mode */ }
  const store = writable(initial)
  store.subscribe((v) => {
    try { localStorage.setItem(RAIL_OPEN_KEY, v ? '1' : '0') } catch { /* private mode */ }
  })
  return store
}
export const leftPanelOpen = persistedRailOpen()

/** "+ New" multi-action menu open state. */
export const plusMenuOpen = writable(false)

/** New-session modal open state. */
export const newSessionOpen = writable(false)
/** M9 bot-channels management modal open state. */
export const channelsOpen = writable(false)

/** Mobile inspector bottom-sheet open state (toggled from the chat header). */
export const inspectorOpen = writable(false)

/**
 * True for one beat after a torn-feed REST resync replaced the whole feed:
 * reconstructed history cards re-key, so the stream's `:last-child` entrance
 * must be suppressed for that beat (rule 1 — history mounts instantly, and a
 * resync IS history).
 */
export const feedResyncing = writable(false)

/** Draft handed to the composer from suggestion chips: clicking a chip fills
    (never sends) — the composer watches this store, sets its text, focuses,
    and clears it. The nonce makes repeated picks of the same chip re-trigger. */
export const composerDraft = writable<{ text: string; nonce: number } | undefined>(undefined)

/** True while the composer textarea is empty — hides suggestion chips once the
    user starts typing (baseline: chips must yield the moment they're noise). */
export const composerEmpty = writable(true)

/** localStorage key for the theme override — also read by the early inline
    script in app.html (keep in sync). Absent = follow the system. */
const THEME_KEY = 'ocrc-theme'

function initialTheme(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const a = document.documentElement.getAttribute('data-theme')
    if (a === 'light' || a === 'dark') return a
  }
  // No stored override — mirror what theme.css's media query decided.
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

function applyThemeMeta(t: 'light' | 'dark') {
  // The two media-scoped theme-color metas only track the system; a manual
  // override must pin them (iOS status bar / PWA chrome) to the active color.
  const c = t === 'light' ? '#faf9f6' : '#0d0d0d'
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', c))
}

/** Effective theme — resolved from the override attribute / system at startup. */
export const theme = writable<'light' | 'dark'>(initialTheme())

if (typeof document !== 'undefined') applyThemeMeta(initialTheme())

/** Flip light↔dark, persist the override, and apply it to <html> immediately. */
export function toggleTheme() {
  theme.update((t) => {
    const next = t === 'light' ? 'dark' : 'light'
    try { localStorage.setItem(THEME_KEY, next) } catch { /* private mode */ }
    document.documentElement.setAttribute('data-theme', next)
    applyThemeMeta(next)
    return next
  })
}
