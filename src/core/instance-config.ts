/**
 * C1–C4 — pushing our opencode config and credentials to the peer that runs the
 * instance.
 *
 * The peer's engine reads **its own** `~/.config/opencode` (the panel host's
 * config never travels there by itself), and openchamber's provider UI cannot
 * delete a provider — so this sync is the only path that can express "the peer
 * should have what I have". Three rules come straight from the plan and are
 * enforced here rather than in the UI:
 *
 *   · **Diff first, and only on demand.** Nothing is pushed implicitly; the
 *     panel/CLI shows local-vs-peer (both directions) and the user triggers one
 *     sync. A silent push would rewrite a peer's config behind their back.
 *   · **Never a whole-file overwrite.** `opencode.json` is deep-merged by the
 *     shared engine (`core/config-merge.ts`), so keys we do not mention survive;
 *     `plugins`/`plugin` are dropped because the peer's own openchamber owns them
 *     (`~/.config/openchamber/opencode.managed.json`, upstream-verified).
 *   · **Deletions are explicit.** Files that exist only on the peer are
 *     *reported*, never removed unless the caller names them (`deletes`). That
 *     is what makes "local deleted a provider → the peer's copy goes too"
 *     possible without turning a sync into a wipe.
 *
 * The peer side is two round trips, both POSIX sh + coreutils (`base64`,
 * `sha256sum`, `tar`), because EL7 is the floor: read (base64 + hashes) and
 * apply (tar on stdin, `.ocrc-bak` before every overwrite).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { dirname, join, relative, sep } from 'node:path'
import { parseConfig, stripJsonc } from '../utils/jsonc.js'
import { hasChanges, mergeSticky, stripLiteralSecrets } from './config-merge.js'
import type { PeerPluginEntry } from './components.js'

/** The peer's user-level config dir — the one the instance's engine reads. */
export const PEER_CONFIG_DIR = '$HOME/.config/opencode'
/** opencode keeps provider credentials here, not in the config file. */
export const PEER_AUTH_PATH = '$HOME/.local/share/opencode/auth.json'

/** What travels. `plugin/` stays out on purpose: the peer's own openchamber owns
 *  its plugin layer, and pushing ours would fight it. */
export const INSTANCE_SYNC_ENTRIES = [
  'opencode.json', 'opencode.jsonc', 'AGENTS.md', 'CLAUDE.md',
  'command', 'agent', 'skill', 'agents', 'skills', 'oh-my-opencode-slim.json',
  'reeve.jsonc',
  // GATE 代理层配置目录（`~/.config/opencode/reeve/`，里面是 fallback.jsonc）：链/策略/供应商。
  // 它是两端应当同值的"声明"（面板编辑的就是它）→ 进 sync；台账/快照/pid 那些运行态不进。
  'reeve',
] as const

const CONFIG_CANDIDATES = ['opencode.json', 'opencode.jsonc'] as const

/**
 * Config file load order, source-verified against openchamber
 * (`server/lib/opencode/shared.js`: `userPaths = [opencode.json, opencode.jsonc]`,
 * `getPrimaryUserConfigPath` = the first that exists, and `readConfigLayers`
 * merges the `.jsonc` **over** the `.json`).
 *
 * Two consequences the sync must respect, and did not before:
 *   · the **effective** local config is both layers merged, not just the first
 *     file — reading only `opencode.json` would sync an incomplete picture;
 *   · on the peer, the `.jsonc` **overrides** the `.json` for the keys it sets,
 *     so a merged document written to `opencode.json` can be silently overridden
 *     by an existing `opencode.jsonc`. We therefore write to the file that
 *     actually wins there (the `.jsonc` when present) and say so.
 */
export function mergeConfigLayers(layers: readonly ConfigFileState[]): {
  effective: Record<string, unknown>
  errors: string[]
} {
  let effective: Record<string, unknown> = {}
  const errors: string[] = []
  for (const layer of layers) {
    if (layer.parseError) {
      errors.push(`${layer.basename} 解析失败：${layer.parseError}`)
      continue
    }
    if (layer.parsed) effective = mergeSticky(effective, layer.parsed)
  }
  return { effective, errors }
}

export interface ConfigFileState {
  basename: string
  raw: string
  parsed?: Record<string, unknown>
  parseError?: string
  /** A `.jsonc` with comments: the merge writes JSON, so they are lost — the UI
   *  has to say it before the user presses sync. */
  commentsWillBeLost?: boolean
}

export interface FileFingerprint {
  rel: string
  /** First 16 hex chars of sha256; `?` when the peer could not compute one. */
  hash: string
}

export interface LocalConfigState {
  dir: string
  authPath: string
  authPresent: boolean
  /** Every config layer present, in load order (`.jsonc` last = overrides). */
  layers: ConfigFileState[]
  /** Both layers merged the way the engine merges them. */
  effective: Record<string, unknown>
  layerErrors: string[]
  files: FileFingerprint[]
}

export interface PeerConfigState {
  layers: ConfigFileState[]
  effective: Record<string, unknown>
  layerErrors: string[]
  /** The file a merged document must be written to in order to take effect. */
  targetBasename: string
  authPresent: boolean
  files: FileFingerprint[]
}

