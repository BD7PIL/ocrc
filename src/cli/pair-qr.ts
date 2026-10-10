// pair-qr.ts — fetch the live pending QR from the host's onboarding surface.
// Split out of pair.ts so tests can stub it (the CLI prints whatever this
// returns below the session-start confirmation).
export async function qrPendingFromOnboarding(webPort: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/pair/onboarding`)
    if (!res.ok) return null
    const body = (await res.json()) as { status?: string; svg?: string; url?: string }
    if (body.status !== 'on' || !body.svg) return null
    return `${body.svg}\n${body.url ?? ''}`
  } catch {
    return null
  }
}
