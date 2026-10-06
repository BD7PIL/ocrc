import type { Hono } from 'hono'
import {
  fetchProviderModels, globalConfigPath, patchProvider, summarize, writeConfig,
  type ProviderPatch,
} from '../../../core/settings-service.js'
import { readFileSync } from 'node:fs'

/**
 * 0.27 M5 设置域 routes. Every write validates + backs up + atomic-writes
 * (settings-service); the UI layers RiskConfirmation on top.
 */
export function registerSettings(app: Hono, configDir?: string) {
  const path = () => globalConfigPath(configDir)

  app.get('/api/settings/opencode-config', (c) => {
    try {
      return c.json(summarize(readFileSyncSafe(path()), path()))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  /** Whole-document write (raw editor). Body {raw}. */
  app.put('/api/settings/opencode-config', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { raw?: string }
    if (typeof body.raw !== 'string') return c.json({ error: 'raw required' }, 400)
    try {
      writeConfig(path(), body.raw)
      return c.json({ ok: true })
    } catch (err) {
      // app-level error with 200: the client surfaces the message without a
      // throw (and without a console resource-noise entry)
      return c.json({ ok: false, error: (err as Error).message })
    }
  })

  /** Structured provider patch (baseURL / apiKey / models write-back). */
  app.post('/api/settings/opencode-config/provider', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Partial<ProviderPatch>
    if (!body.providerId) return c.json({ error: 'providerId required' }, 400)
    try {
      patchProvider(path(), body as ProviderPatch)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message })
    }
  })

  /** Pull a provider's /models list (OpenAI-shaped). */
  app.post('/api/settings/fetch-models', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { baseURL?: string; apiKey?: string }
    if (!body.baseURL) return c.json({ error: 'baseURL required' }, 400)
    try {
      const models = await fetchProviderModels(body.baseURL, body.apiKey)
      return c.json({ models })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })
}

/** Tolerant read (missing file = empty doc). */
function readFileSyncSafe(path: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return '{\n}' }
}