/** sha256, truncated — we compare, we never need the full digest. */
function shortHash(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Every file under one whitelisted entry, as a path relative to the config dir. */
function walkEntry(dir: string, entry: string, out: FileFingerprint[]): void {
  const abs = join(dir, entry)
  if (!existsSync(abs)) return
  const st = statSync(abs)
  if (st.isFile()) {
    out.push({ rel: toPosix(entry), hash: shortHash(readFileSync(abs)) })
    return
  }
  if (!st.isDirectory()) return
  for (const name of readdirSync(abs)) {
    const child = `${entry}/${name}`
    const childAbs = join(dir, entry, name)
    const childStat = statSync(childAbs)
    if (childStat.isDirectory()) walkEntry(dir, child, out)
    else if (childStat.isFile()) out.push({ rel: toPosix(child), hash: shortHash(readFileSync(childAbs)) })
  }
}

/** Read one config layer from disk (or the peer's base64, see parsePeerConfigRead). */
function parseLayer(basename: string, raw: string): ConfigFileState {
  const format = basename.endsWith('.jsonc') ? 'jsonc' : 'json'
  const file: ConfigFileState = { basename, raw }
  if (format === 'jsonc' && /(^|\n)\s*(\/\/|\/\*)/.test(raw)) file.commentsWillBeLost = true
  const parsed = parseConfig(format === 'jsonc' ? stripJsonc(raw) : raw)
  if (parsed.ok) file.parsed = parsed.parsed
  else file.parseError = parsed.error
  return file
}

/** The control side's config, read the way the peer's will be compared. */
export function readLocalConfig(opts: { dir?: string; authPath?: string } = {}): LocalConfigState {
  const dir = opts.dir ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.config', 'opencode')
  const authPath = opts.authPath ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.local', 'share', 'opencode', 'auth.json')
  const layers: ConfigFileState[] = []
  for (const name of CONFIG_CANDIDATES) {
    const abs = join(dir, name)
    if (!existsSync(abs)) continue
    layers.push(parseLayer(name, readFileSync(abs, 'utf-8')))
  }
  const { effective, errors } = mergeConfigLayers(layers)
  const files: FileFingerprint[] = []
  for (const entry of INSTANCE_SYNC_ENTRIES) walkEntry(dir, entry, files)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { dir, authPath, authPresent: existsSync(authPath), layers, effective, layerErrors: errors, files }
}

/**
 * One ssh round trip: **both** config layers (base64), whether `auth.json`
 * exists, and a hash per whitelisted file. `sha256sum` is coreutils; a host
 * without it reports `?` for every file, which the diff treats as "cannot tell"
 * rather than "identical" — a wrong "same" would silently skip a real change.
 */
export function buildPeerConfigReadScript(): string {
  const list = INSTANCE_SYNC_ENTRIES.join(' ')
  return [
    `D="${PEER_CONFIG_DIR}"`,
    'echo "B64_JSON_BEGIN"',
    '[ -f "$D/opencode.json" ] && base64 < "$D/opencode.json"',
    'echo "B64_JSON_END"',
    'echo "B64_JSONC_BEGIN"',
    '[ -f "$D/opencode.jsonc" ] && base64 < "$D/opencode.jsonc"',
    'echo "B64_JSONC_END"',
    `if [ -f "${PEER_AUTH_PATH}" ]; then echo "AUTH=present"; else echo "AUTH=missing"; fi`,
    'echo "LIST_BEGIN"',
    // Batched + parallel hashing: one sha256sum per 50 files, 4 at a time —
    // the per-file spawn loop cost ~minutes on EL7-class CPUs once the skills
    // tree (~14k files) entered the whitelist. The find list is joined with the
    // hash output so a file that fails to hash still emits `?` ("cannot tell",
    // never "same"); without the join it would vanish and read as "peer lacks
    // it", which turns into a wrong push.
    'F=$(mktemp /tmp/.ocrc-f.XXXXXX 2>/dev/null); H=$(mktemp /tmp/.ocrc-h.XXXXXX 2>/dev/null)',
    'if [ -n "$F" ] && [ -n "$H" ] && cd "$D" 2>/dev/null; then',
    `  for e in ${list}; do [ -e "$e" ] || continue; find "$e" -type f 2>/dev/null; done | sort -u > "$F"`,
    "  tr '\\n' '\\0' < \"$F\" | xargs -0 -r -n50 -P4 sha256sum 2>/dev/null > \"$H\"",
    // sha256sum prints `<64hex>␣␣<name>` (text mode) — name starts at col 67.
    `  awk 'NR==FNR { if (length($0) > 66) h[substr($0,67)] = substr($0,1,16); next } { print (($0 in h) ? h[$0] : "?") " " $0 }' "$H" "$F"`,
    'else',
    // Floor fallback (no mktemp / unwritable /tmp): the original per-file loop.
    `  cd "$D" 2>/dev/null && for e in ${list}; do [ -e "$e" ] || continue; find "$e" -type f 2>/dev/null; done | sort -u | while IFS= read -r rel; do`,
    '    h=$(sha256sum "$rel" 2>/dev/null | cut -c1-16)',
    '    echo "${h:-?} $rel"',
    '  done',
    'fi',
    'rm -f "$F" "$H" 2>/dev/null',
    'echo "LIST_END"',
  ].join('\n')
}

function decodeBlock(stdout: string, name: string): string | undefined {
  const re = new RegExp(`${name}_BEGIN\\r?\\n([\\s\\S]*?)\\r?\\n${name}_END`)
  const block = re.exec(stdout)
  if (!block) return undefined
  const body = block[1].replace(/[\r\n]/g, '')
  if (!body.trim()) return undefined
  return Buffer.from(body, 'base64').toString('utf-8')
}

export function parsePeerConfigRead(stdout: string): PeerConfigState {
  const layers: ConfigFileState[] = []
  const json = decodeBlock(stdout, 'B64_JSON')
  const jsonc = decodeBlock(stdout, 'B64_JSONC')
  if (json !== undefined) layers.push(parseLayer('opencode.json', json))
  if (jsonc !== undefined) layers.push(parseLayer('opencode.jsonc', jsonc))
  const { effective, errors } = mergeConfigLayers(layers)
  const files: FileFingerprint[] = []
  const list = /LIST_BEGIN\r?\n([\s\S]*?)\r?\nLIST_END/.exec(stdout)?.[1] ?? ''
  for (const line of list.split('\n')) {
    const m = /^(\S+)\s+(.+)$/.exec(line.trim())
    if (m) files.push({ hash: m[1], rel: m[2] })
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return {
    layers,
    effective,
    layerErrors: errors,
    // The `.jsonc` wins when it exists (source-verified load order), so that is
    // where a merged document has to land to actually take effect.
    targetBasename: jsonc !== undefined ? 'opencode.jsonc' : 'opencode.json',
    authPresent: /^AUTH=present$/m.test(stdout),
    files,
  }
}

export interface ConfigDiff {
  /** On the control side only. */
  add: string[]
  /** Both sides, different content. */
  change: string[]
  /** Both sides, same content (hash `?` never counts as same). */
  same: string[]
  /** On the peer only — reported, and removed only when named in `deletes`. */
  peerOnly: string[]
  /** Entries the peer could not be hashed for (`?`): "cannot tell", not "same". */
  unknown: string[]
  auth: { local: boolean; peer: boolean }
}

export function diffConfig(local: LocalConfigState, peer: PeerConfigState): ConfigDiff {
  const diff: ConfigDiff = { add: [], change: [], same: [], peerOnly: [], unknown: [], auth: { local: local.authPresent, peer: peer.authPresent } }
  const peerMap = new Map(peer.files.map((f) => [f.rel, f.hash]))
  const localMap = new Map(local.files.map((f) => [f.rel, f.hash]))
  for (const [rel, hash] of localMap) {
    const remote = peerMap.get(rel)
    if (remote === undefined) diff.add.push(rel)
    else if (remote === '?' || hash === '?') diff.unknown.push(rel)
    else if (remote !== hash) diff.change.push(rel)
    else diff.same.push(rel)
  }
  for (const rel of peerMap.keys()) if (!localMap.has(rel)) diff.peerOnly.push(rel)
  diff.add.sort(); diff.change.sort(); diff.same.sort(); diff.peerOnly.sort(); diff.unknown.sort()
  return diff
}

export interface SyncPlan {
  /** The file the merged document is written to on the peer. */
  basename: string
  /** Only the files that actually differ (plus the merged config). */
  files: string[]
  /** The merged document, ready to serialize. */
  merged?: Record<string, unknown>
  configChanged: boolean
  /** The v1 `plugin` key, preserved from the peer (openchamber owns it). */
  preservedPluginKey: boolean
  /** v2 `plugins` entries ocrc is responsible for (from component manifests;
   *  object entries carry the component-declared options). */
  managedPlugins: PeerPluginEntry[]
  /** Legacy: keys dropped because a peer-owned layer manages them. */
  droppedManagedKeys: string[]
  /** Literal secrets replaced by `{env:VAR}` (MCP environment only). */
  secretsReplaced: Array<{ path: string; env: string }>
  /** Peer-only files the caller asked to remove. */
  deletes: string[]
  /** Keys the caller asked to remove from the merged config (`provider:x`). */
  keyDeletes: { requested: string[]; removed: string[] }
  /** Peer-only keys we did NOT remove — the panel offers them as
   *  checkboxes, so the list is the choice the user is being offered.
   *  `collection` 是父容器的点路径（'' = 顶层），`--delete-key` 用 `collection:key`
   *  或 `collection.key` 都收；既有的 `provider:lmuai` / `mcp.servers:acc` 形状不变。 */
  keyDeleteCandidates: Array<{ collection: string; key: string }>
  /** Provider baseURL rewrites applied for this peer (C2b). */
  baseUrlRewrites: Array<{ provider: string; from?: string; to: string }>
  commentsWillBeLost?: boolean
  /** Keys our merged document would set that the peer's overriding layer also
   *  sets with a different value — i.e. keys that will NOT take effect. Named so
   *  the user can act instead of wondering why the sync "did nothing". */
  shadowed: string[]
  notes: string[]
}

/**
 * Collections where "present locally" is the user's whole intent.
 *
 * The panel has no delete for a provider (upstream ships only add/edit/disable),
 * so a sync is the only way to say "remove it". Deletion stays **explicit** —
 * `findPeerOnlyKeys` only *reports* candidates, and `applyKeyDeletes` removes
 * what the caller named — because the alternative (treating the local file as
 * authoritative for the whole map) would delete a provider someone added on the
 * peer, which is exactly the "peer's own keys survive" rule C2 protects.
 */
export const MANAGED_COLLECTIONS = [
  { id: 'provider', path: ['provider'] },
  // opencode v2 的复数形状（custom provider 写这里：providers.<id>.settings.baseURL）。
  // legacy 单数仍在列表里：老配置/老 CLI 还在用它，两边都要纳入"peer-only 报告"。
  { id: 'providers', path: ['providers'] },
  { id: 'mcp.servers', path: ['mcp', 'servers'] },
] as const

/** Keys that exist on the peer but not locally, per managed collection. */
export function findPeerOnlyKeys(
  localEffective: Record<string, unknown>,
  peerEffective: Record<string, unknown>,
): Array<{ collection: string; key: string }> {
  const out: Array<{ collection: string; key: string }> = []
  for (const { id, path } of MANAGED_COLLECTIONS) {
    const at = (doc: Record<string, unknown>) => {
      let node: unknown = doc
      for (const step of path) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
        node = (node as Record<string, unknown>)[step]
      }
      return node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : undefined
    }
    const localMap = at(localEffective)
    const peerMap = at(peerEffective)
    if (!peerMap) continue
    for (const key of Object.keys(peerMap)) {
      if (!localMap || !(key in localMap)) out.push({ collection: id, key })
    }
  }
  // ── 全推送面：把"对端独有键"从两个集合扩到整份文档 ──
  // 起因（2026-10 实况）：v1 时代留在对端的两枚键（compaction.tail_turns、顶层
  // subagent_depth）不在任何集合里，于是它们在每一次 sync 里都"看不见"地活着，
  // 直到有人手工考古。删除仍然**只报告、永远显式**（C2）；这里只是把报告面补齐。
  //
  // 深度 ≤ 2：与 findShadowedKeys 同一条可操作性规则 —— `compaction.tail_turns`
  // 是可以下手的一件事，两三百条叶子路径不是。整棵只在远端存在的容器按"容器本身"
  // 报告（删它 = 删整块），不再往里数。
  //
  // 两个已管理的集合（provider / mcp.servers）在上面按条目报过了，这里跳过它们的
  // 子树，避免同一件事报两遍；集合内部共享条目的值差异属本地赢的合并语义，不在这里。
  const inManagedSubtree = (path: string[]) =>
    MANAGED_COLLECTIONS.some((c) => c.path.length <= path.length && c.path.every((step, i) => path[i] === step))
  /** 这块子树里有没有"不归已管理集合管"的内容（决定"只在远端的容器"要不要报/下走）。 */
  const hasOutsideManaged = (node: Record<string, unknown>, path: string[]): boolean => {
    for (const [key, value] of Object.entries(node)) {
      const here = [...path, key]
      if (inManagedSubtree(here)) continue
      const child = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
      if (!child || hasOutsideManaged(child, here)) return true
    }
    return false
  }
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  const walk = (peerNode: Record<string, unknown>, localNode: unknown, path: string[]): void => {
    for (const [key, value] of Object.entries(peerNode)) {
      const here = [...path, key]
      if (inManagedSubtree(here)) continue
      const localValue = asRecord(localNode)?.[key]
      if (localValue === undefined) {
        // 只在远端的容器，若里面全是已管理集合的内容（例如对端有 mcp、本地没有），
        // 就不报容器本身 —— 集合分支已经按条目报过了，再报一次是纯噪声。
        if (asRecord(value) && here.length < 2 && !hasOutsideManaged(asRecord(value) as Record<string, unknown>, here)) continue
        // collection 用父容器的点路径（顶层为 ''）—— 与既有的 `provider:lmuai`
        // 同一种写法，`--delete-key` 把 `:` 与 `.` 都当路径分隔符。
        out.push({ collection: path.join('.'), key })
        continue
      }
      if (here.length < 2) {
        const peerChild = asRecord(value)
        const localChild = asRecord(localValue)
        if (peerChild && localChild) walk(peerChild, localChild, here)
      }
    }
  }
  walk(peerEffective, localEffective, [])
  return out.sort((a, b) => `${a.collection}:${a.key}`.localeCompare(`${b.collection}:${b.key}`))
}

/** Remove the named keys from a merged document. Unknown/absent keys are ignored
 *  (a stale checkbox must not fail a whole sync).
 *
 *  Spec = 一条路径，`:` 与 `.` 都当分隔符：`provider:lmuai`（集合条目，历史写法）、
 *  `compaction.tail_turns`（全推送面的嵌套键）、`subagent_depth`（顶层键）三种都收。
 *  删除按路径逐级下走，走到头才删叶子 —— 中间任一步不存在就当"没有对应项"报给调用方
 *  （绝不因为一次手滑把整个容器删掉）。
 */
export function applyKeyDeletes(
  merged: Record<string, unknown>,
  deletes: readonly string[],
): { merged: Record<string, unknown>; removed: string[] } {
  const next = structuredClone(merged) as Record<string, unknown>
  const removed: string[] = []
  for (const spec of deletes) {
    const segments = String(spec).split(/[.:]/).filter((s) => s.length > 0)
    if (segments.length === 0) continue
    const parent = segments.slice(0, -1).reduce<Record<string, unknown> | undefined>((node, step) => {
      const child = node?.[step]
      return child && typeof child === 'object' && !Array.isArray(child) ? (child as Record<string, unknown>) : undefined
    }, next)
    const leaf = segments[segments.length - 1]
    if (!parent || !(leaf in parent)) continue
    delete parent[leaf]
    removed.push(spec)
  }
  return { merged: next, removed }
}

/**
 * Which of our keys the peer's higher-priority layer would override.
 *
 * Reported at depth ≤ 2 (`provider.deepseek`) because that is the granularity a
 * person can act on: "your peer's opencode.jsonc still wins for provider.deepseek"
 * is actionable; a list of 200 leaf paths is not.
 */
export function findShadowedKeys(higher: Record<string, unknown>, merged: Record<string, unknown>): string[] {
  const out = new Set<string>()
  const walk = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      const current = path.reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), merged)
      if (JSON.stringify(current) !== JSON.stringify(node)) out.add(path.slice(0, 2).join('.'))
      return
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...path, key])
  }
  for (const [key, value] of Object.entries(higher)) walk(value, [key])
  return [...out].sort()
}

