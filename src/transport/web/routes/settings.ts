import type { Hono } from 'hono'
import {
  fetchProviderModels, globalConfigPath, patchProvider, summarize, writeConfig,
  type ProviderPatch,
} from '../../../core/settings-service.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanSkills, readSources, writeSources, toggleSkill } from '../../../core/skills-manager.js'

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

  // ── M5-tail 技能源管理（用户约定：源可注册，生效 = symlink 进
  //    ~/.config/opencode/skills）────────────────────────────────────────
  app.get('/api/settings/skills-manager', (c) => {
    const stateDir = c.req.query('stateDir') ?? process.env.OCRC_STATE_DIR ?? join(process.env.HOME ?? '', '.ocrc')
    try {
      return c.json(scanSkills(stateDir, process.env.HOME ?? ''))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  app.post('/api/settings/skills-manager/sources', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dir?: string; remove?: boolean }
    if (!body.dir) return c.json({ error: 'dir required' }, 400)
    const stateDir = c.req.query('stateDir') ?? process.env.OCRC_STATE_DIR ?? join(process.env.HOME ?? '', '.ocrc')
    const cur = readSources(stateDir)
    const next = body.remove ? cur.filter((d) => d !== body.dir) : [...new Set([...cur, body.dir])]
    writeSources(stateDir, next)
    return c.json({ ok: true, sources: next })
  })

  app.post('/api/settings/skills-manager/toggle', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; source?: string; enabled?: boolean }
    if (!body.name || !body.source || body.enabled == null) return c.json({ error: 'name, source, enabled required' }, 400)
    return c.json(toggleSkill(process.env.HOME ?? '', body.name, body.source, body.enabled))
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
