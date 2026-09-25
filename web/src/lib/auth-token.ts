// src/lib/auth-token.ts
//
// Token-based web auth (no Cloudflare Access dependency).
//
// The pairing URL (`ocrc pair` / Telegram `/pair`) carries the token in the URL
// *fragment* (`#token=…`) so it never reaches the server, a proxy, or access
// logs. On first load we capture it into localStorage, strip it from the address
// bar, and thereafter attach it to every API request (`Authorization: Bearer`)
// and WebSocket connect (`?token=`). localStorage persists across an "install as
// app", so a paired device stays signed in.

const STORAGE_KEY = 'ocrc.token'

/** Parse a `token` value out of a URL fragment like `#token=abc` or `#a=1&token=abc`. */
export function readTokenFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h) return null
  const t = new URLSearchParams(h).get('token')
  return t && t.trim() ? t.trim() : null
}

export function getToken(): string | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    return t && t.trim() ? t : null
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try { localStorage.setItem(STORAGE_KEY, token) } catch { /* storage unavailable */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* storage unavailable */ }
}

/**
 * On app load: if the URL fragment carries a token, persist it to localStorage.
 * Returns the active token — the one just captured, or the previously stored one.
 *
 * NOTE: we intentionally KEEP `#token` in the URL (we don't strip it). iOS Safari
 * "Add to Home Screen" bookmarks the current URL, and an installed iOS PWA does
 * NOT share localStorage with Safari — so the token must stay in the URL for the
 * home-screen app to receive it on launch. The fragment is never sent to the
 * server (so it can't leak via logs/proxies); on the user's own device the
 * address-bar exposure is acceptable, and in standalone mode the bar is hidden.
 */
export function captureToken(loc: Location = window.location): string | null {
  const fromHash = readTokenFromHash(loc.hash)
  if (fromHash) {
    setToken(fromHash)
    return fromHash
  }
  return getToken()
}

// OCRC-fork spike fix: capture a fragment token at MODULE-INIT time, not in the
// layout's onMount. Svelte runs child onMount hooks before the parent's, so
// panels mounted by the layout (e.g. McpPanel) fetch /api/* before onMount-level
// captureToken() has persisted the `#token=` value — their requests go out with
// no Authorization header, the 401 handler wipes the just-captured token and
// reloads, the (never-stripped) fragment re-seeds it, and the page loops forever
// (observed as a flashing "reconnecting" page on a real phone). Module init runs
// before any component mounts, closing the race.
if (typeof location !== 'undefined' && typeof window !== 'undefined') {
  const early = readTokenFromHash(location.hash)
  if (early) setToken(early)
}