/**
 * Decide exactly what one sync would do. Pure: no fs, no ssh — so the panel can
 * show the same numbers the apply step will act on, and tests can pin the rules.
 */
export function planConfigSync(
  local: LocalConfigState,
  peer: PeerConfigState,
  opts: {
    deletes?: readonly string[]
    /** `provider:acc-provider` / `mcp.servers:acc` — explicit config-key removals. */
    keyDeletes?: readonly string[]
    providerBaseUrl?: Record<string, string>
    /** v2 `plugins` entries required by the components being installed. */
    componentPlugins?: readonly PeerPluginEntry[]
    /** Component names whose local plugin entries must not travel as package
     *  specs: the peer loads them from the directory this sync installs. */
    componentNames?: readonly string[]
    diff?: ConfigDiff
    /** Write the commented override layer anyway (comments are lost). Off by
     *  default: that file is the user's, and its comments are documentation. */
    preferCommentedTarget?: boolean
  } = {},
): SyncPlan {
  const diff = opts.diff ?? diffConfig(local, peer)
  const notes: string[] = []
  const jsoncLayer = peer.layers.find((l) => l.basename === 'opencode.jsonc')
  const commentedTarget = !!jsoncLayer?.commentsWillBeLost
  // Writing a commented `.jsonc` as JSON destroys the user's own annotations —
  // this peer's file documents platform differences across three machines. So we
  // land in the primary `opencode.json` instead and name the keys the commented
  // layer will keep overriding; `preferCommentedTarget` is the explicit opt-in.
  const basename = commentedTarget && !opts.preferCommentedTarget ? 'opencode.json' : peer.targetBasename
  const plan: SyncPlan = {
    basename,
    files: [],
    configChanged: false,
    preservedPluginKey: false,
    managedPlugins: [...(opts.componentPlugins ?? [])],
    droppedManagedKeys: [],
    secretsReplaced: [],
    deletes: [...(opts.deletes ?? [])].filter((rel) => diff.peerOnly.includes(rel)),
    keyDeletes: { requested: [...(opts.keyDeletes ?? [])], removed: [] },
    keyDeleteCandidates: findPeerOnlyKeys(local.effective, peer.effective),
    baseUrlRewrites: [],
    shadowed: [],
    notes,
  }
  for (const err of local.layerErrors) notes.push(`本地 ${err}——该层未参与合并`)
  for (const err of peer.layerErrors) notes.push(`对端 ${err}——该层未参与合并`)

  // The config file is never "just another file": it is merged, and the merged
  // document is written to one layer. Listing the other layer as a file to push
  // would be a lie (we do not send it).
  const otherLayers = CONFIG_CANDIDATES.filter((name) => name !== plan.basename && peer.layers.some((l) => l.basename === name))
  plan.files = [...diff.add, ...diff.change].filter((rel) => !CONFIG_CANDIDATES.includes(rel as typeof CONFIG_CANDIDATES[number]))
  if (otherLayers.length > 0 && !commentedTarget) {
    notes.push(`对端的 ${otherLayers.join('/')} 是低优先级层（被 ${plan.basename} 覆盖），只参与合并、不单独推`)
  }

  let merged: Record<string, unknown> | undefined
  if (Object.keys(local.effective).length > 0) {
    merged = mergeSticky(peer.effective, local.effective)
    // C2b: a peer without egress reaches a provider through the relay/internal
    // gateway, so the baseURL may have to change for THIS host only. Both shapes
    // are rewritten: v2 `providers.<id>.settings.baseURL` and legacy
    // `provider.<id>.options.baseURL`.
    for (const [provider, url] of Object.entries(opts.providerBaseUrl ?? {})) {
      const plural = (merged.providers as Record<string, Record<string, unknown>> | undefined)?.[provider]
      if (plural) {
        if (!plural.settings || typeof plural.settings !== 'object' || Array.isArray(plural.settings)) plural.settings = {}
        const settings = plural.settings as Record<string, unknown>
        const from = typeof settings.baseURL === 'string' ? settings.baseURL : undefined
        if (from !== url) {
          settings.baseURL = url
          plan.baseUrlRewrites.push({ provider, from, to: url })
        }
      }
      const entry = (merged.provider as Record<string, Record<string, unknown>> | undefined)?.[provider]
      if (entry) {
        if (!entry.options) entry.options = {}
        const options = entry.options as Record<string, unknown>
        const from = typeof options.baseURL === 'string' ? options.baseURL : undefined
        if (from !== url) {
          options.baseURL = url
          plan.baseUrlRewrites.push({ provider, from, to: url })
        }
      }
    }
    const stripped = stripLiteralSecrets(merged)
    merged = stripped.config
    plan.secretsReplaced = stripped.replaced
    // C4: removals happen before the write and only for what the caller named —
    // the panel's checkboxes are the decision, not the diff.
    if (plan.keyDeletes.requested.length > 0) {
      const applied = applyKeyDeletes(merged, plan.keyDeletes.requested)
      merged = applied.merged
      plan.keyDeletes.removed = applied.removed
      if (applied.removed.length > 0) notes.push(`按你的选择删除：${applied.removed.join('、')}（旧配置在 .ocrc-bak 里）`)
      const missed = plan.keyDeletes.requested.filter((spec) => !applied.removed.includes(spec))
      if (missed.length > 0) notes.push(`以下删除请求没有对应项（已忽略）：${missed.join('、')}`)
    }
    // v1 `plugin` belongs to the peer's own openchamber: never push our local
    // value; carry the peer's through untouched.
    plan.preservedPluginKey = 'plugin' in peer.effective
    if (plan.preservedPluginKey) merged.plugin = peer.effective.plugin
    else delete merged.plugin
    // v2 `plugins` merges as a UNION across config layers — verified on a real
    // v2.0.32 engine: two documents each contributed an entry and both loaded.
    // So this key is merged (peer + local + component-declared), never dropped.
    // The control side may name a component by package (`@bd7pil/reeve@0.1.2`)
    // while the peer can only load it from the installed directory — copying the
    // package spec to an air-gapped peer adds a plugin that can never resolve.
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    const componentNames = new Set(opts.componentNames ?? [])
    const localPlugins = asStrings(local.effective.plugins).filter((entry) => {
      if (componentNames.size === 0) return true
      for (const name of componentNames) {
        if (entry === `@bd7pil/${name}`) return false
        if (entry.split('@').slice(0, -1).join('@') === `@bd7pil/${name}`) return false
        if (entry.includes(`/.ocrc/components/${name}/`)) return false
      }
      return true
    })
    const plugins = [...new Set([
      ...asStrings(peer.effective.plugins),
      ...localPlugins,
      ...(opts.componentPlugins ?? []),
    ])]
    if (plugins.length > 0) merged.plugins = plugins
    else delete merged.plugins
    plan.managedPlugins = [...(opts.componentPlugins ?? [])]
    if (plan.preservedPluginKey) notes.push('对端的 v1 plugin 键由它自己的 openchamber 管理，原样保留')
    if (plan.managedPlugins.length > 0) notes.push(`组件插件条目：${plan.managedPlugins.map((e) => (typeof e === 'string' ? e : `${e.package}（带 options）`)).join('、')}`)
    plan.merged = merged
    plan.configChanged = hasChanges(peer.effective, merged)
    if (plan.configChanged) plan.files.unshift(plan.basename)
    if (commentedTarget) {
      if (opts.preferCommentedTarget) {
        plan.commentsWillBeLost = true
        notes.push(`对端 ${peer.targetBasename} 里有注释，按你的选择写回（注释会丢）`)
      } else {
        // Keys we deliberately do not write (the managed plugin layer) are not
        // "shadowed" — naming them would send the user after a non-issue.
        plan.shadowed = findShadowedKeys(jsoncLayer?.parsed ?? {}, merged)
          .filter((key) => key.split('.')[0] !== 'plugin' && key.split('.')[0] !== 'plugins')
        notes.push(`对端 ${peer.targetBasename} 有注释，不重写它（注释是你的文档）；本次写 opencode.json`)
        if (plan.shadowed.length > 0) {
          notes.push(`以下键会被对端 ${peer.targetBasename} 的现值覆盖，同步后不生效：${plan.shadowed.join('、')}——更新或删掉那个文件才生效`)
        }
      }
    }
  } else {
    notes.push('本地没有 opencode.json/jsonc —— 只同步目录类条目')
  }
  if (diff.unknown.length > 0) notes.push(`${diff.unknown.length} 个文件对端算不出哈希（缺 sha256sum）：按"不可判定"处理，不当作相同`)
  if (diff.peerOnly.length > 0 && plan.deletes.length === 0) {
    notes.push(`对端独有的 ${diff.peerOnly.length} 个文件不会被动（要删得显式勾选）`)
  }
  if (plan.keyDeleteCandidates.length > 0 && plan.keyDeletes.requested.length === 0) {
    const list = plan.keyDeleteCandidates.map((c) => (c.collection ? `${c.collection}:${c.key}` : c.key))
    notes.push(`对端独有、本地没有的配置项不会被动（要删得显式勾选）：${list.join('、')}`)
  }
  return plan
}

