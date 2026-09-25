// src/lib/auth-reload.ts
import { getToken, clearToken } from './auth-token.js'

export const AUTH_RELOAD_FLAG = 'ocrc.authReloaded'

/**
 * A 401. Two auth modes need different handling:
 *
 *  - Token auth (the default): a 401 means the stored token is stale/wrong (e.g.
 *    the hub regenerated it, or this is an old bookmark). Clear it and reload —
 *    on next load there's no token, so the app drops to the in-app PairGate to
 *    re-pair instead of looping forever on "reconnecting + 401".
 *  - CF Access: no app token is stored; reload once so CF's interactive login
 *    renders in the app window and bounces back. A sessionStorage flag prevents a
 *    reload loop if login genuinely fails; clearAuthReloadFlag() is called on a
 *    successful authed request so a later expiry can reload again.
 *
 *  OCRC-fork spike fix: the pairing `#token=` fragment is intentionally never
 *  stripped from the URL (iOS home-screen support), so if it is still present it
 *  re-seeds localStorage on every boot. Clearing the token alone would then
 *  reproduce the exact same 401 on the next load → reload → 401 forever (seen on
 *  a real phone as a flashing page stuck in "reconnecting"). Before reloading,
 *  rewrite the fragment out of the URL so a cleared token stays cleared.
 */
export function handleAuthFailure(loc: Pick<Location, 'reload'> = window.location): void {
  if (getToken()) {
    // Stale token → wipe it so the reloaded app shows PairGate (no reload-loop:
    // once cleared there's no token to re-reject).
    clearToken()
    try {
      const { pathname, search } = window.location
      window.history.replaceState(null, '', pathname + search)
    } catch { /* best effort — e.g. exotic webviews with restricted history */ }
    loc.reload()
    return
  }
  try {
    if (sessionStorage.getItem(AUTH_RELOAD_FLAG)) return
    sessionStorage.setItem(AUTH_RELOAD_FLAG, '1')
  } catch { /* sessionStorage unavailable — fall through to reload */ }
  loc.reload()
}

export function clearAuthReloadFlag(): void {
  try { sessionStorage.removeItem(AUTH_RELOAD_FLAG) } catch { /* ignore */ }
}
