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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
/** The sections the bridge carries from the panel-host opencode.json. */
export const BRIDGE_SECTIONS = ['agent', 'agents', 'mcp', 'providers', 'provider'];
/** Locate the panel-host opencode.json the way openchamber does:
 *  OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config, then opencode.json[c]. */
export function resolvePanelConfigPath(env = process.env) {
    const dir = env.OPENCODE_CONFIG_DIR?.trim()
        || (env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME.trim(), 'opencode') : '')
        || join(homedir(), '.config', 'opencode');
    return join(dir, 'opencode.json');
}
export function resolvePanelAgentsDir(env = process.env) {
    const cfg = resolvePanelConfigPath(env);
    return join(cfg, '..', 'agents');
}
/** Inventory the panel-host artifacts WITHOUT reading secret-bearing values
 *  into the response (providers section lists ids only — the keys themselves
 *  live in the engine's auth store, not in this file, but stay conservative). */
export function inspectConfigSource(env = process.env, exists = (p) => existsSync(p), read = (p) => readFileSync(p, 'utf-8'), listDir = (p) => readdirSync(p), stat = (p) => statSync(p)) {
    const configPath = resolvePanelConfigPath(env);
    const report = { configPath, exists: exists(configPath), sections: {}, agentFiles: [] };
    if (report.exists) {
        try {
            const raw = read(configPath);
            const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
            for (const section of BRIDGE_SECTIONS) {
                const node = cfg[section];
                if (node && typeof node === 'object' && !Array.isArray(node)) {
                    report.sections[section] = Object.keys(node).sort();
                }
            }
        }
        catch (e) {
            report.parseError = e instanceof Error ? e.message : String(e);
        }
    }
    const agentsDir = resolvePanelAgentsDir(env);
    if (exists(agentsDir)) {
        try {
            for (const name of listDir(agentsDir).filter((f) => f.endsWith('.md')).sort()) {
                const p = join(agentsDir, name);
                try {
                    report.agentFiles.push({ name: name.replace(/\.md$/, ''), path: p, size: stat(p).size });
                }
                catch { /* raced away */ }
            }
        }
        catch { /* unreadable dir — empty list */ }
    }
    return report;
}
/** Deep merge: panel wins per leaf; remote-only branches survive untouched. */
export function deepMerge(remote, panel) {
    if (panel === undefined)
        return remote;
    if (remote === undefined || remote === null)
        return panel;
    if (typeof panel !== 'object' || Array.isArray(panel) || typeof remote !== 'object' || Array.isArray(remote)) {
        return panel; // scalar/array: panel replaces
    }
    const out = { ...remote };
    for (const [k, v] of Object.entries(panel)) {
        out[k] = deepMerge(out[k], v);
    }
    return out;
}
/** Extract the bridge payload from a parsed panel config (sections only). */
export function extractBridgeSections(panelConfig) {
    const out = {};
    for (const section of BRIDGE_SECTIONS) {
        if (panelConfig[section] !== undefined)
            out[section] = panelConfig[section];
    }
    return out;
}
/** The remote-side apply script: read the current remote file, merge the
 *  bridge JSON (stdin, base64) over it, back up, atomic-write. The merge runs
 *  IN the remote shell via node? No — the remote may have no node. Instead the
 *  SERVICE does the merge: it fetches the remote file first (preview), merges
 *  locally, and this script just does backup + atomic write of the merged
 *  document. Simpler, and no remote-side runtime assumptions. */
export function buildConfigApplyScript(vpath) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    return [
        'set -e',
        `P=${q(vpath)}`,
        'D=$(dirname "$P")',
        'mkdir -p "$D"',
        'T=$(mktemp "$D/.ocrc-cfg.XXXXXX")',
        'base64 -d > "$T"',
        'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak"; echo "bak: $P.ocrc-bak"; fi',
        'mv "$T" "$P"',
        'echo "written: $P"',
    ].join('\n');
}