/**
 * Stage the tree we are about to tar: the whitelisted entries, with the config
 * file replaced by the **merged** document. Staging (instead of tarring the
 * local dir directly) is what makes the merge apply to the peer's file rather
 * than a byte copy of ours.
 */
export function isSafeConfigRel(rel: string): boolean {
  if (!rel || rel.length > 512) return false
  if (rel.includes('\0') || rel.includes('\\')) return false
  if (/^[a-zA-Z]:/.test(rel)) return false
  if (rel.startsWith('/')) return false
  const segs = rel.split('/')
  // `.`/`..`/empty segments (`a//b`) would walk or duplicate — neither is a
  // path we ever produced, so neither is a path we ever accept.
  return segs.every((s) => s.length > 0 && s !== '.' && s !== '..')
}

/** Stage exactly the files the plan will push (per file: the ignore table and
 *  the tree's checkboxes can both carve holes a whole-directory copy would
 *  fill back in). Links are dereferenced on purpose: the peer is another
 *  machine — a link's target does not exist there. */
export function stageConfigFiles(opts: {
  sourceDir: string
  destDir: string
  files: readonly string[]
  mergedConfig?: { basename: string; content: string }
}): string[] {
  mkdirSync(opts.destDir, { recursive: true })
  const staged: string[] = []
  for (const rel of opts.files) {
    if (!isSafeConfigRel(rel)) continue
    // The config doc travels as the MERGED document (mergedConfig below), never
    // as a byte copy of ours.
    if ((CONFIG_CANDIDATES as readonly string[]).includes(rel)) continue
    const src = join(opts.sourceDir, rel)
    if (!existsSync(src)) continue
    const dest = join(opts.destDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    staged.push(rel)
  }
  if (opts.mergedConfig) {
    writeFileSync(join(opts.destDir, opts.mergedConfig.basename), opts.mergedConfig.content)
    staged.push(opts.mergedConfig.basename)
  }
  return staged
}

// ── pull（对端 → 控制端）──────────────────────────────────────────────────────

/** Hard cap on one pull, measured on the uncompressed size the peer reports. */
export const MAX_PULL_BYTES = 512 * 1024 * 1024

/**
 * The peer side of a pull: report the uncompressed byte sum, then stream a
 * gzipped tar of exactly the named paths on stdout. `dryRun` stops after the
 * size — a preview that costs one `du`, not a compression round trip.
 * Paths arrive pre-validated (`isSafeConfigRel`); they are single-quoted here
 * anyway, because defensive quoting is the whole job of a script builder.
 */
export function buildPeerPullScript(paths: readonly string[], opts: { dryRun?: boolean } = {}): string {
  const qq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const list = paths.map(qq).join(' ')
  return [
    `D="${PEER_CONFIG_DIR}"`,
    'cd "$D" 2>/dev/null || { echo "PULL_ERR cannot-enter-config-dir"; exit 3; }',
    'missing=0',
    `for p in ${list}; do [ -e "$p" ] || { echo "PULL_MISSING $p"; missing=1; }; done`,
    '[ "$missing" = 0 ] || exit 4',
    `echo "PULL_SIZE $(du -sb ${list} 2>/dev/null | awk '{s+=$1} END {print s+0}')"`,
    ...(opts.dryRun ? ['exit 0'] : [`tar czf - ${list}`]),
  ].join('\n')
}

/** Success path: `PULL_SIZE <n>\n` followed by the raw gzip stream. */
export function parsePullSize(buf: Buffer): { bytes: number; gzip: Buffer } {
  const nl = buf.indexOf(0x0a)
  if (nl < 0) throw new Error('拉取输出里没有 PULL_SIZE 行')
  const line = buf.subarray(0, nl).toString('utf-8').trim()
  const m = /^PULL_SIZE (\d+)$/.exec(line)
  if (!m) throw new Error(`拉取输出头不是 PULL_SIZE：${line.slice(0, 80)}`)
  return { bytes: Number(m[1]), gzip: buf.subarray(nl + 1) }
}

/** Failure path: collect PULL_MISSING / PULL_ERR lines from a text stdout. */
export function parsePullFailures(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const missing = lines.filter((l) => l.startsWith('PULL_MISSING ')).map((l) => l.slice('PULL_MISSING '.length))
  const errs = lines.filter((l) => l.startsWith('PULL_ERR ')).map((l) => l.slice('PULL_ERR '.length))
  const parts: string[] = []
  if (missing.length > 0) parts.push(`对端已不存在：${missing.join('、')}`)
  if (errs.length > 0) parts.push(errs.join('；'))
  return parts.join('；') || text.split('\n').filter(Boolean).slice(-1)[0] || '拉取失败'
}

export interface ExtractedFile { rel: string; content: Buffer }
export interface TarExtractResult {
  files: ExtractedFile[]
  dirs: string[]
  /** Non-regular entries (links, devices) and entries outside the requested
   *  roots — reported, never written. */
  skipped: Array<{ name: string; type: string }>
}

/**
 * Hand-rolled GNU-tar reader (zero runtime deps, zlib is built in): 512-byte
 * headers, ustar prefix, GNU longname (`L`) for >100-char names — skills trees
 * produce those. Every entry passes `isSafeConfigRel` AND must live under one
 * of the requested roots: the peer builds the archive from our args, but the
 * archive is still remote input, so extraction is defended on this side.
 * Header checksums are verified — a truncated or corrupted stream must fail,
 * not half-apply.
 */
export function extractConfigTar(buf: Buffer, allowedRoots: readonly string[]): TarExtractResult {
  const files: ExtractedFile[] = []
  const dirs: string[] = []
  const skipped: Array<{ name: string; type: string }> = []
  const underRoots = (rel: string) =>
    allowedRoots.length === 0 || allowedRoots.some((r) => rel === r || rel.startsWith(r.endsWith('/') ? r : `${r}/`))
  let off = 0
  let longName: string | null = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (isZeroBlock(header)) break
    if (!tarChecksumOk(header)) throw new Error(`tar 头校验失败（偏移 ${off}）：流被截断或损坏`)
    const rawName = fieldString(header, 0, 100)
    const size = fieldOctal(header, 124, 12)
    if (size < 0) throw new Error('tar 尺寸字段非法：流被截断或损坏')
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = fieldString(header, 345, 155)
    const magic = fieldString(header, 257, 6)
    let name = magic.startsWith('ustar') && prefix ? `${prefix}/${rawName}` : rawName
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (dataEnd > buf.length) throw new Error('tar 数据段截断：流不完整')
    const data = buf.subarray(dataStart, dataEnd)
    off = dataStart + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = data.toString('utf-8').replace(/\0+$/, ''); continue }
    if (type === 'K' || type === 'x' || type === 'g') continue
    if (longName !== null) { name = longName; longName = null }
    const rel = name.replace(/^\.\//, '').replace(/\/+$/, '')
    if (rel === '') continue
    if (type === '5') {
      if (isSafeConfigRel(rel) && underRoots(rel)) dirs.push(rel)
      else skipped.push({ name, type: 'dir-out-of-scope' })
      continue
    }
    if (type === '0' || type === '\0') {
      if (!isSafeConfigRel(rel)) { skipped.push({ name, type: 'unsafe-name' }); continue }
      if (!underRoots(rel)) { skipped.push({ name, type: 'out-of-scope' }); continue }
      files.push({ rel, content: Buffer.from(data) })
      continue
    }
    skipped.push({ name, type })
  }
  return { files, dirs, skipped }
}

