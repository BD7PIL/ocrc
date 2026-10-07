import type { Hono } from 'hono'
import { browserBack, browserClick, browserNavigate, browserScroll, browserState, browserType } from '../../../core/browser.js'

/** 0.27 M7 — sidecar browser control (authed). Errors carry app-level
 *  {ok:false,error} with 200 so the pane shows them without throw noise. */
export function registerBrowser(app: Hono) {
  app.get('/api/browser/state', async (c) => {
    try {
      const state = await browserState()
      return c.json({ ok: true, ...state })
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message })
    }
  })

  app.post('/api/browser/navigate', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { url?: string }
    if (!body.url) return c.json({ ok: false, error: 'url required' })
    try {
      const url = /^https?:\/\//.test(body.url) ? body.url : `https://${body.url}`
      return c.json({ ok: true, ...(await browserNavigate(url)) })
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message })
    }
  })

  app.post('/api/browser/click', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { xPct?: number; yPct?: number }
    if (body.xPct == null || body.yPct == null) return c.json({ ok: false, error: 'xPct/yPct required' })
    await browserClick(body.xPct, body.yPct).catch(() => {})
    return c.json({ ok: true })
  })

  app.post('/api/browser/type', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { text?: string }
    if (typeof body.text !== 'string') return c.json({ ok: false, error: 'text required' })
    await browserType(body.text).catch(() => {})
    return c.json({ ok: true })
  })

  app.post('/api/browser/scroll', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dyPct?: number }
    await browserScroll(body.dyPct ?? 25).catch(() => {})
    return c.json({ ok: true })
  })

  app.post('/api/browser/back', (c) => {
    void browserBack()
    return c.json({ ok: true })
  })
}
