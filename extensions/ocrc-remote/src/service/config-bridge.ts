/** config-bridge — batch 5 (2.0.0-alpha.5).
 *
 * The openchamber panel writes agent/MCP/provider config to the PANEL HOST's
 * `~/.config/opencode/` (source-verified: `lib/opencode/shared.js` resolves
 * OPENCODE_CONFIG_DIR/XDG/~/.config/opencode; Agents UI writes flat
 * `agents/<name>.md`; MCP writes `mcp.servers` into opencode.json). An EXTERNAL
 * engine on the controlled host reads its own disk — those panel edits never
 * reach it (same class of upstream gap as Files/Git, #3113).
 *
 * The bridge closes it: read the panel-host artifacts, deep-merge the relevant
 * sections into a bridge payload, and apply it to the REMOTE's
 * `~/.config/opencode/opencode.json` over the existing ssh exec face.
 * Merge policy (deliberate, tested):
 *  - remote-only keys are ALWAYS preserved (never a whole-file overwrite);
 *  - panel sections win on conflict (agent/mcp.servers/providers), because the
 *    user just edited them in the panel UI;
 *  - the remote file is backed up to *.ocrc-bak first (syncConfig family
 *    semantics), so one more apply with an empty source = rollback.
 * ocrc-owned keys (plugins array, mcp.ocrc) ride along untouched — deep merge
 * preserves whatever the panel payload does not mention.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** The sections the bridge carries from the panel-host opencode.json. */
/** 面板配置里可以桥接到被控端的段。**写的目标永远是项目级**（D10）——
 *  历史遗留的「写被控端全局配置」路径已在 2026-10-16 移除，别把它加回来。 */
export const BRIDGE_SECTIONS = ['agent', 'agents', 'mcp', 'providers', 'provider'] as const
export type BridgeSection = (typeof BRIDGE_SECTIONS)[number]

export interface ConfigSourceReport {
  configPath: string
  exists: boolean
  sections: Partial<Record<BridgeSection, string[]>> // section → entry names
  agentFiles: Array<{ name: string; path: string; size: number }>
  parseError?: string
}

/** Locate the panel-host opencode.json the way openchamber does:
 *  OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > (%APPDATA%\opencode on Windows) >
 *  ~/.config, then opencode.json[c]. The %APPDATA% branch runs only on win32 —
 *  Windows has no XDG convention, and the ~/.config fallback left the
 *  配置同步 tab empty on real Windows panel hosts (PRODUCT.md Windows 余项). */
export function resolvePanelConfigPath(
  env: { OPENCODE_CONFIG_DIR?: string; XDG_CONFIG_HOME?: string; APPDATA?: string } = process.env as Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = env.OPENCODE_CONFIG_DIR?.trim()
    || (env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME.trim(), 'opencode') : '')
    || (platform === 'win32' && env.APPDATA?.trim() ? join(env.APPDATA.trim(), 'opencode') : '')
    || join(homedir(), '.config', 'opencode')
  return join(dir, 'opencode.json')
}

export function resolvePanelAgentsDir(
  env: { OPENCODE_CONFIG_DIR?: string; XDG_CONFIG_HOME?: string; APPDATA?: string } = process.env as Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  const cfg = resolvePanelConfigPath(env, platform)
  return join(cfg, '..', 'agents')
}

/** Inventory the panel-host artifacts WITHOUT reading secret-bearing values
 *  into the response (providers section lists ids only — the keys themselves
 *  live in the engine's auth store, not in this file, but stay conservative). */
export function inspectConfigSource(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>, exists: (p: string) => boolean = (p) => existsSync(p), read = (p: string) => readFileSync(p, 'utf-8'), listDir = (p: string) => readdirSync(p), stat: (p: string) => { size: number } = (p) => statSync(p)): ConfigSourceReport {
  const configPath = resolvePanelConfigPath(env)
  const report: ConfigSourceReport = { configPath, exists: exists(configPath), sections: {}, agentFiles: [] }
  if (report.exists) {
    try {
      const raw = read(configPath)
      const cfg = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
      for (const section of BRIDGE_SECTIONS) {
        const node = cfg[section]
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          report.sections[section] = Object.keys(node as Record<string, unknown>).sort()
        }
      }
    } catch (e) {
      report.parseError = e instanceof Error ? e.message : String(e)
    }
  }
  const agentsDir = resolvePanelAgentsDir(env)
  if (exists(agentsDir)) {
    try {
      for (const name of listDir(agentsDir).filter((f) => f.endsWith('.md')).sort()) {
        const p = join(agentsDir, name)
        try {
          report.agentFiles.push({ name: name.replace(/\.md$/, ''), path: p, size: stat(p).size })
        } catch { /* raced away */ }
      }
    } catch { /* unreadable dir — empty list */ }
  }
  return report
}

export interface RemoteFileReader {
  (path: string): Promise<string | null> // null = missing/unreadable
}