/** Gunzip with the pull cap applied inside zlib (bomb guard, zero deps). */
export function gunzipCapped(gzip: Buffer): Buffer {
  return gunzipSync(gzip, { maxOutputLength: MAX_PULL_BYTES })
}

function isZeroBlock(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false
  return true
}

function tarChecksumOk(h: Buffer): boolean {
  const stored = fieldOctal(h, 148, 8)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
  return sum === stored
}

function fieldString(b: Buffer, start: number, len: number): string {
  const slice = b.subarray(start, start + len)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString('utf-8')
}

function fieldOctal(b: Buffer, start: number, len: number): number {
  const s = fieldString(b, start, len).trim()
  if (!s) return 0
  const v = parseInt(s, 8)
  return Number.isNaN(v) ? -1 : v
}

/**
 * The peer side of one sync, fed a gzipped tar on stdin: untar into a staging
 * dir, move each file into place (`.ocrc-bak` on collision), then apply the
 * explicit deletions — also with a `.ocrc-bak`, because "delete" on someone
 * else's machine should still be reversible.
 */
export function buildConfigApplyScript(deletes: readonly string[] = []): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const lines = [
    'set -e',
    `D="${PEER_CONFIG_DIR}"`,
    'S="$D/.ocrc-sync.$$"',
    'mkdir -p "$S"',
    'tar -xzf - -C "$S"',
    'cd "$S"',
    'find . -type f | sed \'s#^\\./##\' | while IFS= read -r rel; do',
    '  tgt="$D/$rel"',
    '  mkdir -p "$(dirname "$tgt")"',
    '  if [ -f "$tgt" ]; then',
    '    cp -p "$tgt" "$tgt.ocrc-bak"',
    '    echo "backup: $rel"',
    '  else',
    '    echo "new: $rel"',
    '  fi',
    '  mv "$S/$rel" "$tgt"',
    'done',
    'rm -rf "$S"',
  ]
  if (deletes.length > 0) {
    // Names come from the peer's own listing, so they are quoted as shell words
    // (a space or a quote in a filename must not turn into a command).
    lines.push(
      `for rel in ${deletes.map(q).join(' ')}; do`,
      '  tgt="$D/$rel"',
      '  if [ -f "$tgt" ]; then cp -p "$tgt" "$tgt.ocrc-bak"; rm -f "$tgt"; echo "deleted: $rel"; fi',
      'done',
    )
  }
  lines.push('echo "sync-config: applied"')
  return lines.join('\n')
}

