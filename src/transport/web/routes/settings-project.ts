import type { Hono } from 'hono'
import {
  projectOverview, readProjectFile, writeProjectFile, readMapping, applyMapping,
  readMcpEntries, setMcpEntry, readAgentEntries, setAgentEntry } from '../../../core/settings-project.js'

/**
 * 0.27 M5-2 routes — project `.opencode/` management, agent model-mapping
 * presets, MCP entry editing. All writes validate + back up + atomic-write
 * (see settings-project.ts).
 */
export function registerSettingsProject(app: Hono, stateDir: string, globalConfigRaw?: () => string | undefined) {
  app.get('/api/settings/project', (c) => {
    const dir = c.req.query('dir')
    if (!dir) return c.json({ error: 'dir required' }, 400)
    try {
      return c.json(projectOverview(dir))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  app.get('/api/settings/project/file', (c) => {
    const dir = c.req.query('dir')
    const rel = c.req.query('path')
    if (!dir || !rel) return c.json({ error: 'dir and path required' }, 400)
    return c.json(readProjectFile(dir, rel))
  })

  app.put('/api/settings/project/file', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dir?: string; path?: string; content?: string }
    if (!body.dir || !body.path || typeof body.content !== 'string') return c.json({ error: 'dir, path, content required' }, 400)
    const r = writeProjectFile(body.dir, body.path, body.content)
    return c.json(r, r.ok ? 200 : 400)
  })

  /** Current mapping (from the GLOBAL config raw) + presets for this project. */
  app.get('/api/settings/model-presets', (c) => {
    const dir = c.req.query('dir')
    if (!dir) return c.json({ error: 'dir required' }, 400)
    return c.json(readMapping(globalConfigRaw?.(), stateDir))
  })

  /** Apply a mapping to the PROJECT config + persist as a named preset.
   *  body {name, mapping} — name '' = apply without saving a preset. */
  app.post('/api/settings/model-presets', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dir?: string; name?: string; mapping?: Record<string, string>; import?: boolean }
    if (!body.dir || !body.mapping || typeof body.name !== 'string') return c.json({ error: 'dir, name, mapping required' }, 400)
    return c.json(applyMapping(body.dir, stateDir, body.name, body.mapping))
  })

  /** MCP entries for the project + upsert/remove. */
  app.get('/api/settings/project/mcp', (c) => {
    const dir = c.req.query('dir')
    if (!dir) return c.json({ error: 'dir required' }, 400)
    return c.json({ mcp: readMcpEntries(dir) })
  })

  app.post('/api/settings/project/mcp', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dir?: string; id?: string; entry?: Record<string, unknown> | null }
    if (!body.dir || !body.id || body.entry === undefined) return c.json({ error: 'dir, id, entry required' }, 400)
    return c.json(setMcpEntry(body.dir, body.id, body.entry))
  })

  // U4: the /z/ subagents panel's read/write face (project-level agent node).
  app.get('/api/settings/project/agents', (c) => {
    const dir = c.req.query('dir')
    if (!dir) return c.json({ error: 'dir required' }, 400)
    return c.json({ agents: readAgentEntries(dir) })
  })

  app.post('/api/settings/project/agents', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dir?: string; id?: string; patch?: Record<string, unknown> | null }
    if (!body.dir || !body.id || body.patch === undefined) return c.json({ error: 'dir, id, patch required' }, 400)
    return c.json(setAgentEntry(body.dir, body.id, body.patch))
  })
}
