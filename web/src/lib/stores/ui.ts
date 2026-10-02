import { writable, get } from 'svelte/store'

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

/** True while a session's REST history snapshot is in flight — gates the
 *  STARTERS chips, which must not flash during that window (cards are
 *  legitimately 0 until the snapshot lands). */
export const sessionBooting = writable(false)

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

export type ThemeMode = 'light' | 'dark' | 'auto'

function initialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
  } catch { /* private mode */ }
  // No stored override — 'auto' (follow the system).
  return 'auto'
}

function applyThemeMeta(t: 'light' | 'dark') {
  // The two media-scoped theme-color metas only track the system; a manual
  // override must pin them (iOS status bar / PWA chrome) to the active color.
  const c = t === 'light' ? '#faf9f6' : '#0d0d0d'
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', c))
}

/** Theme MODE (light/dark/auto) — what the user cycles. The theme.css
 *  contract: no data-theme attribute = follow prefers-color-scheme (auto). */
export const themeMode = writable<ThemeMode>(initialTheme())

/** Resolved theme for icon rendering: auto resolves to the system preference. */
export const theme = writable<'light' | 'dark'>(initialTheme() === 'dark' ? 'dark' : 'light')

function resolvedFrom(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

function applyMode(mode: ThemeMode) {
  if (mode === 'auto') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', mode)
  }
  const resolved = resolvedFrom(mode)
  theme.set(resolved)
  applyThemeMeta(resolved)
}

if (typeof document !== 'undefined') {
  const mode = initialTheme()
  applyMode(mode)
  themeMode.set(mode)
  // auto follows live system changes.
  if (typeof matchMedia !== 'undefined') {
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      if (get(themeMode) === 'auto') applyMode('auto')
    })
  }
}

/** Cycle light → dark → auto (follow system), persist, apply immediately. */
export function toggleTheme() {
  themeMode.update((m) => {
    const next: ThemeMode = m === 'light' ? 'dark' : m === 'dark' ? 'auto' : 'light'
    try { localStorage.setItem(THEME_KEY, next) } catch { /* private mode */ }
    applyMode(next)
    return next
  })
}