/** Credentials travel over ssh stdin and land 0600 — never in a config file,
 *  never echoed back. The peer's copy is replaced wholesale on purpose: it is
 *  one small document whose whole content is the credential set. */
export function buildAuthPushScript(): string {
  return [
    'set -e',
    `A="${PEER_AUTH_PATH}"`,
    'mkdir -p "$(dirname "$A")"',
    'T="$A.ocrc-tmp.$$"',
    'cat > "$T"',
    'chmod 600 "$T"',
    'if [ -f "$A" ]; then cp -p "$A" "$A.ocrc-bak"; fi',
    'mv "$T" "$A"',
    'echo "sync-auth: written 0600"',
  ].join('\n')
}

// ── auth 漂移探测（2026-10-24：DS key 轮换后对端还在用旧 key，问题不可见）──
// 设计与 egress 探测同款：**只比哈希，凭据内容永不回传/进面板**；探测是显式
// 动作（plan / sync-auth 自证 / CLI status），status 读只看缓存。

export type AuthSyncState = 'match' | 'drift' | 'unknown'

export interface AuthFingerprint { sha?: string; mtime?: number }

// ── 引擎凭据（opencode v2 的真实存储；2026-10-24 深夜取证后的 v2 同步）──
// v2 把 provider key 存在 `~/.local/share/opencode/opencode.db` 的 credential 表
// （value={type:"key",key}），auth.json 只在 DB 首次初始化时被一次性迁移导入、
// 之后引擎不再读——所以只写 auth.json 对已迁移的库是死信（EL7 实证：DB 里
// deepseek=旧key(尾5499)，auth.json=新key，引擎用 DB 的旧 key 被 DS 拒）。
// 官方写入面 = 引擎 `POST /api/credential`（openchamber renewStoredLogin 同款：
// 先建新行 activate，再删同 integration 旧行）。读走 GET /api/credential，
// **明文不出对端**：在对端 node 里就地指纹化，只回传 fp/len/尾4。

