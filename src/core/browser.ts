import { createLogger } from '../utils/logger.js'

const log = createLogger('browser')

/**
 * 0.27 M7 侧车浏览器 — drive an ALREADY-RUNNING headless Chromium over CDP
 * (default http://127.0.0.1:9222, the same shell the CDP self-checks use).
 * No browser download, no new runtime dependency at install time: the
 * playwright-core import is dynamic and the endpoints degrade gracefully
 * ("browser support not installed") when it's absent. Click/type coordinates
 * are PERCENTAGES of the viewport — the panel maps screenshot pixels itself.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PW = any

let pwCache: PW | null | undefined
let browser: PW | null = null
let page: PW | null = null
let pageDeadline = 0

async function pw(): Promise<PW | null> {
  if (pwCache !== undefined) return pwCache
  try {
    pwCache = await import('playwright-core')
  } catch {
    log.warn('playwright-core not installed — browser pane disabled')
    pwCache = null
  }
  return pwCache
}

async function ensurePage(): Promise<PW> {
  const now = Date.now()
  if (page && now < pageDeadline) return page
  page = null
  const lib = await pw()
  if (!lib) throw new Error('browser support not installed (playwright-core missing)')
  const cdpUrl = process.env.OCRC_BROWSER_CDP_URL ?? 'http://127.0.0.1:9222'
  if (!browser || !browser.isConnected?.()) {
    browser = await lib.chromium.connectOverCDP(cdpUrl)
    log.info(`browser sidecar connected: ${cdpUrl}`)
  }
  const contexts = browser.contexts()
  const ctx = contexts[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 800 } }))
  page = ctx.pages()[0] ?? (await ctx.newPage())
  pageDeadline = now + 5 * 60_000
  return page
}

/** Run a browser action; if the cached CDP connection went stale (the
 *  playwright client that created pages disconnected), reset and retry once. */
async function withPage<T>(fn: (p: PW) => Promise<T>): Promise<T> {
  try {
    const p = await ensurePage()
    return await fn(p)
  } catch (err) {
    if (!/closed|Target page|Target closed|Browser has been closed/i.test((err as Error).message)) throw err
    log.warn('sidecar connection stale — reconnecting once')
    browser = null
    page = null
    const p = await ensurePage()
    return await fn(p)
  }
}

/** Drop the CDP connection (called on transport stop / idle). */
export function disposeBrowser(): void {
  page = null
  browser = null
  pageDeadline = 0
}

export async function browserNavigate(url: string): Promise<{ url: string; title: string }> {
  return withPage(async (p) => {
    await p.goto(url, { timeout: 30_000, waitUntil: 'load' }).catch((err: Error) => log.warn(`goto ${url}: ${err.message}`))
    return { url: p.url(), title: await p.title() }
  })
}

export async function browserState(): Promise<{ url: string; title: string; screenshot: string }> {
  return withPage(async (p) => {
    const shot = await p.screenshot({ type: 'png' })
    return { url: p.url(), title: await p.title(), screenshot: shot.toString('base64') }
  })
}

export async function browserClick(xPct: number, yPct: number): Promise<void> {
  const p = await ensurePage()
  const vp = p.viewportSize() ?? { width: 1280, height: 800 }
  await p.mouse.click(Math.round((xPct / 100) * vp.width), Math.round((yPct / 100) * vp.height))
}

export async function browserType(text: string): Promise<void> {
  const p = await ensurePage()
  await p.keyboard.type(text, { delay: 20 })
}

export async function browserScroll(dyPct: number): Promise<void> {
  const p = await ensurePage()
  const vp = p.viewportSize() ?? { width: 1280, height: 800 }
  await p.mouse.wheel(0, Math.round((dyPct / 100) * vp.height))
}

export async function browserBack(): Promise<void> {
  const p = await ensurePage()
  await p.goBack({ timeout: 15_000 }).catch(() => {})
}
