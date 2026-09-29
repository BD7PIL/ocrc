// src/lib/auth.ts
//
// Single source of truth for web auth state. Reload is NOT part of the state
// machine — the historical bug class (first-visit refresh loop, "reconnecting"
// flash) came from handling auth failures with location.reload() while the
// pairing URL fragment re-seeded localStorage on every boot. Instead:
//
//   boot   → fragment token (if any) is persisted BEFORE any component/API runs,
//            and the store starts as 'ready' (token present) or 'pairing'.
//   401    → onUnauthorized() flips the store; the layout reactively shows the
//            PairGate over the app. No reload. Both API and WS clients read the
//            token fresh per request/connection, so a newly submitted token
//            takes effect on the very next call without re-initializing.
//   pair   → submitPairing() persists the token and flips the store to 'ready';
//            the layout boots the connection reactively.
//
// The only reload left is the legacy Cloudflare Access path (no app token):
// CF's interactive login must render in this window, and the reload-once flag
// in auth-reload.ts guards that loop.

import { get, writable } from 'svelte/store'
import { readTokenFromHash, readPairPendingFromHash, getToken, setToken, clearToken } from './auth-token.js'
import { handleAuthFailure } from './auth-reload.js'

export type AuthStatus = 'booting' | 'ready' | 'pairing' | 'rejected'

/** Reactive auth status driving the layout's PairGate and connection boot. */
export const auth = writable<AuthStatus>('booting')

/**
 * Set when a `#pair=` link failed to exchange (expired, already used, wrong
 * host) — the PairGate surfaces it instead of the generic paste prompt.
 */
export const pairHint = writable<string>('')

// Module-init seeding: Svelte runs child onMount hooks before the layout's, so
// panels mounted by the layout would fire requests before any onMount-level
// capture ran. Module init happens before every component mounts.
//
// M11: a `#pair=<pending>` fragment (short-lived single-use pairing token) is
// exchanged for the real token BEFORE anything else runs. The exchange endpoint
// is intentionally unauthenticated — the pending token IS the credential. On
// success the flow ends in 'ready'; on failure the gate shows why. The fragment
// is stripped either way: unlike `#token` (kept for the iOS home-screen launch
 // path), a pending token is single-use — keeping it would retry a dead token
// on every launch.
let bootPairPending: string | null = null
if (typeof location !== 'undefined' && typeof window !== 'undefined') {
  const early = readTokenFromHash(location.hash)
  if (early) setToken(early)
  bootPairPending = readPairPendingFromHash(location.hash)
  if (bootPairPending) {
    history.replaceState(null, '', location.pathname + location.search)
  }
}
if (bootPairPending) {
  auth.set('booting')
  void (async () => {
    try {
      const res = await fetch('/api/pair/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pending: bootPairPending }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { token?: string }
      if (!data.token) throw new Error('no token')
      setToken(data.token)
      pairHint.set('')
      auth.set('ready')
    } catch {
      pairHint.set('配对链接已失效（1 分钟过期或已被使用）——请在主机上刷新二维码后重试。')
      auth.set('pairing')
    }
  })()
} else {
  auth.set(getToken() ? 'ready' : 'pairing')
}

/**
 * Accept a `#pair=` link (or raw pending token) from the in-app gate: exchange
 * it for the real token and pair. Resolves to an error message on failure,
 * '' on success.
 */
export async function exchangePairLink(link: string): Promise<string> {
  const m = link.trim().match(/[?#]pair=([^&#\s]+)/)
  const pending = m ? decodeURIComponent(m[1]) : link.trim()
  if (!pending) return '这看起来不是有效的配对链接。'
  try {
    const res = await fetch('/api/pair/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ pending }),
    })
    if (!res.ok) throw new Error(String(res.status))
    const data = (await res.json()) as { token?: string }
    if (!data.token || !submitPairing(data.token)) return '这看起来不是有效的配对链接。'
    pairHint.set('')
    return ''
  } catch {
    return '配对链接已失效（1 分钟过期或已被使用）——请刷新二维码后重试。'
  }
}

/**
 * Handle a 401 from any API call.
 *  - No app token → legacy CF Access path (reload once so the edge login can
 *    render; flag-guarded in auth-reload.ts).
 *  - Fragment carries a NEWER token than the rejected stored one → adopt it;
 *    the next request rides it (one-shot retry — if the fragment token is also
 *    rejected, the next 401 takes the 'rejected' branch below).
 *  - Fragment IS the rejected token (the freshest credential we have) →
 *    'rejected': only a fresh /pair link can help, so show the gate. Reloading
 *    cannot change the outcome and would just loop.
 *  - Plain stale stored token → wipe and show the gate ('pairing').
 */
export function onUnauthorized(): void {
  const stored = getToken()
  if (!stored) {
    // No app token. If the gate is already up (pairing/rejected) this 401 is
    // just a straggler request from behind it — ignore. A no-token 401 while
    // we believed we were authed can only be CF Access mode → legacy reload.
    if (get(auth) === 'ready') handleAuthFailure()
    return
  }
  const fragment = typeof location !== 'undefined' ? readTokenFromHash(location.hash) : null
  if (fragment && fragment !== stored) {
    setToken(fragment)
    auth.set('ready')
    return
  }
  if (fragment) {
    auth.set('rejected')
    return
  }
  clearToken()
  auth.set('pairing')
}

/**
 * Accept a pairing token from the in-app gate (already parsed down to the raw
 * token string). Persists it and flips the store — the layout boots the API/WS
 * connection reactively; no reload.
 */
export function submitPairing(token: string): boolean {
  const t = token.trim()
  if (!t || t.length < 16) return false
  setToken(t)
  auth.set('ready')
  return true
}