export interface EngineCredView { id: string; fp?: string; len?: number; tail4?: string }

export type EnginePresence = 'running' | 'not-running' | 'no-password' | 'runtime-missing' | 'probe-fail'

export interface AuthSyncProbeView {
  authFile: AuthFingerprint | 'missing' | undefined
  engine: EnginePresence
  creds: EngineCredView[]
  credsParseFail?: boolean
}

/** 对端 node 指纹化器（base64 内嵌）：stdin 吃 /api/credential 的 JSON（含明文
 *  key），只吐 `CRED <id> <fp> <len> <尾4>` 行。秘密不出对端进程。 */
const PEER_CRED_FINGERPRINTER = `
let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  const crypto = require('node:crypto')
  try {
    const j = JSON.parse(raw)
    const rows = Array.isArray(j) ? j : (j.data ?? [])
    for (const c of rows) {
      const key = c.value && typeof c.value === 'object' ? (c.value.key ?? c.value.access) : undefined
      const id = c.integrationID ?? c.integration_id ?? '?'
      if (typeof key === 'string' && key) {
        console.log('CRED ' + id + ' ' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) + ' ' + key.length + ' ' + key.slice(-4))
      } else {
        console.log('CRED ' + id + ' no-key(' + (c.value && c.value.type ? c.value.type : '?') + ')')
      }
    }
  } catch { console.log('CREDS parse-fail') }
})
`

/** 一次 ssh 同时取：auth.json 指纹 + 引擎 credential 指纹（引擎没跑也如实说，
 *  不把「没跑」伪装成 drift）。定位引擎沿用验收脚本的 /proc 手法；密码只进
 *  对端 shell/env，绝不回传。 */
export function buildAuthSyncProbeScript(nodeVersion: string): string {
  const b64 = Buffer.from(PEER_CRED_FINGERPRINTER, 'utf8').toString('base64')
  return [
    `A="${PEER_AUTH_PATH}"`,
    `if [ -f "$A" ]; then printf 'AUTHFILE '; sha256sum "$A" | cut -d' ' -f1; stat -c %Y "$A"; else echo 'AUTHFILE=MISSING'; fi`,
    `N="$HOME/.ocrc/remote/runtime/node-v${nodeVersion}/bin/node"`,
    `PID=$(ps -eo pid,args | grep 'engine/opencode serve' | grep -v grep | awk '{print $1}' | head -1)`,
    `if [ -z "$PID" ]; then echo 'ENGINE=not-running'; exit 0; fi`,
    `[ -x "$N" ] || { echo 'ENGINE=runtime-missing'; exit 0; }`,
    `PORT=$(tr '\\0' ' ' < /proc/$PID/cmdline | sed -n 's/.*--port \\([0-9]*\\).*/\\1/p')`,
    `PW=$(tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' | head -1)`,
    `if [ -z "$PORT" ] || [ -z "$PW" ]; then echo 'ENGINE=no-password'; exit 0; fi`,
    `echo 'ENGINE=running'`,
    `curl -s -m 20 -u "opencode:$PW" "http://127.0.0.1:$PORT/api/credential" | "$N" -e "$(echo '${b64}' | base64 -d)" || echo 'CREDS parse-fail'`,
  ].join('\n')
}

export function parseAuthSyncProbe(out: string): AuthSyncProbeView {
  const view: AuthSyncProbeView = { authFile: undefined, engine: 'probe-fail', creds: [] }
  for (const lineRaw of out.split('\n')) {
    const line = lineRaw.trim()
    if (!line) continue
    if (line === 'AUTHFILE=MISSING') { view.authFile = 'missing'; continue }
    const af = /^AUTHFILE ([0-9a-f]{64})$/.exec(line)
    if (af) { view.authFile = { sha: af[1]! }; continue }
    if (/^\d{10}$/.test(line) && view.authFile && view.authFile !== 'missing') {
      ;(view.authFile as { mtime?: number }).mtime = Number(line)
      continue
    }
    if (line.startsWith('ENGINE=')) {
      const v = line.slice('ENGINE='.length)
      view.engine = (['running', 'not-running', 'no-password', 'runtime-missing', 'probe-fail'] as const).includes(v as never)
        ? (v as EnginePresence)
        : 'probe-fail'
      continue
    }
    if (line === 'CREDS parse-fail') { view.credsParseFail = true; continue }
    const m = /^CRED (\S+)(?: ([0-9a-f]{12}) (\d+) (\S{1,8}))?/.exec(line)
    if (m) {
      if (m[2]) view.creds.push({ id: m[1]!, fp: m[2], len: Number(m[3]), tail4: m[4] })
      else view.creds.push({ id: m[1]! })
    }
  }
  return view
}

/** v2 漂移判定（引擎真实凭据为准——引擎用哪把算哪把）：
 *  · 引擎没跑/取不到 → unknown（不是对端的错，也不是 match）；
 *  · 控制端任一 provider 在引擎里缺行或指纹不等 → drift（点名）；
 *  · 引擎里多出来的（对端自建）不动也不算 drift，match 时 reason 报备数量。 */
export function decideAuthSyncV2(o: {
  local: Array<{ id: string; fp: string }>
  probe: AuthSyncProbeView
}): { sync: AuthSyncState; reason?: string } {
  if (o.probe.engine !== 'running') {
    const why: Record<Exclude<EnginePresence, 'running'>, string> = {
      'not-running': '引擎未运行（启动后跑一次检查或同步即可核对）',
      'no-password': '引擎在跑但取不到它的 API 密码（外部实例？）',
      'runtime-missing': '对端缺我们的 runtime node（先装机）',
      'probe-fail': '引擎凭据探测失败（ssh/输出异常）',
    }
    return { sync: 'unknown', reason: why[o.probe.engine] }
  }
  if (o.probe.credsParseFail) return { sync: 'unknown', reason: '引擎 /api/credential 输出解析失败' }
  const byId = new Map(o.probe.creds.map((c) => [c.id, c]))
  const problems: string[] = []
  for (const want of o.local) {
    const got = byId.get(want.id)
    if (!got) problems.push(`${want.id}（引擎里没有）`)
    else if (!got.fp) problems.push(`${want.id}（引擎存的不是 api key）`)
    else if (got.fp !== want.fp) problems.push(`${want.id}（旧 key，尾号 ${got.tail4 ?? '?'}）`)
  }
  if (problems.length) return { sync: 'drift', reason: `引擎凭据与控制端不一致：${problems.join('、')}` }
  const extra = o.probe.creds.filter((c) => !o.local.some((l) => l.id === c.id)).length
  return { sync: 'match', reason: extra ? `引擎另有 ${extra} 个对端自建凭据（不动）` : undefined }
}

