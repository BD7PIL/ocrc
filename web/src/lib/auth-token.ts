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

/** Parse a PENDING pairing token out of a fragment like `#pair=abc` (M11).
 * Pending tokens are short-lived and single-use: the PWA exchanges them at
 * POST /api/pair/exchange for the real token (see auth.ts boot flow). */
export function readPairPendingFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h) return null
  const t = new URLSearchParams(h).get('pair')
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
 *
 * The ONE exception is auth failure: auth-reload.ts strips the fragment before
 * its reload, because a token the server just REJECTED must not be re-seeded
 * from the URL on the next boot (that reproduces the 401 forever).
 */
export function captureToken(loc: Location = window.location): string | null {
  const fromHash = readTokenFromHash(loc.hash)
  if (fromHash) {
    const stored = getToken()
    // An old tab URL (or a phone home-screen icon) carries the token from ITS
    // pairing era. If we already hold a DIFFERENT token — e.g. the server side
    // was rotated (撤销配对) and this device re-paired — the hash must NOT
    // re-seed it, or every boot resurrects a dead credential (WS/HTTP 401
    // loop, "must refresh forever"). A first pairing on a fresh device
    // (nothing stored yet) still takes the hash.
    if (!stored || stored === fromHash) {
      setToken(fromHash)
      return fromHash
    }
  }
  return getToken()
}

// NOTE: the early fragment capture at module init lives in auth.ts (the auth
// store), which seeds localStorage before any component/API runs. This module
// stays a pure token-box (read/capture/clear) so it stays trivially testable.