/** 对端 node 推送器（base64 内嵌；凭据 JSON 走 stdin）：renewStoredLogin 同款
 *  顺序——先 POST 新行（activate），再删同 integration 的旧行；唯一 active
 *  索引冲突时退「先删后建」。只输出 OK/ERR/WARN 状态行，key 明文不出现在
 *  任何输出里。 */
const PEER_CRED_PUSHER = `
let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', async () => {
  let providers
  try { providers = JSON.parse(raw).providers } catch { console.log('PUSH parse-fail'); return }
  const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OC_PW).toString('base64')
  const base = 'http://127.0.0.1:' + process.env.OC_PORT
  const listRes = await fetch(base + '/api/credential', { headers: { authorization: auth } })
  if (!listRes.ok) { console.log('PUSH list-HTTP-' + listRes.status); return }
  const list = await listRes.json()
  const old = new Map()
  for (const c of (Array.isArray(list) ? list : (list.data ?? []))) {
    const k = c.integrationID ?? c.integration_id
    if (!k) continue
    if (!old.has(k)) old.set(k, [])
    old.get(k).push(c.id)
  }
  for (const p of providers) {
    try {
      const body = JSON.stringify({ integrationID: p.id, label: 'ocrc sync', value: { type: 'key', key: p.key }, activate: true })
      let made = await fetch(base + '/api/credential', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body })
      if (made.status === 409) {
        for (const oid of (old.get(p.id) ?? [])) await fetch(base + '/api/credential/' + oid, { method: 'DELETE', headers: { authorization: auth } }).catch(() => {})
        made = await fetch(base + '/api/credential', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body })
      }
      if (!made.ok) { console.log('ERR ' + p.id + ' HTTP ' + made.status); continue }
      const created = await made.json().catch(() => ({}))
      const newId = (created && created.data && created.data.id) || (created && created.id)
      for (const oid of (old.get(p.id) ?? [])) {
        if (oid === newId) continue
        const del = await fetch(base + '/api/credential/' + oid, { method: 'DELETE', headers: { authorization: auth } }).catch(() => null)
        if (!del || !del.ok) console.log('WARN ' + p.id + ' 旧行清理失败')
      }
      console.log('OK ' + p.id)
    } catch (e) { console.log('ERR ' + p.id + ' ' + String((e && e.message) || e).slice(0, 80)) }
  }
})
`

/** 推送脚本：stdin 承载 `{providers:[{id,key}]}`（key 不进命令行/ps）。 */
export function buildEngineCredentialPushScript(nodeVersion: string): string {
  const b64 = Buffer.from(PEER_CRED_PUSHER, 'utf8').toString('base64')
  return [
    `N="$HOME/.ocrc/remote/runtime/node-v${nodeVersion}/bin/node"`,
    `PID=$(ps -eo pid,args | grep 'engine/opencode serve' | grep -v grep | awk '{print $1}' | head -1)`,
    `if [ -z "$PID" ]; then echo 'ENGINE=not-running'; exit 0; fi`,
    `[ -x "$N" ] || { echo 'ENGINE=runtime-missing'; exit 0; }`,
    `PORT=$(tr '\\0' ' ' < /proc/$PID/cmdline | sed -n 's/.*--port \\([0-9]*\\).*/\\1/p')`,
    `PW=$(tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' | head -1)`,
    `if [ -z "$PORT" ] || [ -z "$PW" ]; then echo 'ENGINE=no-password'; exit 0; fi`,
    `echo 'ENGINE=running'`,
    `OC_PW="$PW" OC_PORT="$PORT" "$N" -e "$(echo '${b64}' | base64 -d)"`,
  ].join('\n')
}

export interface EngineCredPushResult {
  engine: EnginePresence
  updated: string[]
  failed: Array<{ id: string; reason: string }>
}

export function parseEngineCredentialPush(out: string): EngineCredPushResult {
  const r: EngineCredPushResult = { engine: 'running', updated: [], failed: [] }
  for (const lineRaw of out.split('\n')) {
    const line = lineRaw.trim()
    if (line.startsWith('ENGINE=')) {
      const v = line.slice('ENGINE='.length)
      r.engine = (['running', 'not-running', 'no-password', 'runtime-missing', 'probe-fail'] as const).includes(v as never)
        ? (v as EnginePresence)
        : 'probe-fail'
      continue
    }
    if (line === 'PUSH parse-fail') { r.failed.push({ id: '(payload)', reason: '推送载荷解析失败' }); continue }
    if (line.startsWith('PUSH list-HTTP-')) { r.failed.push({ id: '(list)', reason: `引擎凭据列表 HTTP ${line.slice('PUSH list-HTTP-'.length)}` }); continue }
    if (line.startsWith('OK ')) r.updated.push(line.slice(3).trim())
    else if (line.startsWith('ERR ')) {
      const rest = line.slice(4).trim()
      const sp = rest.indexOf(' ')
      r.failed.push(sp === -1 ? { id: rest, reason: '未知' } : { id: rest.slice(0, sp), reason: rest.slice(sp + 1) })
    }
  }
  return r
}

/** 控制端 auth.json → 引擎推送条目（type=api 才推；oauth 机器相关，跳过并点名）。 */
export function enginePushEntries(authJson: string): { providers: Array<{ id: string; key: string }>; skippedOauth: string[] } {
  const j = JSON.parse(authJson) as Record<string, { type?: string; key?: string; api_key?: string; apiKey?: string }>
  const providers: Array<{ id: string; key: string }> = []
  const skippedOauth: string[] = []
  for (const [id, v] of Object.entries(j)) {
    if (!v || typeof v !== 'object') continue
    const key = v.key ?? v.api_key ?? v.apiKey
    if (typeof key === 'string' && key && (v.type ?? 'api') === 'api') providers.push({ id, key })
    else skippedOauth.push(id)
  }
  return { providers, skippedOauth }
}

/** Remove a staging tree (the manager's cleanup, kept here so the temp layout
 *  lives in one module). */
export function discardStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Relative paths inside a staged tree, for logging/diagnostics. */
export function listStaged(dir: string): string[] {
  const out: string[] = []
  const walk = (base: string) => {
    for (const name of readdirSync(base)) {
      const abs = join(base, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (st.isFile()) out.push(toPosix(relative(dir, abs)))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}
