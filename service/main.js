var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../src/utils/jsonc.ts
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === strCh) inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function parseConfig(raw) {
  try {
    const parsed = JSON.parse(stripJsonc(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "\u9876\u5C42\u4E0D\u662F\u5BF9\u8C61" };
    }
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
var init_jsonc = __esm({
  "../../src/utils/jsonc.ts"() {
    "use strict";
  }
});

// ../../src/core/config-merge.ts
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function mergeSticky(remote, incoming) {
  const out = { ...remote };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === void 0) continue;
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeSticky(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function hasChanges(before, after) {
  return JSON.stringify(sortKeys(before)) !== JSON.stringify(sortKeys(after));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}
function stripLiteralSecrets(config) {
  const next = structuredClone(config);
  const replaced = [];
  const servers = next.mcp?.servers;
  if (!servers) return { config: next, replaced };
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const declaration = raw;
    for (const [key, value] of Object.entries(declaration.environment ?? {})) {
      if (typeof value !== "string" || /^\{.*\}$/.test(value)) continue;
      if (!/(key|token|secret|password|passwd|credential|apikey)/i.test(key)) continue;
      declaration.environment[key] = `{env:${key}}`;
      replaced.push({ path: `mcp.servers.${name}.environment.${key}`, env: key });
    }
  }
  return { config: next, replaced };
}
function renderConfig(doc) {
  return `${JSON.stringify(doc, null, 2)}
`;
}
var init_config_merge = __esm({
  "../../src/core/config-merge.ts"() {
    "use strict";
    init_jsonc();
  }
});

// ../../src/core/instance-config.ts
var instance_config_exports = {};
__export(instance_config_exports, {
  INSTANCE_SYNC_ENTRIES: () => INSTANCE_SYNC_ENTRIES,
  MANAGED_COLLECTIONS: () => MANAGED_COLLECTIONS,
  PEER_AUTH_PATH: () => PEER_AUTH_PATH,
  PEER_CONFIG_DIR: () => PEER_CONFIG_DIR,
  applyKeyDeletes: () => applyKeyDeletes,
  buildAuthPushScript: () => buildAuthPushScript,
  buildConfigApplyScript: () => buildConfigApplyScript,
  buildPeerConfigReadScript: () => buildPeerConfigReadScript,
  diffConfig: () => diffConfig,
  discardStaging: () => discardStaging,
  findPeerOnlyKeys: () => findPeerOnlyKeys,
  findShadowedKeys: () => findShadowedKeys,
  listStaged: () => listStaged,
  mergeConfigLayers: () => mergeConfigLayers,
  parsePeerConfigRead: () => parsePeerConfigRead,
  planConfigSync: () => planConfigSync,
  readLocalConfig: () => readLocalConfig,
  stageConfigTree: () => stageConfigTree
});
import { cpSync, existsSync as existsSync4, mkdirSync as mkdirSync6, readFileSync as readFileSync4, readdirSync, rmSync as rmSync3, statSync as statSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { createHash as createHash3 } from "node:crypto";
import { join as join7, relative, sep } from "node:path";
function mergeConfigLayers(layers) {
  let effective = {};
  const errors = [];
  for (const layer of layers) {
    if (layer.parseError) {
      errors.push(`${layer.basename} \u89E3\u6790\u5931\u8D25\uFF1A${layer.parseError}`);
      continue;
    }
    if (layer.parsed) effective = mergeSticky(effective, layer.parsed);
  }
  return { effective, errors };
}
function shortHash(data) {
  return createHash3("sha256").update(data).digest("hex").slice(0, 16);
}
function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}
function walkEntry(dir, entry, out) {
  const abs = join7(dir, entry);
  if (!existsSync4(abs)) return;
  const st = statSync3(abs);
  if (st.isFile()) {
    out.push({ rel: toPosix(entry), hash: shortHash(readFileSync4(abs)) });
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(abs)) {
    const child = `${entry}/${name}`;
    const childAbs = join7(dir, entry, name);
    const childStat = statSync3(childAbs);
    if (childStat.isDirectory()) walkEntry(dir, child, out);
    else if (childStat.isFile()) out.push({ rel: toPosix(child), hash: shortHash(readFileSync4(childAbs)) });
  }
}
function parseLayer(basename2, raw) {
  const format2 = basename2.endsWith(".jsonc") ? "jsonc" : "json";
  const file = { basename: basename2, raw };
  if (format2 === "jsonc" && /(^|\n)\s*(\/\/|\/\*)/.test(raw)) file.commentsWillBeLost = true;
  const parsed = parseConfig(format2 === "jsonc" ? stripJsonc(raw) : raw);
  if (parsed.ok) file.parsed = parsed.parsed;
  else file.parseError = parsed.error;
  return file;
}
function readLocalConfig(opts = {}) {
  const dir = opts.dir ?? join7(process.env.HOME ?? process.env.USERPROFILE ?? "", ".config", "opencode");
  const authPath = opts.authPath ?? join7(process.env.HOME ?? process.env.USERPROFILE ?? "", ".local", "share", "opencode", "auth.json");
  const layers = [];
  for (const name of CONFIG_CANDIDATES) {
    const abs = join7(dir, name);
    if (!existsSync4(abs)) continue;
    layers.push(parseLayer(name, readFileSync4(abs, "utf-8")));
  }
  const { effective, errors } = mergeConfigLayers(layers);
  const files = [];
  for (const entry of INSTANCE_SYNC_ENTRIES) walkEntry(dir, entry, files);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { dir, authPath, authPresent: existsSync4(authPath), layers, effective, layerErrors: errors, files };
}
function buildPeerConfigReadScript() {
  const list = INSTANCE_SYNC_ENTRIES.join(" ");
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
    `cd "$D" 2>/dev/null && for e in ${list}; do [ -e "$e" ] || continue; find "$e" -type f 2>/dev/null; done | sort -u | while IFS= read -r rel; do`,
    '  h=$(sha256sum "$rel" 2>/dev/null | cut -c1-16)',
    '  echo "${h:-?} $rel"',
    "done",
    'echo "LIST_END"'
  ].join("\n");
}
function decodeBlock(stdout, name) {
  const re = new RegExp(`${name}_BEGIN\\r?\\n([\\s\\S]*?)\\r?\\n${name}_END`);
  const block = re.exec(stdout);
  if (!block) return void 0;
  const body = block[1].replace(/[\r\n]/g, "");
  if (!body.trim()) return void 0;
  return Buffer.from(body, "base64").toString("utf-8");
}
function parsePeerConfigRead(stdout) {
  const layers = [];
  const json2 = decodeBlock(stdout, "B64_JSON");
  const jsonc = decodeBlock(stdout, "B64_JSONC");
  if (json2 !== void 0) layers.push(parseLayer("opencode.json", json2));
  if (jsonc !== void 0) layers.push(parseLayer("opencode.jsonc", jsonc));
  const { effective, errors } = mergeConfigLayers(layers);
  const files = [];
  const list = /LIST_BEGIN\r?\n([\s\S]*?)\r?\nLIST_END/.exec(stdout)?.[1] ?? "";
  for (const line of list.split("\n")) {
    const m = /^(\S+) (.+)$/.exec(line.trim());
    if (m) files.push({ hash: m[1], rel: m[2] });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    layers,
    effective,
    layerErrors: errors,
    // The `.jsonc` wins when it exists (source-verified load order), so that is
    // where a merged document has to land to actually take effect.
    targetBasename: jsonc !== void 0 ? "opencode.jsonc" : "opencode.json",
    authPresent: /^AUTH=present$/m.test(stdout),
    files
  };
}
function diffConfig(local, peer) {
  const diff = { add: [], change: [], same: [], peerOnly: [], unknown: [], auth: { local: local.authPresent, peer: peer.authPresent } };
  const peerMap = new Map(peer.files.map((f) => [f.rel, f.hash]));
  const localMap = new Map(local.files.map((f) => [f.rel, f.hash]));
  for (const [rel, hash] of localMap) {
    const remote = peerMap.get(rel);
    if (remote === void 0) diff.add.push(rel);
    else if (remote === "?" || hash === "?") diff.unknown.push(rel);
    else if (remote !== hash) diff.change.push(rel);
    else diff.same.push(rel);
  }
  for (const rel of peerMap.keys()) if (!localMap.has(rel)) diff.peerOnly.push(rel);
  diff.add.sort();
  diff.change.sort();
  diff.same.sort();
  diff.peerOnly.sort();
  diff.unknown.sort();
  return diff;
}
function findPeerOnlyKeys(localEffective, peerEffective) {
  const out = [];
  for (const { id, path } of MANAGED_COLLECTIONS) {
    const at = (doc) => {
      let node = doc;
      for (const step of path) {
        if (!node || typeof node !== "object" || Array.isArray(node)) return void 0;
        node = node[step];
      }
      return node && typeof node === "object" && !Array.isArray(node) ? node : void 0;
    };
    const localMap = at(localEffective);
    const peerMap = at(peerEffective);
    if (!peerMap) continue;
    for (const key of Object.keys(peerMap)) {
      if (!localMap || !(key in localMap)) out.push({ collection: id, key });
    }
  }
  const inManagedSubtree = (path) => MANAGED_COLLECTIONS.some((c) => c.path.length <= path.length && c.path.every((step, i) => path[i] === step));
  const hasOutsideManaged = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      const here = [...path, key];
      if (inManagedSubtree(here)) continue;
      const child = value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
      if (!child || hasOutsideManaged(child, here)) return true;
    }
    return false;
  };
  const asRecord = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
  const walk = (peerNode, localNode, path) => {
    for (const [key, value] of Object.entries(peerNode)) {
      const here = [...path, key];
      if (inManagedSubtree(here)) continue;
      const localValue = asRecord(localNode)?.[key];
      if (localValue === void 0) {
        if (asRecord(value) && here.length < 2 && !hasOutsideManaged(asRecord(value), here)) continue;
        out.push({ collection: path.join("."), key });
        continue;
      }
      if (here.length < 2) {
        const peerChild = asRecord(value);
        const localChild = asRecord(localValue);
        if (peerChild && localChild) walk(peerChild, localChild, here);
      }
    }
  };
  walk(peerEffective, localEffective, []);
  return out.sort((a, b) => `${a.collection}:${a.key}`.localeCompare(`${b.collection}:${b.key}`));
}
function applyKeyDeletes(merged, deletes) {
  const next = structuredClone(merged);
  const removed = [];
  for (const spec of deletes) {
    const segments = String(spec).split(/[.:]/).filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const parent = segments.slice(0, -1).reduce((node, step) => {
      const child = node?.[step];
      return child && typeof child === "object" && !Array.isArray(child) ? child : void 0;
    }, next);
    const leaf = segments[segments.length - 1];
    if (!parent || !(leaf in parent)) continue;
    delete parent[leaf];
    removed.push(spec);
  }
  return { merged: next, removed };
}
function findShadowedKeys(higher, merged) {
  const out = /* @__PURE__ */ new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      const current = path.reduce((acc, key) => acc && typeof acc === "object" ? acc[key] : void 0, merged);
      if (JSON.stringify(current) !== JSON.stringify(node)) out.add(path.slice(0, 2).join("."));
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };
  for (const [key, value] of Object.entries(higher)) walk(value, [key]);
  return [...out].sort();
}
function planConfigSync(local, peer, opts = {}) {
  const diff = opts.diff ?? diffConfig(local, peer);
  const notes = [];
  const jsoncLayer = peer.layers.find((l) => l.basename === "opencode.jsonc");
  const commentedTarget = !!jsoncLayer?.commentsWillBeLost;
  const basename2 = commentedTarget && !opts.preferCommentedTarget ? "opencode.json" : peer.targetBasename;
  const plan = {
    basename: basename2,
    files: [],
    configChanged: false,
    preservedPluginKey: false,
    managedPlugins: [...opts.componentPlugins ?? []],
    droppedManagedKeys: [],
    secretsReplaced: [],
    deletes: [...opts.deletes ?? []].filter((rel) => diff.peerOnly.includes(rel)),
    keyDeletes: { requested: [...opts.keyDeletes ?? []], removed: [] },
    keyDeleteCandidates: findPeerOnlyKeys(local.effective, peer.effective),
    baseUrlRewrites: [],
    shadowed: [],
    notes
  };
  for (const err of local.layerErrors) notes.push(`\u672C\u5730 ${err}\u2014\u2014\u8BE5\u5C42\u672A\u53C2\u4E0E\u5408\u5E76`);
  for (const err of peer.layerErrors) notes.push(`\u5BF9\u7AEF ${err}\u2014\u2014\u8BE5\u5C42\u672A\u53C2\u4E0E\u5408\u5E76`);
  const otherLayers = CONFIG_CANDIDATES.filter((name) => name !== plan.basename && peer.layers.some((l) => l.basename === name));
  plan.files = [...diff.add, ...diff.change].filter((rel) => !CONFIG_CANDIDATES.includes(rel));
  if (otherLayers.length > 0 && !commentedTarget) {
    notes.push(`\u5BF9\u7AEF\u7684 ${otherLayers.join("/")} \u662F\u4F4E\u4F18\u5148\u7EA7\u5C42\uFF08\u88AB ${plan.basename} \u8986\u76D6\uFF09\uFF0C\u53EA\u53C2\u4E0E\u5408\u5E76\u3001\u4E0D\u5355\u72EC\u63A8`);
  }
  let merged;
  if (Object.keys(local.effective).length > 0) {
    merged = mergeSticky(peer.effective, local.effective);
    for (const [provider, url] of Object.entries(opts.providerBaseUrl ?? {})) {
      const entry = merged.provider?.[provider];
      if (!entry) continue;
      if (!entry.options) entry.options = {};
      const options = entry.options;
      const from = typeof options.baseURL === "string" ? options.baseURL : void 0;
      if (from === url) continue;
      options.baseURL = url;
      plan.baseUrlRewrites.push({ provider, from, to: url });
    }
    const stripped = stripLiteralSecrets(merged);
    merged = stripped.config;
    plan.secretsReplaced = stripped.replaced;
    if (plan.keyDeletes.requested.length > 0) {
      const applied = applyKeyDeletes(merged, plan.keyDeletes.requested);
      merged = applied.merged;
      plan.keyDeletes.removed = applied.removed;
      if (applied.removed.length > 0) notes.push(`\u6309\u4F60\u7684\u9009\u62E9\u5220\u9664\uFF1A${applied.removed.join("\u3001")}\uFF08\u65E7\u914D\u7F6E\u5728 .ocrc-bak \u91CC\uFF09`);
      const missed = plan.keyDeletes.requested.filter((spec) => !applied.removed.includes(spec));
      if (missed.length > 0) notes.push(`\u4EE5\u4E0B\u5220\u9664\u8BF7\u6C42\u6CA1\u6709\u5BF9\u5E94\u9879\uFF08\u5DF2\u5FFD\u7565\uFF09\uFF1A${missed.join("\u3001")}`);
    }
    plan.preservedPluginKey = "plugin" in peer.effective;
    if (plan.preservedPluginKey) merged.plugin = peer.effective.plugin;
    else delete merged.plugin;
    const asStrings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    const componentNames = new Set(opts.componentNames ?? []);
    const localPlugins = asStrings(local.effective.plugins).filter((entry) => {
      if (componentNames.size === 0) return true;
      for (const name of componentNames) {
        if (entry === `@bd7pil/${name}`) return false;
        if (entry.split("@").slice(0, -1).join("@") === `@bd7pil/${name}`) return false;
        if (entry.includes(`/.ocrc/components/${name}/`)) return false;
      }
      return true;
    });
    const plugins = [.../* @__PURE__ */ new Set([
      ...asStrings(peer.effective.plugins),
      ...localPlugins,
      ...opts.componentPlugins ?? []
    ])];
    if (plugins.length > 0) merged.plugins = plugins;
    else delete merged.plugins;
    plan.managedPlugins = [...opts.componentPlugins ?? []];
    if (plan.preservedPluginKey) notes.push("\u5BF9\u7AEF\u7684 v1 plugin \u952E\u7531\u5B83\u81EA\u5DF1\u7684 openchamber \u7BA1\u7406\uFF0C\u539F\u6837\u4FDD\u7559");
    if (plan.managedPlugins.length > 0) notes.push(`\u7EC4\u4EF6\u63D2\u4EF6\u6761\u76EE\uFF1A${plan.managedPlugins.join("\u3001")}`);
    plan.merged = merged;
    plan.configChanged = hasChanges(peer.effective, merged);
    if (plan.configChanged) plan.files.unshift(plan.basename);
    if (commentedTarget) {
      if (opts.preferCommentedTarget) {
        plan.commentsWillBeLost = true;
        notes.push(`\u5BF9\u7AEF ${peer.targetBasename} \u91CC\u6709\u6CE8\u91CA\uFF0C\u6309\u4F60\u7684\u9009\u62E9\u5199\u56DE\uFF08\u6CE8\u91CA\u4F1A\u4E22\uFF09`);
      } else {
        plan.shadowed = findShadowedKeys(jsoncLayer?.parsed ?? {}, merged).filter((key) => key.split(".")[0] !== "plugin" && key.split(".")[0] !== "plugins");
        notes.push(`\u5BF9\u7AEF ${peer.targetBasename} \u6709\u6CE8\u91CA\uFF0C\u4E0D\u91CD\u5199\u5B83\uFF08\u6CE8\u91CA\u662F\u4F60\u7684\u6587\u6863\uFF09\uFF1B\u672C\u6B21\u5199 opencode.json`);
        if (plan.shadowed.length > 0) {
          notes.push(`\u4EE5\u4E0B\u952E\u4F1A\u88AB\u5BF9\u7AEF ${peer.targetBasename} \u7684\u73B0\u503C\u8986\u76D6\uFF0C\u540C\u6B65\u540E\u4E0D\u751F\u6548\uFF1A${plan.shadowed.join("\u3001")}\u2014\u2014\u66F4\u65B0\u6216\u5220\u6389\u90A3\u4E2A\u6587\u4EF6\u624D\u751F\u6548`);
        }
      }
    }
  } else {
    notes.push("\u672C\u5730\u6CA1\u6709 opencode.json/jsonc \u2014\u2014 \u53EA\u540C\u6B65\u76EE\u5F55\u7C7B\u6761\u76EE");
  }
  if (diff.unknown.length > 0) notes.push(`${diff.unknown.length} \u4E2A\u6587\u4EF6\u5BF9\u7AEF\u7B97\u4E0D\u51FA\u54C8\u5E0C\uFF08\u7F3A sha256sum\uFF09\uFF1A\u6309"\u4E0D\u53EF\u5224\u5B9A"\u5904\u7406\uFF0C\u4E0D\u5F53\u4F5C\u76F8\u540C`);
  if (diff.peerOnly.length > 0 && plan.deletes.length === 0) {
    notes.push(`\u5BF9\u7AEF\u72EC\u6709\u7684 ${diff.peerOnly.length} \u4E2A\u6587\u4EF6\u4E0D\u4F1A\u88AB\u52A8\uFF08\u8981\u5220\u5F97\u663E\u5F0F\u52FE\u9009\uFF09`);
  }
  if (plan.keyDeleteCandidates.length > 0 && plan.keyDeletes.requested.length === 0) {
    const list = plan.keyDeleteCandidates.map((c) => c.collection ? `${c.collection}:${c.key}` : c.key);
    notes.push(`\u5BF9\u7AEF\u72EC\u6709\u3001\u672C\u5730\u6CA1\u6709\u7684\u914D\u7F6E\u9879\u4E0D\u4F1A\u88AB\u52A8\uFF08\u8981\u5220\u5F97\u663E\u5F0F\u52FE\u9009\uFF09\uFF1A${list.join("\u3001")}`);
  }
  return plan;
}
function stageConfigTree(opts) {
  const entries = opts.entries ?? INSTANCE_SYNC_ENTRIES;
  const skip = new Set(opts.skipBasenames ?? CONFIG_CANDIDATES);
  mkdirSync6(opts.destDir, { recursive: true });
  const staged = [];
  for (const entry of entries) {
    if (skip.has(entry)) continue;
    const src = join7(opts.sourceDir, entry);
    if (!existsSync4(src)) continue;
    const dest = join7(opts.destDir, entry);
    cpSync(src, dest, { recursive: true, dereference: true });
    staged.push(entry);
  }
  if (opts.mergedConfig) {
    writeFileSync5(join7(opts.destDir, opts.mergedConfig.basename), opts.mergedConfig.content);
    staged.push(opts.mergedConfig.basename);
  }
  return staged;
}
function buildConfigApplyScript(deletes = []) {
  const q2 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const lines = [
    "set -e",
    `D="${PEER_CONFIG_DIR}"`,
    'S="$D/.ocrc-sync.$$"',
    'mkdir -p "$S"',
    'tar -xzf - -C "$S"',
    'cd "$S"',
    "find . -type f | sed 's#^\\./##' | while IFS= read -r rel; do",
    '  tgt="$D/$rel"',
    '  mkdir -p "$(dirname "$tgt")"',
    '  if [ -f "$tgt" ]; then',
    '    cp -p "$tgt" "$tgt.ocrc-bak"',
    '    echo "backup: $rel"',
    "  else",
    '    echo "new: $rel"',
    "  fi",
    '  mv "$S/$rel" "$tgt"',
    "done",
    'rm -rf "$S"'
  ];
  if (deletes.length > 0) {
    lines.push(
      `for rel in ${deletes.map(q2).join(" ")}; do`,
      '  tgt="$D/$rel"',
      '  if [ -f "$tgt" ]; then cp -p "$tgt" "$tgt.ocrc-bak"; rm -f "$tgt"; echo "deleted: $rel"; fi',
      "done"
    );
  }
  lines.push('echo "sync-config: applied"');
  return lines.join("\n");
}
function buildAuthPushScript() {
  return [
    "set -e",
    `A="${PEER_AUTH_PATH}"`,
    'mkdir -p "$(dirname "$A")"',
    'T="$A.ocrc-tmp.$$"',
    'cat > "$T"',
    'chmod 600 "$T"',
    'if [ -f "$A" ]; then cp -p "$A" "$A.ocrc-bak"; fi',
    'mv "$T" "$A"',
    'echo "sync-auth: written 0600"'
  ].join("\n");
}
function discardStaging(dir) {
  rmSync3(dir, { recursive: true, force: true });
}
function listStaged(dir) {
  const out = [];
  const walk = (base) => {
    for (const name of readdirSync(base)) {
      const abs = join7(base, name);
      const st = statSync3(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(toPosix(relative(dir, abs)));
    }
  };
  if (existsSync4(dir)) walk(dir);
  return out.sort();
}
var PEER_CONFIG_DIR, PEER_AUTH_PATH, INSTANCE_SYNC_ENTRIES, CONFIG_CANDIDATES, MANAGED_COLLECTIONS;
var init_instance_config = __esm({
  "../../src/core/instance-config.ts"() {
    "use strict";
    init_jsonc();
    init_config_merge();
    PEER_CONFIG_DIR = "$HOME/.config/opencode";
    PEER_AUTH_PATH = "$HOME/.local/share/opencode/auth.json";
    INSTANCE_SYNC_ENTRIES = [
      "opencode.json",
      "opencode.jsonc",
      "AGENTS.md",
      "CLAUDE.md",
      "command",
      "agent",
      "skill",
      "agents",
      "skills",
      "oh-my-opencode-slim.json",
      "reeve.jsonc",
      // GATE 代理层配置目录（`~/.config/opencode/reeve/`，里面是 fallback.jsonc）：链/策略/供应商。
      // 它是两端应当同值的"声明"（面板编辑的就是它）→ 进 sync；台账/快照/pid 那些运行态不进。
      "reeve"
    ];
    CONFIG_CANDIDATES = ["opencode.json", "opencode.jsonc"];
    MANAGED_COLLECTIONS = [
      { id: "provider", path: ["provider"] },
      { id: "mcp.servers", path: ["mcp", "servers"] }
    ];
  }
});

// src/service/main.ts
import http2 from "node:http";

// ../../src/core/remote-instance.ts
function provisionActions(f) {
  const appOk = !!f.app && f.app === f.targetAppVersion;
  if (f.provision === "reuse") {
    const out2 = ["\u590D\u7528\u5DF2\u5B89\u88C5\uFF1A\u4E0D\u63A8\u9001\u4EFB\u4F55\u5B57\u8282\uFF08\u8FD0\u884C\u65F6 / OpenChamber / OpenCode \u90FD\u4FDD\u6301\u8FDC\u7A0B\u673A\u5668\u73B0\u72B6\uFF09"];
    if (!f.runtime) out2.push("FAIL \u8FD0\u884C\u65F6\u7F3A\u5931\u2014\u2014\u590D\u7528\u5DF2\u5B89\u88C5\u4E0B\u65E0\u6CD5\u7EE7\u7EED\uFF0C\u628A\u5B89\u88C5\u65B9\u5F0F\u6539\u56DE\u300C\u63A8\u9001\u5B89\u88C5\u300D");
    if (!appOk) out2.push(`FAIL OpenChamber \u7F3A\u5931\u6216\u7248\u672C\u4E0D\u7B26\uFF08\u8FDC\u7A0B\u673A\u5668 ${f.app ?? "\u7F3A\u5931"} \u2260 ${f.targetAppVersion}\uFF09\u2014\u2014\u6539\u56DE\u300C\u63A8\u9001\u5B89\u88C5\u300D`);
    if (!f.engineOk) out2.push(`FAIL OpenCode \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF1A${f.engineError ?? "\u539F\u56E0\u672A\u77E5"}`);
    if (f.runtime && appOk && f.engineOk) out2.push("\u68C0\u67E5\u901A\u8FC7\uFF0C\u53EF\u4EE5\u76F4\u63A5\u542F\u52A8");
    return out2;
  }
  const out = [];
  if (!f.runtime) out.push(`\u63A8\u9001\u8FD0\u884C\u65F6 node v${f.runtime ?? NODE_RUNTIME.version}\uFF08\u63A7\u5236\u7AEF\u5DF2\u5907\u4EF6\uFF0C\u79BB\u7EBF\uFF09`);
  if (!appOk) out.push(`\u63A8\u9001 OpenChamber ${f.targetAppVersion} \u5230 ~/.ocrc/remote/openchamber/${f.targetAppVersion}\uFF08\u65E7\u6811\u7559 .ocrc-bak\uFF09`);
  if (f.runtime && appOk) out.push("\u8FD0\u884C\u65F6\u4E0E OpenChamber \u90FD\u5728\u4F4D\uFF0C\u63A8\u9001\u4F1A\u8DF3\u8FC7");
  if (!f.engineOk) {
    out.push(`\u5B89\u88C5\u6211\u4EEC pin \u7684 OpenCode ${f.enginePin ?? DEFAULT_ENGINE_PIN} \u5230 ~/.ocrc/remote/engine/opencode\uFF08\u8FDC\u7A0B\u673A\u5668\u73B0\u6709 v1 \u4E00\u5F8B\u4E0D\u52A8\uFF09`);
  }
  return out;
}
var PROXY_DEFAULTS = { enabled: true, localPort: 4711, remotePort: 2711, allow: [] };
var EGRESS_DEFAULT = "auto";
var EGRESS_PROBE_URL = "https://models.dev/api.json";
function buildEgressProbeCommand(o) {
  const p = instancePaths(o.appVersion);
  const url = o.url ?? EGRESS_PROBE_URL;
  const timeout = o.timeoutMs ?? 1500;
  const deadline = o.deadlineMs ?? 6e3;
  const nodeProbe = [
    "const dns=require('dns'),net=require('net')",
    `const H=${JSON.stringify(o.host ?? "models.dev")},T=${timeout}`,
    "const done=(v)=>{console.log(v);process.exit(0)}",
    `setTimeout(()=>done('unknown'),${deadline})`,
    'const tryList=(list,viaDns)=>{let i=0;const next=()=>{if(i>=list.length)return done(viaDns?"dns-only":"none");const a=list[i++];const s=net.connect({host:a.address,port:443,timeout:T},()=>{s.destroy();done("direct")});s.on("error",()=>{s.destroy();next()});s.on("timeout",()=>{s.destroy();next()})};next()}',
    "let answered=false",
    'const fallback=()=>{if(answered)return;answered=true;tryList([{address:"1.1.1.1",family:4}],false)}',
    "setTimeout(fallback,1500)",
    `dns.lookup(H,{all:true},(e,all)=>{if(answered)return;answered=true;if(e||!all||!all.length)return tryList([{address:'1.1.1.1',family:4}],false);tryList([...all].sort((x,y)=>x.family-y.family),true)})`
  ].join(";");
  const qq = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return [
    `U=${qq(url)}`,
    // `timeout` is the outer hard cap: curl's own `--max-time` cannot interrupt a
    // blocking `getaddrinfo`, so a peer with a *hanging* resolver (measured on the
    // offline EL7) kept curl busy for glibc's full retry schedule (~10 s per
    // family). A killed attempt (124) is **not** a verdict — it falls through to the
    // node probe, which bounds the resolver itself and can still separate "no
    // route" from "no resolver".
    'TMO=""; command -v timeout >/dev/null 2>&1 && TMO="timeout 5"',
    // curl: 0 = got a response (any status counts — a 401 from models.dev still
    // proves the route), 6 = could not resolve, 7 = could not connect, 28 = timeout.
    "if command -v curl >/dev/null 2>&1; then",
    '  $TMO curl -4 -sS -o /dev/null --connect-timeout 3 --max-time 5 "$U" >/dev/null 2>&1; r4=$?',
    '  [ "$r4" = 0 ] && { echo direct; exit 0; }',
    '  if [ "$r4" != 124 ]; then',
    '    $TMO curl -6 -sS -o /dev/null --connect-timeout 3 --max-time 5 "$U" >/dev/null 2>&1; r6=$?',
    '    [ "$r6" = 0 ] && { echo direct; exit 0; }',
    '    if [ "$r4" = 6 ] && [ "$r6" = 6 ]; then echo dns-only; exit 0; fi',
    '    for c in "$r4" "$r6"; do case "$c" in 6|7|28) ;; *) echo unknown; exit 0 ;; esac; done',
    "    echo none; exit 0",
    "  fi",
    "fi",
    // wget: 0 = fetched, 8 = the server answered with an error status (still a
    // route!), 4 = network failure, 6 = auth. So 8 counts as reachable.
    "if command -v wget >/dev/null 2>&1; then",
    '  $TMO wget -4 -q -T 4 -O /dev/null "$U" >/dev/null 2>&1; w4=$?',
    '  { [ "$w4" = 0 ] || [ "$w4" = 8 ]; } && { echo direct; exit 0; }',
    '  if [ "$w4" != 124 ]; then',
    '    $TMO wget -6 -q -T 4 -O /dev/null "$U" >/dev/null 2>&1; w6=$?',
    '    { [ "$w6" = 0 ] || [ "$w6" = 8 ]; } && { echo direct; exit 0; }',
    '    [ "$w4" = 4 ] && [ "$w6" = 4 ] && { echo none; exit 0; }',
    "    echo unknown; exit 0",
    "  fi",
    "fi",
    `${p.node} -e ${q(nodeProbe)}`
  ].join("\n");
}
function parseEgressProbe(stdout) {
  const last = stdout.trim().split(/\r?\n/).pop()?.trim();
  return last === "direct" || last === "dns-only" || last === "none" ? last : "unknown";
}
function resolveEgressPolicy(o) {
  const mode = o.mode ?? EGRESS_DEFAULT;
  if (!o.relayAllowed) return { relay: false, reason: "relay \u5DF2\u5173\u95ED" };
  if (mode === "direct") return { relay: false, reason: "\u6309\u914D\u7F6E\u76F4\u8FDE" };
  if (mode === "relay") return { relay: true, reason: "\u6309\u914D\u7F6E\u7ECF\u672C\u673A\u8F6C\u53D1" };
  switch (o.probe) {
    case "direct":
      return { relay: false, reason: "\u8FDC\u7A0B\u673A\u5668\u81EA\u5DF1\u80FD\u51FA\u7F51" };
    case "dns-only":
      return { relay: true, reason: "\u8FDC\u7A0B\u673A\u5668\u6709\u8DEF\u7531\u4F46 DNS \u4E0D\u901A" };
    case "none":
      return { relay: true, reason: "\u8FDC\u7A0B\u673A\u5668\u51FA\u4E0D\u4E86\u7F51" };
    default:
      return { relay: true, reason: "\u63A2\u6D4B\u672A\u6210\u529F\u2014\u2014\u4FDD\u5B88\u7ECF\u672C\u673A\u8F6C\u53D1" };
  }
}
var RECONNECT_DEFAULTS = { reconnect: true, restoreOnStart: true, replayQueued: false };
var DEFAULT_APP_VERSION = "2.3.3";
var DEFAULT_INSTANCE_PORT = 2610;
var DEFAULT_LOCAL_PORT = 4610;
function instanceIdFor(target) {
  const raw = `${target.user ? `${target.user}@` : ""}${target.host}`;
  return raw.replace(/[^A-Za-z0-9._@-]/g, "-");
}
function redactInstance(i) {
  const { uiPassword, sshPassword, ...rest } = i;
  return { ...rest, hasUiPassword: !!uiPassword, hasSshPassword: !!sshPassword };
}
var MIN_ENGINE_VERSION = "2.0.20";
var ENGINE_MAJOR = 2;
var DEFAULT_ENGINE_PIN = "2.0.32";
var NODE_RUNTIME = {
  version: "24.22.0",
  /** Directory name inside the tarball. */
  unpackedDir: "node-v24.22.0-linux-x64-glibc-217",
  tarball: "node-v24.22.0-linux-x64-glibc-217.tar.xz",
  base: "https://unofficial-builds.nodejs.org/download/release/v24.22.0"
};
var APP_CLI_REL = "lib/node_modules/@openchamber/web/bin/cli.js";
function instancePaths(appVersion) {
  const root = "$HOME/.ocrc/remote";
  const runtimeDir = `${root}/runtime/node-v${NODE_RUNTIME.version}`;
  const appPrefix = `${root}/openchamber/${appVersion}`;
  return {
    root,
    staging: `${root}/.staging`,
    runtimeDir,
    node: `${runtimeDir}/bin/node`,
    appPrefix,
    cli: `${appPrefix}/${APP_CLI_REL}`,
    engineDir: `${root}/engine`,
    log: `${root}/instance.log`
  };
}
function normalizeEngineVersion(raw) {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw ?? "");
  return m?.[1] ?? "";
}
function isSupportedEngineVersion(version) {
  const parts = normalizeEngineVersion(version).split(/[-+]/, 1)[0]?.split(".").map(Number) ?? [];
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n))) return false;
  if (parts[0] !== ENGINE_MAJOR) return false;
  const floor = MIN_ENGINE_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}
var DEFAULT_ENGINE_CANDIDATES = [
  "$HOME/.ocrc/remote/engine/opencode",
  "$HOME/.opencode/bin/opencode",
  "$HOME/.local/bin/opencode",
  "/usr/local/bin/opencode",
  "/usr/bin/opencode"
];
var q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
function quoteRemotePath(path) {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"${q(path.slice(1))}`;
  if (path.startsWith("$HOME/")) return `"$HOME"${q(path.slice("$HOME".length))}`;
  return q(path);
}
function buildEngineProbeCommand(candidates = DEFAULT_ENGINE_CANDIDATES) {
  return [
    "for c in " + candidates.map(quoteRemotePath).join(" ") + "; do",
    '  if [ -x "$c" ]; then',
    '    v=$("$c" --version 2>/dev/null | head -1)',
    '    printf "%s\\t%s\\n" "$c" "$v"',
    "  fi",
    "done"
  ].join("\n");
}
function parseEngineProbe(stdout) {
  const out = [];
  for (const line of (stdout ?? "").split("\n")) {
    const bare = line.replace(/\r$/, "");
    const tab = bare.indexOf("	");
    if (tab <= 0) continue;
    const path = bare.slice(0, tab).trim();
    const raw = bare.slice(tab + 1).trim();
    if (!path) continue;
    out.push({ path, version: normalizeEngineVersion(raw), raw });
  }
  return out;
}
function pickV2Engine(candidates) {
  for (const candidate of candidates) {
    if (isSupportedEngineVersion(candidate.version)) return { ok: true, candidate };
  }
  if (candidates.length === 0) {
    return { ok: false, error: `\u8FDC\u7A0B\u673A\u5668\u4E0A\u6CA1\u6709\u627E\u5230\u6EE1\u8DB3 v2 \u95E8\u7981\u7684 OpenCode\uFF08\u5019\u9009\uFF1A${DEFAULT_ENGINE_CANDIDATES.join(", ")}\uFF09\u2014\u2014\u5148\u88C5\u4E00\u4EFD v2\uFF08\u9762\u677F\u7684\u300C\u68C0\u67E5\u5E76\u5B89\u88C5\u300D\u4F1A\u63A8\u6211\u4EEC pin \u7684\u90A3\u4EFD\uFF09`, seen: [] };
  }
  const seen = candidates.map((c) => `${c.path} \u2192 ${c.raw || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"}`).join("\uFF1B");
  return {
    ok: false,
    error: `\u76EE\u6807\u673A\u4E0A\u7684 opencode \u90FD\u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF08\u9700 major=2 \u4E14 \u2265 ${MIN_ENGINE_VERSION}\uFF09\uFF1A${seen}`,
    seen: candidates
  };
}
function buildInstanceServeCommand(o) {
  const p = instancePaths(o.appVersion);
  const exports = renderExports({
    HTTP_PROXY: o.proxy?.httpProxy,
    http_proxy: o.proxy?.httpProxy,
    HTTPS_PROXY: o.proxy?.httpsProxy,
    https_proxy: o.proxy?.httpsProxy,
    NO_PROXY: o.proxy?.httpProxy || o.proxy?.httpsProxy ? [o.proxy?.noProxy?.trim(), "127.0.0.1", "localhost"].filter(Boolean).join(",") : o.proxy?.noProxy,
    NODE_EXTRA_CA_CERTS: o.proxy?.caPath
  });
  const env = `${exports}${renderExports({
    ...o.extraEnv,
    OPENCODE_BINARY: o.enginePath,
    OPENCHAMBER_UI_PASSWORD: o.uiPassword,
    // Air-gapped hosts: never dial the hosted relay, and make that explicit.
    OPENCHAMBER_RELAY_HOST: "off"
  })}`;
  const line = `${env}${p.node} ${p.cli} serve --hostname 127.0.0.1 --port ${o.port}`;
  return o.detached ? `nohup sh -c ${q(line)} >> ${p.log} 2>&1 < /dev/null & echo started` : line;
}
function renderExports(vars) {
  const out = Object.keys(vars).sort().filter((k) => vars[k] !== void 0 && vars[k] !== "").map((k) => `${k}=${q(String(vars[k]))}`);
  return out.length ? `export ${out.join(" ")}; ` : "";
}
function buildPairLinkCommand(o) {
  const p = instancePaths(o.appVersion);
  return `${p.node} ${p.cli} connect-url --port ${o.instancePort} --server ${q(o.serverUrl)} --name ${q(o.label)}`;
}
function parsePairLink(output) {
  return output.match(/openchamber:\/\/connect\?v=2&p=[A-Za-z0-9_-]+/)?.[0];
}
function describePairLink(link) {
  try {
    const payload = JSON.parse(Buffer.from(new URL(link).searchParams.get("p") ?? "", "base64url").toString("utf8"));
    return {
      ...typeof payload.label === "string" ? { label: payload.label } : {},
      ...typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {},
      candidates: Array.isArray(payload.candidates) ? payload.candidates.length : 0
    };
  } catch {
    return void 0;
  }
}
function buildInstanceStopCommand(appVersion, port) {
  const p = instancePaths(appVersion);
  return `${p.node} ${p.cli} stop --port ${port} || true`;
}
function sshAuthArgs(target) {
  if (target.sshAuth !== "password") return ["-o", "BatchMode=yes"];
  return [
    "-o",
    "BatchMode=no",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "PreferredAuthentications=password,keyboard-interactive",
    "-o",
    "NumberOfPasswordPrompts=1"
  ];
}
function buildSshExecArgs(target, command) {
  return [
    ...sshAuthArgs(target),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=no",
    "-p",
    String(target.port || 22),
    target.user ? `${target.user}@${target.host}` : target.host,
    command
  ];
}
function buildRemotePortProbeCommand(appVersion, port) {
  const node = instancePaths(appVersion).node;
  const js = `const n=require('net');const s=n.connect(${port},'127.0.0.1',()=>{console.log('open');s.destroy();process.exit(0)});s.on('error',()=>{console.log('closed');process.exit(0)});setTimeout(()=>{console.log('closed');s.destroy();process.exit(0)},3000)`;
  return `if [ -x ${node} ]; then ${node} -e "${js}"; else echo closed; fi`;
}
function buildPeerPortProbeCommand(appVersion, port) {
  const node = instancePaths(appVersion).node;
  const js = `const n=require('net');const s=n.connect(${port},'127.0.0.1',()=>{console.log('open');s.destroy();process.exit(0)});s.on('error',()=>{console.log('closed');process.exit(0)});setTimeout(()=>{console.log('closed');s.destroy();process.exit(0)},2000)`;
  return [
    `if [ -x ${node} ]; then ${node} -e "${js}";`,
    `elif command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q "[:.]${port} " && echo open || echo closed;`,
    `elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | grep -q "[:.]${port} " && echo open || echo closed;`,
    "else echo unknown; fi"
  ].join(" ");
}
function parsePortProbe(stdout) {
  const last = (stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
  return last === "open" || last === "closed" ? last : "unknown";
}
function buildInstanceProxyProbeCommand(_appVersion, port) {
  return [
    `PORT=${port}`,
    "ME=$$",
    'FOUND=""',
    "for d in /proc/[0-9]*; do",
    "  pid=${d#/proc/}",
    '  [ "$pid" = "$ME" ] && continue',
    `  c=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null) || continue`,
    '  case "$c" in *"--port $PORT"*)',
    '    case "$c" in *".ocrc/remote"*) FOUND="$pid"; break ;; esac',
    '    [ -n "$FOUND" ] || FOUND="$pid"',
    "  ;; esac",
    "done",
    'if [ -z "$FOUND" ]; then echo "PROXY=unknown";',
    `elif tr '\\0' '\\n' < "/proc/$FOUND/environ" 2>/dev/null | grep -q "^HTTPS_PROXY="; then`,
    `  tr '\\0' '\\n' < "/proc/$FOUND/environ" 2>/dev/null | sed -n "s/^HTTPS_PROXY=//p" | head -1 | sed "s/^/PROXY=/"`,
    'else echo "PROXY=none"; fi'
  ].join("\n");
}
function parseInstanceProxyProbe(stdout) {
  const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("PROXY=")).pop();
  if (!line) return "unknown";
  const value = line.slice("PROXY=".length).trim();
  if (!value || value === "unknown") return "unknown";
  return value === "none" ? "none" : value;
}
function relayProxyUrl(remotePort) {
  return `http://127.0.0.1:${remotePort}`;
}
function buildPeerLogCommand(appVersion, port, lines = 40) {
  const p = instancePaths(appVersion);
  const appLog = `$HOME/.config/openchamber/logs/openchamber-${port}.log`;
  return [
    `echo "PATH_INSTANCE=${p.log}"`,
    `echo "PATH_APP=${appLog}"`,
    'echo "INSTANCE_BEGIN"',
    `tail -n ${lines} ${p.log} 2>/dev/null`,
    'echo "INSTANCE_END"',
    'echo "APP_BEGIN"',
    `tail -n ${lines} ${appLog} 2>/dev/null`,
    'echo "APP_END"',
    'echo "DONE=1"'
  ].join("\n");
}
function parsePeerLogs(stdout) {
  const section = (name) => {
    const m = new RegExp(`${name}_BEGIN\\r?\\n([\\s\\S]*?)\\r?\\n${name}_END`).exec(stdout);
    if (!m) return [];
    return m[1].split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
  };
  return {
    instance: section("INSTANCE"),
    app: section("APP"),
    paths: {
      instance: /^PATH_INSTANCE=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "",
      app: /^PATH_APP=(.*)$/m.exec(stdout)?.[1]?.trim() ?? ""
    }
  };
}
function buildTerminalProbeCommand(appVersion) {
  const p = instancePaths(appVersion);
  const pty = `${p.appPrefix}/lib/node_modules/@openchamber/web/node_modules/node-pty`;
  const node = p.node;
  const js = `const f=process.argv[1]+'/prebuilds/'+process.platform+'-'+process.arch+'/pty.node';try{require(f);console.log('terminal-ok')}catch(e){console.log('terminal-unavailable: '+String(e.message).split('\\n')[0])}`;
  return `if [ -x ${node} ]; then ${node} -e "${js}" ${quoteRemotePath(pty)}; else echo terminal-unavailable: \u8FD0\u884C\u65F6\u4E0D\u5728\u4F4D; fi`;
}
function parseTerminalProbe(stdout) {
  const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (line === "terminal-ok") return { ok: true };
  const reason = line.startsWith("terminal-unavailable:") ? line.slice("terminal-unavailable:".length).trim() : line || "\uFF08\u65E0\u8F93\u51FA\uFF09";
  return { ok: false, reason };
}
function buildForwardArgs(spec) {
  return [
    ...sshAuthArgs(spec),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "ExitOnForwardFailure=yes",
    "-p",
    String(spec.port || 22),
    "-N",
    "-L",
    `127.0.0.1:${spec.localPort}:127.0.0.1:${spec.remotePort}`,
    ...spec.reverse ? ["-R", `127.0.0.1:${spec.reverse.remotePort}:127.0.0.1:${spec.reverse.localPort}`] : [],
    spec.user ? `${spec.user}@${spec.host}` : spec.host
  ];
}
function buildRelayForwardArgs(spec) {
  if (!spec.reverse) throw new Error("relay forward requires a reverse spec");
  const args = buildForwardArgs(spec);
  const i = args.indexOf("-L");
  if (i !== -1) args.splice(i, 2);
  return args;
}
var REQUIRED_INSTANCE_CAPABILITY = "api.runtime-url.v1";
function judgeEngineCompat(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "\u5B9E\u4F8B\u6CA1\u6709\u8FD4\u56DE OpenCode \u517C\u5BB9\u6027" };
  const state = String(payload.state ?? "");
  const version = normalizeEngineVersion(String(payload.version ?? ""));
  const binary = String(payload.binary ?? "");
  if (state !== "compatible") {
    return { ok: false, error: `\u5B9E\u4F8B\u7684 OpenCode \u517C\u5BB9\u6027 state=${state || "\uFF08\u7A7A\uFF09"}\uFF08\u9700\u8981 compatible\uFF09` };
  }
  if (!isSupportedEngineVersion(version)) {
    return { ok: false, error: `\u5B9E\u4F8B\u7528\u7684 OpenCode ${version || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"} \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF08\u9700 major=2 \u4E14 \u2265 ${MIN_ENGINE_VERSION}\uFF09${binary ? `\uFF1B\u4E8C\u8FDB\u5236 ${binary}` : ""}` };
  }
  if (!binary.startsWith("/")) {
    return { ok: false, error: `\u5B9E\u4F8B\u62A5\u7684 OpenCode \u8DEF\u5F84\u4E0D\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF1A${binary || "\uFF08\u7A7A\uFF09"}` };
  }
  return { ok: true, version, binary };
}
function judgeInstanceVersion(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "\u5B9E\u4F8B\u6CA1\u6709\u8FD4\u56DE\u7248\u672C\u4FE1\u606F" };
  const version = String(payload.openchamberVersion ?? "");
  if (payload.status !== "ok" || !version) {
    return { ok: false, error: `\u5B9E\u4F8B\u7248\u672C\u54CD\u5E94\u4E0D\u662F openchamber\uFF08\u6536\u5230 ${JSON.stringify(payload).slice(0, 120)}\uFF09` };
  }
  const capabilities = payload.compatibility?.capabilities ?? [];
  if (!capabilities.includes(REQUIRED_INSTANCE_CAPABILITY)) {
    return { ok: false, error: `\u5B9E\u4F8B\u7F3A\u5C11\u80FD\u529B ${REQUIRED_INSTANCE_CAPABILITY}\uFF08\u7248\u672C ${version}\uFF09\u2014\u2014\u5347\u7EA7\u5B9E\u4F8B` };
  }
  if (Number(version.split(".")[0]) < 2) return { ok: false, error: `\u5B9E\u4F8B\u7248\u672C ${version} \u8FC7\u65E7\uFF08\u9700\u8981 major=2\uFF09` };
  return { ok: true, version, capabilities, serverId: payload.serverId };
}

// ../../src/core/remote-instances.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, renameSync as renameSync2, writeFileSync } from "node:fs";
import { dirname, join as join3 } from "node:path";

// ../../src/utils/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join as join2 } from "node:path";

// ../../src/utils/paths.ts
import { join } from "node:path";
import { homedir } from "node:os";
function ocrcHome() {
  return process.env.OCRC_HOME ?? join(homedir(), ".ocrc");
}

// ../../src/utils/logger.ts
var LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function currentLevel() {
  const raw = (process.env.LOG_LEVEL ?? "warn").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}
function logFilePath() {
  return join2(ocrcHome(), "ocrc.log");
}
var DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
function maxLogBytes() {
  const raw = Number(process.env.OCRC_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LOG_BYTES;
}
function rotateIfNeeded(fp) {
  try {
    if (statSync(fp).size >= maxLogBytes()) renameSync(fp, `${fp}.old`);
  } catch {
  }
}
var logFileReady = false;
function ensureLogFile() {
  if (logFileReady) return;
  try {
    const fp = logFilePath();
    mkdirSync(join2(fp, ".."), { recursive: true });
    logFileReady = true;
  } catch {
  }
}
function format(level, mod, msg, extra) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const extras = extra.length ? " " + extra.map(formatExtra).join(" ") : "";
  return `[${ts}] [${level.toUpperCase()}] [${mod}] ${msg}${extras}`;
}
function formatExtra(e) {
  if (e instanceof Error) return e.stack ?? e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return "[unserializable]";
  }
}
var RING_SIZE = 500;
var ring = [];
function write(level, mod, msg, extra) {
  const line = format(level, mod, msg, extra);
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
  ensureLogFile();
  try {
    const fp = logFilePath();
    rotateIfNeeded(fp);
    appendFileSync(fp, line + "\n");
  } catch {
    if (level === "error" || level === "warn") console.error(line);
  }
}
function createLogger(mod) {
  return {
    debug: (msg, ...extra) => {
      if (currentLevel() <= LEVELS.debug) write("debug", mod, msg, extra);
    },
    info: (msg, ...extra) => {
      if (currentLevel() <= LEVELS.info) write("info", mod, msg, extra);
    },
    warn: (msg, ...extra) => {
      if (currentLevel() <= LEVELS.warn) write("warn", mod, msg, extra);
    },
    error: (msg, ...extra) => {
      if (currentLevel() <= LEVELS.error) write("error", mod, msg, extra);
    }
  };
}

// ../../src/utils/secret.ts
import { randomBytes } from "node:crypto";
function generateSecret() {
  return randomBytes(18).toString("base64url");
}

// ../../src/core/remote-instances.ts
var log = createLogger("remote-instances");
function remoteInstancesPath(home) {
  return join3(home, "remote-instances.json");
}
function createRemoteInstancesStore(path, opts = {}) {
  let instances = [];
  function load() {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      if (!Array.isArray(raw.instances)) return;
      instances = raw.instances.filter((i) => i && typeof i.id === "string" && typeof i.host === "string" && i.host);
    } catch (err) {
      log.warn(`failed to load ${path}: ${err.message}`);
    }
  }
  let writeQueued;
  let pending;
  function writeNow() {
    if (!pending) return;
    const snapshot = pending;
    pending = void 0;
    try {
      mkdirSync2(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ instances: snapshot }, null, 2), { mode: 384 });
      renameSync2(tmp, path);
    } catch (err) {
      log.warn(`persist failed: ${err.message}`);
    }
  }
  function persist() {
    pending = instances.map((i) => ({ ...i }));
    if (writeQueued) clearTimeout(writeQueued);
    writeQueued = setTimeout(() => {
      writeQueued = void 0;
      writeNow();
    }, 100);
    writeQueued.unref?.();
    if (opts.flushOnExit !== false && !exitHooked) {
      exitHooked = true;
      process.on("exit", writeNow);
    }
  }
  let exitHooked = false;
  function normalize(i) {
    const sshAuth = i.sshAuth === "password" ? "password" : void 0;
    const sshPassword = sshAuth === "password" && i.sshPassword ? String(i.sshPassword) : void 0;
    return {
      ...i,
      name: i.name?.trim() || void 0,
      user: i.user?.trim() || void 0,
      sshAuth,
      sshPassword,
      port: i.port > 0 ? i.port : 22,
      instancePort: i.instancePort > 0 ? i.instancePort : DEFAULT_INSTANCE_PORT,
      localPort: i.localPort > 0 ? i.localPort : DEFAULT_LOCAL_PORT,
      appVersion: i.appVersion?.trim() || DEFAULT_APP_VERSION,
      enabled: i.enabled ?? true,
      provision: i.provision === "reuse" ? "reuse" : void 0,
      // 出口策略是闭集：认不出来的值等于没设（= auto，由探测决定），
      // 不能让一个拼错的值悄悄变成"总是经控制端"。
      egress: i.egress === "relay" || i.egress === "direct" ? i.egress : void 0,
      // C2b: per-peer provider URL rewrites — only non-empty strings survive, so
      // a half-filled form cannot write `baseURL: undefined` into the peer.
      providerBaseUrl: (() => {
        const src = i.providerBaseUrl;
        if (!src || typeof src !== "object") return void 0;
        const out = {};
        for (const [provider, url] of Object.entries(src)) {
          const key = provider.trim();
          const value = typeof url === "string" ? url.trim() : "";
          if (key && value) out[key] = value;
        }
        return Object.keys(out).length > 0 ? out : void 0;
      })(),
      reconnect: i.reconnect ?? RECONNECT_DEFAULTS.reconnect,
      restoreOnStart: i.restoreOnStart ?? RECONNECT_DEFAULTS.restoreOnStart,
      replayQueued: i.replayQueued ?? RECONNECT_DEFAULTS.replayQueued,
      proxy: {
        enabled: i.proxy?.enabled ?? PROXY_DEFAULTS.enabled,
        localPort: i.proxy?.localPort && i.proxy.localPort > 0 ? i.proxy.localPort : PROXY_DEFAULTS.localPort,
        remotePort: i.proxy?.remotePort && i.proxy.remotePort > 0 ? i.proxy.remotePort : PROXY_DEFAULTS.remotePort,
        allow: Array.isArray(i.proxy?.allow) ? [...new Set(i.proxy.allow.map((a) => String(a).trim().toLowerCase()).filter(Boolean))] : []
      }
    };
  }
  load();
  return {
    list: () => instances.map((i) => ({ ...i })),
    reload() {
      if (!pending) load();
    },
    flush() {
      if (writeQueued) {
        clearTimeout(writeQueued);
        writeQueued = void 0;
      }
      writeNow();
    },
    get: (id) => {
      const i = instances.find((x) => x.id === id);
      return i ? { ...i } : void 0;
    },
    upsert(instance) {
      const id = instance.id?.trim() || instanceIdFor(instance);
      const existing = instances.find((x) => x.id === id);
      if (existing) {
        Object.assign(existing, instance, { id });
        Object.assign(existing, normalize(existing));
        existing.uiPassword ??= generateSecret();
        persist();
        return { ...existing };
      }
      const fresh = normalize({
        id,
        host: instance.host,
        port: instance.port ?? 22,
        user: instance.user,
        sshAuth: instance.sshAuth,
        sshPassword: instance.sshPassword,
        name: instance.name,
        instancePort: instance.instancePort ?? DEFAULT_INSTANCE_PORT,
        localPort: instance.localPort ?? DEFAULT_LOCAL_PORT,
        uiPassword: instance.uiPassword || generateSecret(),
        enginePath: instance.enginePath,
        engineVersion: instance.engineVersion,
        appVersion: instance.appVersion ?? DEFAULT_APP_VERSION,
        enabled: instance.enabled ?? true,
        provision: instance.provision,
        egress: instance.egress,
        providerBaseUrl: instance.providerBaseUrl,
        reconnect: instance.reconnect,
        restoreOnStart: instance.restoreOnStart,
        replayQueued: instance.replayQueued,
        proxy: instance.proxy
      });
      instances.push(fresh);
      persist();
      return { ...fresh };
    },
    update(id, patch) {
      const i = instances.find((x) => x.id === id);
      if (!i) return void 0;
      Object.assign(i, patch);
      Object.assign(i, normalize(i));
      persist();
      return { ...i };
    },
    remove(id) {
      const idx = instances.findIndex((x) => x.id === id);
      if (idx === -1) return false;
      instances.splice(idx, 1);
      persist();
      return true;
    }
  };
}

// ../../src/core/remote-instance-bridge.ts
import { spawn as spawn3 } from "node:child_process";
import net2 from "node:net";
import { mkdtempSync, openSync, readFileSync as readFileSync7 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join10 } from "node:path";

// ../../src/core/remote-common.ts
function parseGlibcVersion(firstLine) {
  const m = firstLine?.match(/(\d+\.\d+)/);
  return m?.[1];
}
function nextRetryDelay(attempt) {
  return Math.min(6e4, 2e3 * 2 ** Math.max(0, attempt - 1));
}

// ../../src/core/remote-instance-proxy.ts
import http from "node:http";
import net from "node:net";
var log2 = createLogger("remote-instance-proxy");
function parseConnectTarget(line) {
  const m = /^CONNECT\s+(\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5})\s+HTTP\/1\.[01]$/i.exec((line ?? "").trim());
  if (!m) return void 0;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return void 0;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}
function parseAbsoluteUrlTarget(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return void 0;
    return { host: u.hostname, port: Number(u.port || 80) };
  } catch {
    return void 0;
  }
}
function isLocalTarget(host) {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  return false;
}
function isTargetAllowed(host, allow) {
  const entries = (allow ?? []).map((raw) => raw.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (entries.length === 0) return true;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return entries.some((entry) => h === entry || h.endsWith(`.${entry}`));
}
function createInstanceProxy(opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  const connects = [];
  const say = (line) => {
    log2.info(line);
    opts.onLog?.(line);
  };
  const server2 = http.createServer((req, res) => {
    const target = parseAbsoluteUrlTarget(req.url ?? "");
    if (!target) {
      res.writeHead(400, { "content-type": "text/plain" }).end("absolute-form http:// URL required\n");
      return;
    }
    if (!isTargetAllowed(target.host, opts.allow)) {
      say(`refused target ${target.host}\uFF08\u4E0D\u5728\u767D\u540D\u5355\uFF1A${(opts.allow ?? []).join(", ") || "\uFF08\u7A7A\uFF09"}\uFF09`);
      res.writeHead(403, { "content-type": "text/plain" }).end("target not in relay allowlist\n");
      return;
    }
    if (!opts.allowLocal && isLocalTarget(target.host)) {
      say(`refused local target ${target.host}:${target.port}\uFF08\u4EE3\u7406\u662F\u7ED9\u5BF9\u7AEF\u51FA\u7F51\u7528\u7684\uFF0C\u4E0D\u662F\u901A\u5F80\u63A7\u5236\u7AEF\u7684\u95E8\uFF09`);
      res.writeHead(403, { "content-type": "text/plain" }).end("local targets refused\n");
      return;
    }
    connects.push(target);
    opts.onConnect?.(target);
    say(`GET ${target.host}:${target.port}${new URL(req.url).pathname}`);
    const upstream = http.request(
      { host: target.host, port: target.port, method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream error: ${err.message}
`);
    });
    req.pipe(upstream);
  });
  server2.on("connect", (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url ? `CONNECT ${req.url} HTTP/1.1` : "");
    if (!target) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!isTargetAllowed(target.host, opts.allow)) {
      say(`refused target ${target.host}\uFF08\u4E0D\u5728\u767D\u540D\u5355\uFF1A${(opts.allow ?? []).join(", ") || "\uFF08\u7A7A\uFF09"}\uFF09`);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (!opts.allowLocal && isLocalTarget(target.host)) {
      say(`refused local target ${target.host}:${target.port}`);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    connects.push(target);
    opts.onConnect?.(target);
    say(`CONNECT ${target.host}:${target.port}`);
    const upstream = net.connect(target.port, target.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = (err) => {
      say(`upstream ${target.host}:${target.port} failed: ${err.message}`);
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("end", () => upstream.end());
  });
  return new Promise((resolve, reject) => {
    server2.on("error", reject);
    server2.listen(opts.port ?? 0, host, () => {
      const addr = server2.address();
      if (!addr || typeof addr === "string") {
        server2.close();
        reject(new Error("proxy: no port"));
        return;
      }
      say(`proxy listening on ${host}:${addr.port}`);
      resolve({
        port: addr.port,
        connects,
        close: () => new Promise((done) => {
          server2.close(() => done());
          server2.closeAllConnections?.();
        })
      });
    });
  });
}

// ../../src/core/remote-instance-push.ts
import { createHash as createHash2 } from "node:crypto";
import { spawn as spawn2 } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync as existsSync3,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync3,
  renameSync as renameSync3,
  rmSync as rmSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";

// ../../src/core/bin-cache.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2, rmSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
var log3 = createLogger("bin-cache");
function bundleDir() {
  return process.env.OCRC_BUNDLE_DIR ?? join4(binCacheRoot(), "bundle");
}
function readBundleManifest(dir = bundleDir()) {
  const p = join4(dir, "manifest.json");
  if (!existsSync2(p)) return void 0;
  try {
    return JSON.parse(readFileSync2(p, "utf-8"));
  } catch {
    return void 0;
  }
}
function bundleArtifactPath(version, target, dir = bundleDir()) {
  return join4(dir, `cli-${target}-${version}.tgz`);
}
function takeBundleArtifact(version, target, dir = bundleDir()) {
  const file = bundleArtifactPath(version, target, dir);
  if (!existsSync2(file)) return void 0;
  const digest = readBundleManifest(dir)?.digests?.[target]?.sha512;
  if (!digest) {
    log3.warn(`bundle has ${file} but no digest for ${target} \u2014 ignoring it (unverified bytes are not worth using)`);
    return void 0;
  }
  const expected = digest.startsWith("sha512-") ? digest.slice(7) : digest;
  const actual = createHash("sha512").update(readFileSync2(file)).digest("base64");
  if (actual !== expected) {
    throw new Error(`bundle artifact digest mismatch for ${target}@${version}\uFF1A${file} \u4E0D\u662F CI \u4EA7\u51FA\u7684\u90A3\u4E00\u4EFD\uFF08\u62D2\u7EDD\u4F7F\u7528\uFF09`);
  }
  return { file, sha512: actual };
}
var REGISTRY = "https://registry.npmjs.org";
function binCacheRoot() {
  const ocrcHome2 = process.env.OCRC_HOME ?? join4(homedir2(), ".ocrc");
  return join4(ocrcHome2, "bin-cache");
}
function npmTargetFor(platform, arch) {
  const a = arch === "arm64" || arch === "aarch64" ? "arm64" : "x64";
  return `${platform}-${a}`;
}
function verifyIntegrity(file, integrity) {
  const expected = integrity.startsWith("sha512-") ? integrity.slice(7) : integrity;
  const actual = createHash("sha512").update(readFileSync2(file)).digest("base64");
  return actual === expected;
}
function proxyAwareFetch(url, timeoutMs) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (proxy) log3.warn(`HTTPS_PROXY=${proxy} is set but not applied to registry fetch (no proxy agent dependency); direct fetch attempted`);
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}
async function fetchIntegrity(version, target, timeoutMs = 3e4) {
  const url = `${REGISTRY}/@opencode%2Fcli-${target}`;
  const res = await proxyAwareFetch(url, timeoutMs);
  if (!res.ok) throw new Error(`registry metadata ${res.status} for @opencode/cli-${target}`);
  const meta = await res.json();
  const integrity = meta.versions?.[version]?.dist?.integrity;
  if (!integrity) throw new Error(`no integrity for cli-${target}@${version}`);
  return integrity;
}
async function cacheArtifact(version, target, timeoutMs = 3e5) {
  const root = binCacheRoot();
  const dir = join4(root, version);
  const dest = join4(dir, `cli-${target}-${version}.tgz`);
  if (existsSync2(dest)) {
    log3.info(`cache hit: ${dest}`);
    return dest;
  }
  mkdirSync3(dir, { recursive: true });
  const bundled = takeBundleArtifact(version, target);
  if (bundled) {
    writeFileSync2(dest, readFileSync2(bundled.file), { mode: 420 });
    log3.info(`bundle hit: ${bundled.file} \u2192 ${dest}\uFF08sha512 \u6821\u9A8C\u901A\u8FC7\uFF0C\u672A\u8D70\u7F51\u7EDC\uFF09`);
    return dest;
  }
  const integrity = await fetchIntegrity(version, target);
  const url = `${REGISTRY}/@opencode/cli-${target}/-/cli-${target}-${version}.tgz`;
  log3.info(`downloading ${url}`);
  const res = await proxyAwareFetch(url, timeoutMs);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.part`;
  writeFileSync2(tmp, buf);
  if (!verifyIntegrity(tmp, integrity)) {
    rmSync(tmp, { force: true });
    throw new Error(`integrity mismatch for cli-${target}@${version} \u2014 cache poisoned?`);
  }
  writeFileSync2(dest, buf, { mode: 420 });
  rmSync(tmp, { force: true });
  return dest;
}
function tarPath(p) {
  return process.platform === "win32" ? p.replaceAll("\\", "/") : p;
}
async function extractBinary(tgzPath, destDir) {
  mkdirSync3(destDir, { recursive: true });
  const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
  await new Promise((resolve, reject) => {
    const child = spawn("tar", [...forceLocal, "-xzf", tarPath(tgzPath), "-C", tarPath(destDir), "package/bin/opencode"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tar extract failed: ${err.trim()}`)));
  });
  const bin = join4(destDir, "package", "bin", "opencode");
  if (!existsSync2(bin)) throw new Error(`binary missing after extract: ${bin}`);
  chmodSync(bin, 493);
  return bin;
}
function readManifest() {
  const p = join4(binCacheRoot(), "manifest.json");
  if (!existsSync2(p)) return void 0;
  try {
    return JSON.parse(readFileSync2(p, "utf-8"));
  } catch {
    return void 0;
  }
}
function resolveV2Pin() {
  return readManifest()?.opencodePin ?? process.env.OCRC_V2_PIN ?? void 0;
}

// ../../src/core/ssh-askpass.ts
import { chmodSync as chmodSync2, mkdirSync as mkdirSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
var ASKPASS_VALUE_ENV = "OPENCHAMBER_SSH_ASKPASS_VALUE";
function needsAskpass(spec) {
  return spec.sshAuth === "password" && !!spec.sshPassword;
}
function askpassShellScript() {
  return [
    "#!/bin/sh",
    "# Generated by ocrc. Contains no secret: the password arrives in",
    `# ${ASKPASS_VALUE_ENV} (see src/core/ssh-askpass.ts).`,
    'prompt="$1"',
    'case "$prompt" in',
    `  *assword*|*assphrase*) printf '%s\\n' "$${ASKPASS_VALUE_ENV}"; exit 0 ;;`,
    "esac",
    "printf '\\n'",
    ""
  ].join("\n");
}
function askpassPowerShellScript() {
  return [
    `$value = [Environment]::GetEnvironmentVariable('${ASKPASS_VALUE_ENV}')`,
    "if ($null -ne $value) { [Console]::Out.WriteLine($value) }",
    ""
  ].join("\n");
}
function askpassCmdWrapper() {
  return [
    "@echo off\r",
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0askpass.ps1"\r',
    ""
  ].join("\n");
}
function askpassDir(home = ocrcHome()) {
  return join5(home, "ssh");
}
var written = /* @__PURE__ */ new Set();
function ensureAskpassFiles(dir = askpassDir(), platform = process.platform) {
  const wrapper = platform === "win32" ? join5(dir, "askpass.cmd") : join5(dir, "askpass.sh");
  if (written.has(wrapper)) return wrapper;
  mkdirSync4(dir, { recursive: true, mode: 448 });
  if (platform === "win32") {
    writeFileSync3(join5(dir, "askpass.ps1"), askpassPowerShellScript());
    writeFileSync3(wrapper, askpassCmdWrapper());
  } else {
    writeFileSync3(wrapper, askpassShellScript(), { mode: 448 });
    chmodSync2(wrapper, 448);
  }
  written.add(wrapper);
  return wrapper;
}
function askpassEnv(spec, opts = {}) {
  if (!needsAskpass(spec)) return void 0;
  const helper = ensureAskpassFiles(opts.dir ?? askpassDir(), opts.platform);
  return {
    ...process.env,
    SSH_ASKPASS_REQUIRE: "force",
    SSH_ASKPASS: helper,
    DISPLAY: "1",
    [ASKPASS_VALUE_ENV]: String(spec.sshPassword).trim()
  };
}

// ../../src/core/remote-instance-push.ts
var log4 = createLogger("remote-instance-push");
var APP_PACKAGE = "@openchamber/web";
function appCacheDir(appVersion) {
  return join6(binCacheRoot(), "remote-app", appVersion);
}
function appTreeDir(appVersion) {
  return join6(appCacheDir(appVersion), "tree");
}
function appPayloadPath(appVersion) {
  return join6(appCacheDir(appVersion), `app-${appVersion}.tar.gz`);
}
function appPackTierForGlibc(glibc) {
  const m = glibc?.match(/(\d+)\.(\d+)/);
  if (!m) return "modern";
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < 2 || major === 2 && minor < 31 ? "legacy-glibc217" : "modern";
}
function appPackName(appVersion, tier) {
  return `ocrc-openchamber-pack-${appVersion}-linux-x64-${tier}.tar.gz`;
}
function appPackPath(appVersion, tier) {
  return join6(appCacheDir(appVersion), appPackName(appVersion, tier));
}
function appPackManifestUrl(appVersion) {
  const base = (process.env.OCRC_PACK_BASE ?? `https://github.com/BD7PIL/ocrc/releases/download/ocrc-openchamber-pack-${appVersion}`).replace(/\/+$/, "");
  return `${base}/ocrc-openchamber-pack-manifest.json`;
}
function parseAppPackManifest(raw, tier) {
  const manifest = raw;
  const entry = manifest?.tiers?.[tier];
  if (!entry?.asset || !entry.sha512Base64) return void 0;
  return { asset: entry.asset, sha512Base64: entry.sha512Base64 };
}
function verifiedPack(file, marker) {
  if (!existsSync3(file) || !existsSync3(marker)) return void 0;
  const sha = readFileSync3(marker, "utf-8").trim();
  if (!sha || sha512Base64(file) !== sha) return void 0;
  return { sha, shaHex: sha512Hex(file) };
}
async function ensureAppPack(appVersion, tier, opts = {}) {
  const file = appPackPath(appVersion, tier);
  const marker = `${file}.sha512`;
  if (!opts.force) {
    const cached = verifiedPack(file, marker);
    if (cached) return { file, bytes: statSync2(file).size, sha: cached.sha, shaHex: cached.shaHex, prepared: false, tier };
  }
  for (const dir of [opts.packDir, process.env.OCRC_PACK_DIR].filter((d) => !!d?.trim())) {
    const candidate = join6(dir, appPackName(appVersion, tier));
    if (!existsSync3(candidate)) continue;
    const sha = sha512Base64(candidate);
    mkdirSync5(dirname2(file), { recursive: true });
    copyFileSync(candidate, file);
    writeFileSync4(marker, `${sha}
`);
    opts.onLog?.(`\u5E94\u7528\u5305\u5DF2\u5C31\u4F4D\uFF1A${appPackName(appVersion, tier)}\uFF08\u672C\u5730\u76EE\u5F55\uFF09`);
    return { file, bytes: statSync2(file).size, sha, shaHex: sha512Hex(file), prepared: false, tier };
  }
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const manifestUrl = appPackManifestUrl(appVersion);
    const res = await doFetch(manifestUrl, { signal: AbortSignal.timeout(2e4) });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const entry = parseAppPackManifest(await res.json(), tier);
    if (!entry) throw new Error(`manifest \u91CC\u6CA1\u6709 ${tier} \u6863`);
    const url = new URL(entry.asset, manifestUrl).toString();
    const dl = await doFetch(url, { signal: AbortSignal.timeout(6e5) });
    if (!dl.ok) throw new Error(`pack HTTP ${dl.status}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const sha = createHash2("sha512").update(bytes).digest("base64");
    if (sha !== entry.sha512Base64) throw new Error("pack sha512 mismatch");
    mkdirSync5(dirname2(file), { recursive: true });
    writeFileSync4(file, bytes);
    writeFileSync4(marker, `${sha}
`);
    opts.onLog?.(`\u5E94\u7528\u5305\u5DF2\u53D6\u4EF6\uFF1A${appPackName(appVersion, tier)}\uFF08${(bytes.length / 1e6).toFixed(1)}MB\uFF09`);
    return { file, bytes: bytes.length, sha, shaHex: sha512Hex(file), prepared: false, tier };
  } catch (err) {
    opts.onLog?.(`\u5E94\u7528\u5305\u4E0D\u53EF\u7528\uFF08${err.message}\uFF09\u2014\u2014\u56DE\u9000\u63A7\u5236\u7AEF\u8DE8\u88C5`);
    return void 0;
  }
}
function runtimeCacheDir() {
  return join6(binCacheRoot(), "remote-runtime", NODE_RUNTIME.version);
}
function runtimePayloadPath() {
  return join6(runtimeCacheDir(), NODE_RUNTIME.tarball);
}
function npmBinary(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}
function buildWindowsCommandLine(cmd, args) {
  const quote = (a) => /[\s"&|<>^()%]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a;
  return [cmd, ...args.map(quote)].join(" ");
}
function buildCrossInstallInvocation(appVersion, treeDir, platform = process.platform) {
  return {
    cmd: npmBinary(platform),
    // `npm.cmd` needs a shell on Windows; nothing else here does.
    needsShell: platform === "win32",
    args: [
      "install",
      "-g",
      "--prefix",
      treeDir,
      "--os=linux",
      "--cpu=x64",
      "--libc=glibc",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `${APP_PACKAGE}@${appVersion}`
    ]
  };
}
function buildPackInvocation(treeDirName, outFileName) {
  return { cmd: "tar", args: ["-czf", outFileName, "-C", treeDirName, "."], needsShell: false };
}
function findAppPackageDir(treeDir) {
  for (const rel of ["lib/node_modules", "node_modules"]) {
    const dir = join6(treeDir, rel, "@openchamber", "web");
    if (existsSync3(join6(dir, "package.json"))) return dir;
  }
  return void 0;
}
function normalizeTreeLayout(treeDir) {
  const app = findAppPackageDir(treeDir);
  if (!app) throw new Error(`app package not found in tree: ${treeDir}\uFF08\u5148\u8DD1\u4EA4\u53C9\u5B89\u88C5\uFF09`);
  if (app.startsWith(join6(treeDir, "lib"))) return { appPackageDir: app, moved: false };
  const src = join6(treeDir, "node_modules");
  const dest = join6(treeDir, "lib", "node_modules");
  mkdirSync5(join6(treeDir, "lib"), { recursive: true });
  if (existsSync3(dest)) rmSync2(dest, { recursive: true, force: true });
  renameSync3(src, dest);
  for (const shim of ["openchamber", "openchamber.cmd", "openchamber.ps1"]) {
    rmSync2(join6(treeDir, shim), { force: true });
  }
  return { appPackageDir: join6(dest, "@openchamber", "web"), moved: true };
}
function parseShasumsLine(text, name) {
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed);
    if (m && m[2].trim() === name) return m[1];
  }
  return void 0;
}
function buildRuntimeProbeCommand() {
  const p = instancePaths("x");
  return `if [ -x ${p.node} ]; then ${p.node} --version; else echo MISSING; fi`;
}
function buildAppProbeCommand(appVersion) {
  const p = instancePaths(appVersion);
  return `if [ -f ${p.cli} ]; then ${p.node} ${p.cli} --version; else echo MISSING; fi`;
}
function buildRuntimePushScript(sha256Hex2) {
  const p = instancePaths("x");
  const short = `node-v${NODE_RUNTIME.version}`;
  return [
    "set -e",
    `R="${p.root}"`,
    `S="$R/.staging/runtime-node-${NODE_RUNTIME.version}"`,
    'rm -rf "$S"',
    'mkdir -p "$S"',
    'cat > "$S/payload.tar.xz"',
    `if ! printf '%s  %s\\n' '${sha256Hex2}' "$S/payload.tar.xz" | sha256sum -c - >/dev/null 2>&1; then`,
    '  echo "payload sha256 mismatch (\u4F20\u8F93\u635F\u574F\u6216\u7F13\u5B58\u88AB\u6C61\u67D3)" >&2',
    "  exit 4",
    "fi",
    `mkdir -p "$R/runtime"`,
    `cd "$R/runtime"`,
    `tar xf "$S/payload.tar.xz"`,
    `rm -rf ${short}`,
    `mv ${NODE_RUNTIME.unpackedDir} ${short}`,
    'rm -rf "$S"',
    `${p.node} --version`,
    `echo "runtime: pushed"`
  ].join("\n");
}
function buildAppPushScript(appVersion, sha512Base642) {
  const p = instancePaths(appVersion);
  const cliRel = APP_CLI_REL;
  return [
    "set -e",
    `R="${p.root}"`,
    `N="${p.node}"`,
    `S="$R/.staging/app-${appVersion}"`,
    `P="${p.appPrefix}"`,
    `if [ ! -x "$N" ]; then echo "runtime missing: $N\uFF08\u5148\u63A8\u8FD0\u884C\u65F6\uFF09" >&2; exit 6; fi`,
    'rm -rf "$S"',
    'mkdir -p "$S/unpacked"',
    'cat > "$S/payload.tar.gz"',
    `if ! printf '%s  %s\\n' '${sha512Base642}' "$S/payload.tar.gz" | sha512sum -c - >/dev/null 2>&1; then`,
    '  echo "payload sha512 mismatch (\u4F20\u8F93\u635F\u574F\u6216\u7F13\u5B58\u88AB\u6C61\u67D3)" >&2',
    "  exit 4",
    "fi",
    'tar xzf "$S/payload.tar.gz" -C "$S/unpacked"',
    `if [ ! -f "$S/unpacked/${cliRel}" ]; then`,
    '  echo "payload shape unexpected: ' + cliRel + ' \u4E0D\u5728\u5305\u91CC" >&2',
    "  exit 5",
    "fi",
    `mkdir -p "$R/openchamber"`,
    `if [ -e "$P" ]; then rm -rf "$P.ocrc-bak"; mv "$P" "$P.ocrc-bak"; echo "backup: openchamber/${appVersion} \u2192 .ocrc-bak"; fi`,
    'mv "$S/unpacked" "$P"',
    'rm -rf "$S"',
    `"$N" "$P/${cliRel}" --version`,
    `echo "app: pushed"`
  ].join("\n");
}
var ENGINE_TARGET = "linux-x64";
function engineCacheDir(version, target = ENGINE_TARGET) {
  return join6(binCacheRoot(), "remote-engine", `${version}-${target}`);
}
function engineBinaryPath(version, target = ENGINE_TARGET) {
  return join6(engineCacheDir(version, target), "package", "bin", "opencode");
}
function resolveEnginePin(explicit) {
  return explicit?.trim() || resolveV2Pin() || DEFAULT_ENGINE_PIN;
}
function buildDeployedEngineProbeCommand() {
  const e = `${instancePaths("x").engineDir}/opencode`;
  return `if [ -x ${e} ]; then ${e} --version; else echo MISSING; fi`;
}
function buildEnginePushScript(version, sha256Hex2) {
  const p = instancePaths("x");
  return [
    "set -e",
    `R="${p.root}"`,
    `E="${p.engineDir}/opencode"`,
    `S="$R/.staging/engine-${version}"`,
    'rm -rf "$S"',
    'mkdir -p "$S" "$(dirname "$E")"',
    'cat > "$S/opencode"',
    `if ! printf '%s  %s\\n' '${sha256Hex2}' "$S/opencode" | sha256sum -c - >/dev/null 2>&1; then`,
    '  echo "payload sha256 mismatch (\u4F20\u8F93\u635F\u574F\u6216\u7F13\u5B58\u88AB\u6C61\u67D3)" >&2',
    "  exit 4",
    "fi",
    'chmod 755 "$S/opencode"',
    'V=$("$S/opencode" --version 2>&1 | head -1)',
    `case "$V" in *'${version}'*) ;; *) echo "engine version gate failed: $V (\u9700\u8981 ${version})" >&2; exit 7 ;; esac`,
    `if [ -e "$E" ]; then cp -p "$E" "$E.ocrc-bak"; echo "backup: engine/opencode \u2192 .ocrc-bak"; fi`,
    'mv "$S/opencode" "$E"',
    'rm -rf "$S"',
    '"$E" --version',
    'echo "engine: pushed"'
  ].join("\n");
}
var EGRESS_PATTERNS = [
  ["curl", /\bcurl\b/],
  ["wget", /\bwget\b/],
  ["npm", /\bnpm\b/],
  ["npx", /\bnpx\b/],
  ["yarn", /\byarn\b/],
  ["pnpm", /\bpnpm\b/],
  ["bun", /\bbun\b/],
  ["git", /\bgit\b/],
  ["pip", /\bpip3?\b/],
  ["apt", /\bapt(-get)?\b/],
  ["yum", /\byum\b/],
  ["dnf", /\bdnf\b/],
  ["ssh", /\bssh\b/],
  ["scp/sftp", /\b(?:scp|sftp)\b/],
  ["nc/telnet", /\b(?:nc|ncat|telnet)\b/],
  ["upstream installer", /opencode\.ai\/install/]
];
function findEgressCommands(script) {
  const hits = /* @__PURE__ */ new Set();
  for (const [name, re] of EGRESS_PATTERNS) if (re.test(script)) hits.add(name);
  return [...hits];
}
function assertOfflineSafe(script, what = "\u8FDC\u7A0B\u811A\u672C") {
  const hits = findEgressCommands(script);
  if (hits.length > 0) throw new Error(`${what} \u542B\u8054\u7F51\u547D\u4EE4\uFF08${hits.join(", ")}\uFF09\u2014\u2014\u79BB\u7EBF\u5DE5\u51B5\u4E0B\u4E0D\u8BB8\u51FA\u73B0`);
}
function buildOfflineGuardExports(port = 1) {
  const dead = `http://127.0.0.1:${port}`;
  return `export http_proxy='${dead}' https_proxy='${dead}' HTTP_PROXY='${dead}' HTTPS_PROXY='${dead}' no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost' npm_config_registry='${dead}/'; `;
}
function wrapForTrace(script, traceFile) {
  const b64 = Buffer.from(script, "utf-8").toString("base64");
  const p = instancePaths("x");
  return [
    `mkdir -p "${p.staging}"`,
    `printf %s '${b64}' | base64 -d > "${p.staging}/traced.sh"`,
    `strace -f -e trace=connect -o '${traceFile}' sh "${p.staging}/traced.sh"`,
    "rc=$?",
    `rm -f "${p.staging}/traced.sh"`,
    "exit $rc"
  ].join("\n");
}
function sha512Base64(file) {
  return createHash2("sha512").update(readFileSync3(file)).digest("base64");
}
function sha512Hex(file) {
  return createHash2("sha512").update(readFileSync3(file)).digest("hex");
}
function sha256Hex(file) {
  return createHash2("sha256").update(readFileSync3(file)).digest("hex");
}
function sshRun(target, command, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn2("ssh", buildSshExecArgs(target, command), {
      stdio: ["ignore", "pipe", "pipe"],
      env: askpassEnv(target)
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : void 0;
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}
${err.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
function sshRunWithStdin(target, command, input, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn2("ssh", buildSshExecArgs(target, command), {
      stdio: ["pipe", "pipe", "pipe"],
      env: askpassEnv(target)
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const timer = opts.timeoutMs ? setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr: `${stderr}
timeout after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs) : void 0;
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => done({ code: null, stdout, stderr: `${stderr}
${err.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(input);
  });
}
function pushFileOverSsh(target, file, script, opts = {}) {
  return new Promise((resolve) => {
    const total = statSync2(file).size;
    let sent = 0;
    const child = spawn2("ssh", buildSshExecArgs(target, script), {
      stdio: ["pipe", "pipe", "pipe"],
      env: askpassEnv(target)
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const timer = opts.timeoutMs ? setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr: `${stderr}
timeout after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs) : void 0;
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => done({ code: null, stdout, stderr: `${stderr}
${err.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    const src = createReadStream(file);
    src.on("data", (chunk) => {
      sent += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      opts.onProgress?.(sent, total);
    });
    src.on("error", (err) => {
      try {
        child.kill();
      } catch {
      }
      done({ code: null, stdout, stderr: `${stderr}
read ${file}: ${err.message}` });
    });
    child.stdin?.on("error", (err) => {
      if (err.code !== "EPIPE") stderr += `
stdin: ${err.message}`;
    });
    src.pipe(child.stdin);
  });
}
async function runInvocation(inv, cwd) {
  await new Promise((resolve, reject) => {
    const child = inv.needsShell ? spawn2(buildWindowsCommandLine(inv.cmd, inv.args), { cwd, shell: true, stdio: ["ignore", "ignore", "pipe"] }) : spawn2(inv.cmd, inv.args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => reject(new Error(`${inv.cmd}: ${e.message}`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${inv.cmd} ${inv.args.join(" ")} \u9000\u51FA\u7801 ${code}
${err.trim().slice(-2e3)}`)));
  });
}
async function ensureAppTree(appVersion, opts = {}) {
  const treeDir = appTreeDir(appVersion);
  if (opts.force) rmSync2(treeDir, { recursive: true, force: true });
  if (findAppPackageDir(treeDir)) {
    const layout2 = normalizeTreeLayout(treeDir);
    if (layout2.moved) opts.onLog?.(`tree \u5DF2\u5F52\u4E00\u5230 lib/node_modules\uFF1A${layout2.appPackageDir}`);
    return { treeDir, installed: false };
  }
  mkdirSync5(dirname2(treeDir), { recursive: true });
  const inv = buildCrossInstallInvocation(appVersion, treeDir);
  opts.onLog?.(`$ ${inv.cmd} ${inv.args.join(" ")}`);
  await runInvocation(inv, dirname2(treeDir));
  const layout = normalizeTreeLayout(treeDir);
  opts.onLog?.(`tree ready: ${layout.appPackageDir}${layout.moved ? "\uFF08\u5DF2\u5F52\u4E00\u5230 lib/node_modules\uFF09" : ""}`);
  return { treeDir, installed: true };
}
async function ensureAppPayload(appVersion, opts = {}) {
  if (opts.tier) {
    const pack = await ensureAppPack(appVersion, opts.tier, { force: opts.force, onLog: opts.onLog, packDir: opts.packDir });
    if (pack) return pack;
  }
  const { treeDir } = await ensureAppTree(appVersion, opts);
  const payload = appPayloadPath(appVersion);
  const marker = `${payload}.sha512`;
  const fresh = existsSync3(payload) && existsSync3(marker) && statSync2(payload).mtimeMs >= statSync2(treeDir).mtimeMs;
  if (fresh && !opts.force) {
    const bytes = statSync2(payload).size;
    return { file: payload, bytes, sha: readFileSync3(marker, "utf-8").trim(), shaHex: sha512Hex(payload), prepared: false };
  }
  const inv = buildPackInvocation("tree", `app-${appVersion}.tar.gz`);
  opts.onLog?.(`$ tar czf ${payload} -C ${treeDir} .`);
  await runInvocation(inv, appCacheDir(appVersion));
  const sha = sha512Base64(payload);
  writeFileSync4(marker, `${sha}
`);
  return { file: payload, bytes: statSync2(payload).size, sha, shaHex: sha512Hex(payload), prepared: true };
}
async function ensureRuntimePayload(opts = {}) {
  const file = runtimePayloadPath();
  const sums = join6(runtimeCacheDir(), "SHASUMS256.txt");
  const marker = `${file}.sha256`;
  if (existsSync3(file) && existsSync3(marker) && !opts.force) {
    const sha2 = readFileSync3(marker, "utf-8").trim();
    if (sha256Hex(file) === sha2) return { file, bytes: statSync2(file).size, sha: sha2, shaHex: sha2, prepared: false };
    opts.onLog?.(`\u7F13\u5B58\u6821\u9A8C\u4E0D\u7B26\uFF0C\u91CD\u65B0\u53D6\u4EF6\uFF1A${file}`);
    rmSync2(file, { force: true });
  }
  mkdirSync5(runtimeCacheDir(), { recursive: true });
  const fetchTo = async (url, dest) => {
    opts.onLog?.(`$ curl -fsSL ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(6e5) });
    if (!res.ok) throw new Error(`GET ${url} \u2192 HTTP ${res.status}`);
    writeFileSync4(dest, Buffer.from(await res.arrayBuffer()));
  };
  await fetchTo(`${NODE_RUNTIME.base}/SHASUMS256.txt`, sums);
  await fetchTo(`${NODE_RUNTIME.base}/${NODE_RUNTIME.tarball}`, file);
  const expected = parseShasumsLine(readFileSync3(sums, "utf-8"), NODE_RUNTIME.tarball);
  if (!expected) throw new Error(`SHASUMS256.txt \u91CC\u6CA1\u6709 ${NODE_RUNTIME.tarball}`);
  const sha = sha256Hex(file);
  if (sha !== expected) {
    rmSync2(file, { force: true });
    throw new Error(`\u8FD0\u884C\u65F6\u5305 sha256 \u4E0D\u7B26\uFF1A\u671F\u671B ${expected.slice(0, 16)}\u2026\uFF0C\u5B9E\u5F97 ${sha.slice(0, 16)}\u2026`);
  }
  writeFileSync4(marker, `${sha}
`);
  return { file, bytes: statSync2(file).size, sha, shaHex: sha, prepared: true };
}
function decorate(script, what, diag, label) {
  assertOfflineSafe(script, `${label}\u8FDC\u7A0B\u811A\u672C`);
  let out = diag?.guard ? `${buildOfflineGuardExports()}${script}` : script;
  if (diag?.trace) out = wrapForTrace(out, `${diag.trace}.${what}`);
  return out;
}
function tailLine(r) {
  const text = `${r.stdout}
${r.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return text[text.length - 1] ?? `exit ${r.code}`;
}
async function probeRemoteRuntime(target) {
  const r = await sshRun(target, buildRuntimeProbeCommand(), { timeoutMs: 3e4 });
  const v = r.stdout.trim().split("\n")[0] ?? "";
  return v && v !== "MISSING" ? v : void 0;
}
async function probeRemoteApp(target, appVersion) {
  const r = await sshRun(target, buildAppProbeCommand(appVersion), { timeoutMs: 6e4 });
  const v = r.stdout.trim().split("\n")[0] ?? "";
  return v && v !== "MISSING" ? v : void 0;
}
async function deployRuntimeToRemote(target, opts = {}) {
  const existing = await probeRemoteRuntime(target);
  if (existing === `v${NODE_RUNTIME.version}` && !opts.force) {
    opts.onLog?.(`runtime \u5DF2\u5728\u4F4D\uFF1A${existing}\uFF08\u8DF3\u8FC7\u63A8\u9001\uFF09`);
    return { ok: true, detail: `\u5DF2\u5728\u4F4D ${existing}` };
  }
  const payload = await ensureRuntimePayload(opts);
  const script = decorate(buildRuntimePushScript(payload.shaHex), "runtime", opts, "\u8FD0\u884C\u65F6\u63A8\u9001");
  opts.onLog?.(`\u63A8\u9001 runtime ${(payload.bytes / 1e6).toFixed(1)}MB\uFF08sha256 ${payload.shaHex.slice(0, 12)}\u2026\uFF09`);
  const r = await pushFileOverSsh(target, payload.file, script, { timeoutMs: 9e5, onProgress: opts.onProgress });
  if (r.code !== 0) return { ok: false, detail: `\u8FD0\u884C\u65F6\u63A8\u9001\u5931\u8D25\uFF1A${tailLine(r)}` };
  const version = r.stdout.trim().split("\n").filter((l) => /^v\d/.test(l)).pop() ?? "";
  if (version !== `v${NODE_RUNTIME.version}`) return { ok: false, detail: `\u8FD0\u884C\u65F6\u7248\u672C\u4E0D\u7B26\uFF1A${version || "\uFF08\u65E0\u8F93\u51FA\uFF09"}` };
  return { ok: true, detail: `\u5DF2\u63A8\u9001 ${version}` };
}
async function deployAppToRemote(target, appVersion, opts = {}) {
  const existing = await probeRemoteApp(target, appVersion);
  if (existing === appVersion && !opts.force) {
    opts.onLog?.(`\u5E94\u7528\u5DF2\u5728\u4F4D\uFF1A${existing}\uFF08\u8DF3\u8FC7\u63A8\u9001\uFF09`);
    return { ok: true, detail: `\u5DF2\u5728\u4F4D ${existing}` };
  }
  const payload = await ensureAppPayload(appVersion, opts);
  const script = decorate(buildAppPushScript(appVersion, payload.shaHex), "app", opts, "\u5E94\u7528\u63A8\u9001");
  opts.onLog?.(`\u63A8\u9001 app ${(payload.bytes / 1e6).toFixed(1)}MB\uFF08sha512 ${payload.shaHex.slice(0, 12)}\u2026\uFF09`);
  const r = await pushFileOverSsh(target, payload.file, script, { timeoutMs: 18e5, onProgress: opts.onProgress });
  if (r.code !== 0) return { ok: false, detail: `\u5E94\u7528\u63A8\u9001\u5931\u8D25\uFF1A${tailLine(r)}` };
  const version = r.stdout.trim().split("\n").filter((l) => /^\d+\.\d+\.\d+/.test(l)).pop() ?? "";
  if (version !== appVersion) return { ok: false, detail: `\u5E94\u7528\u7248\u672C\u4E0D\u7B26\uFF1A${version || "\uFF08\u65E0\u8F93\u51FA\uFF09"}` };
  return { ok: true, detail: `\u5DF2\u63A8\u9001 ${version}` };
}
async function ensureEngineBinary(opts = {}) {
  const version = resolveEnginePin(opts.version);
  const target = opts.target ?? npmTargetFor("linux", "x64");
  const bin = engineBinaryPath(version, target);
  const marker = `${bin}.sha256`;
  if (existsSync3(bin) && existsSync3(marker) && !opts.force) {
    const sha2 = sha256Hex(bin);
    if (sha2 === readFileSync3(marker, "utf-8").trim()) {
      return { file: bin, bytes: statSync2(bin).size, sha: sha2, shaHex: sha2, prepared: false, version, target };
    }
    opts.onLog?.(`\u5F15\u64CE\u7F13\u5B58\u6821\u9A8C\u4E0D\u7B26\uFF0C\u91CD\u65B0\u53D6\u4EF6\uFF1A${bin}`);
    rmSync2(bin, { force: true });
  }
  opts.onLog?.(`$ bin-cache: @opencode/cli-${target}@${version}`);
  const tgz = await cacheArtifact(version, target);
  const extracted = await extractBinary(tgz, engineCacheDir(version, target));
  const sha = sha256Hex(extracted);
  writeFileSync4(`${extracted}.sha256`, `${sha}
`);
  return { file: extracted, bytes: statSync2(extracted).size, sha, shaHex: sha, prepared: true, version, target };
}
async function probeRemoteEngine(target) {
  const r = await sshRun(target, buildDeployedEngineProbeCommand(), { timeoutMs: 3e4 });
  const v = r.stdout.trim().split("\n")[0] ?? "";
  return v && v !== "MISSING" ? v : void 0;
}
async function deployEngineToRemote(target, opts = {}) {
  const payload = await ensureEngineBinary(opts);
  const expected = `opencode v${payload.version}`;
  const existing = await probeRemoteEngine(target);
  const path = `${instancePaths("x").engineDir}/opencode`;
  if (existing === expected && !opts.force) {
    opts.onLog?.(`\u5F15\u64CE\u5DF2\u5728\u4F4D\uFF1A${existing}\uFF08\u8DF3\u8FC7\u63A8\u9001\uFF09`);
    return { ok: true, detail: `\u5DF2\u5728\u4F4D ${expected}`, version: payload.version, path };
  }
  const script = decorate(buildEnginePushScript(payload.version, payload.shaHex), "engine", opts, "\u5F15\u64CE\u63A8\u9001");
  opts.onLog?.(`\u63A8\u9001 engine ${payload.version} ${(payload.bytes / 1e6).toFixed(0)}MB\uFF08sha256 ${payload.shaHex.slice(0, 12)}\u2026\uFF09`);
  const r = await pushFileOverSsh(target, payload.file, script, { timeoutMs: 9e5, onProgress: opts.onProgress });
  if (r.code !== 0) return { ok: false, detail: `\u5F15\u64CE\u63A8\u9001\u5931\u8D25\uFF1A${tailLine(r)}`, version: payload.version, path };
  const printed = r.stdout.trim().split("\n").filter((l) => /opencode v/.test(l)).pop() ?? "";
  if (printed !== expected) return { ok: false, detail: `\u5F15\u64CE\u7248\u672C\u4E0D\u7B26\uFF1A${printed || "\uFF08\u65E0\u8F93\u51FA\uFF09"}\uFF08\u9700\u8981 ${expected}\uFF09`, version: payload.version, path };
  return { ok: true, detail: `\u5DF2\u63A8\u9001 ${printed}`, version: payload.version, path };
}
async function provisionOffline(target, appVersion, opts = {}) {
  const runtime = await deployRuntimeToRemote(target, opts);
  if (!runtime.ok) {
    const why = { version: resolveEnginePin(opts.engineVersion), path: `${instancePaths("x").engineDir}/opencode` };
    return {
      ok: false,
      runtime,
      engine: { ok: false, detail: "\u8FD0\u884C\u65F6\u672A\u5C31\u7EEA\uFF0C\u8DF3\u8FC7\u5F15\u64CE", ...why },
      app: { ok: false, detail: "\u8FD0\u884C\u65F6\u672A\u5C31\u7EEA\uFF0C\u8DF3\u8FC7\u5E94\u7528" }
    };
  }
  const engine = opts.skipEngine ? { ok: true, detail: "\u6309\u663E\u5F0F pin \u8DF3\u8FC7\uFF08\u7528\u5BF9\u7AEF\u65E2\u6709\u5F15\u64CE\uFF09", version: opts.engineVersion ?? "", path: "" } : await deployEngineToRemote(target, { ...opts, version: opts.engineVersion });
  const app = await deployAppToRemote(target, appVersion, opts);
  return { ok: runtime.ok && engine.ok && app.ok, runtime, engine, app };
}

// ../../src/core/remote-instance-bridge.ts
init_instance_config();

// ../../src/core/components.ts
import { execFileSync } from "node:child_process";
import { createHash as createHash4 } from "node:crypto";
import { cpSync as cpSync2, existsSync as existsSync5, mkdirSync as mkdirSync7, readFileSync as readFileSync5, readdirSync as readdirSync2, rmSync as rmSync4, statSync as statSync4, writeFileSync as writeFileSync6 } from "node:fs";
import { homedir as homedir3, tmpdir } from "node:os";
import { basename, dirname as dirname3, join as join8 } from "node:path";
import { fileURLToPath } from "node:url";
var COMPONENT_SCHEMA = 1;
function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}
function requireString(source, value, field) {
  if (typeof value !== "string" || value.trim().length === 0) fail(source, `${field} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
  return value;
}
function parseComponentManifest(raw, source = "provision.json") {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(source, "\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
  const doc = raw;
  if (doc.schema !== COMPONENT_SCHEMA) fail(source, `schema \u5FC5\u987B\u662F ${COMPONENT_SCHEMA}\uFF08\u6536\u5230 ${String(doc.schema)}\uFF09`);
  const manifest = {
    schema: COMPONENT_SCHEMA,
    name: requireString(source, doc.name, "name"),
    version: requireString(source, doc.version, "version")
  };
  if (doc.license !== void 0) manifest.license = requireString(source, doc.license, "license");
  if (doc.host !== void 0) {
    if (typeof doc.host !== "object" || doc.host === null) fail(source, "host \u5FC5\u987B\u662F\u5BF9\u8C61");
    const host = doc.host;
    manifest.host = {
      node: host.node === void 0 ? void 0 : requireString(source, host.node, "host.node"),
      os: Array.isArray(host.os) ? host.os.map((v) => requireString(source, v, "host.os[]")) : void 0,
      arch: Array.isArray(host.arch) ? host.arch.map((v) => requireString(source, v, "host.arch[]")) : void 0
    };
  }
  if (doc.enginePlugin !== void 0) {
    if (typeof doc.enginePlugin !== "object" || doc.enginePlugin === null) fail(source, "enginePlugin \u5FC5\u987B\u662F\u5BF9\u8C61");
    const plugin = doc.enginePlugin;
    const kind = plugin.kind;
    if (kind !== "package" && kind !== "directory") fail(source, "enginePlugin.kind \u53EA\u8BA4 package | directory");
    manifest.enginePlugin = {
      spec: requireString(source, plugin.spec, "enginePlugin.spec"),
      kind,
      entry: plugin.entry === void 0 ? void 0 : requireString(source, plugin.entry, "enginePlugin.entry"),
      requiresPeer: Array.isArray(plugin.requiresPeer) ? plugin.requiresPeer.map((v) => requireString(source, v, "enginePlugin.requiresPeer[]")) : void 0
    };
  }
  if (doc.artifacts !== void 0) {
    if (!Array.isArray(doc.artifacts)) fail(source, "artifacts \u5FC5\u987B\u662F\u6570\u7EC4");
    manifest.artifacts = doc.artifacts.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) fail(source, `artifacts[${i}] \u5FC5\u987B\u662F\u5BF9\u8C61`);
      const a = entry;
      const sha256 = requireString(source, a.sha256, `artifacts[${i}].sha256`).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) fail(source, `artifacts[${i}].sha256 \u5FC5\u987B\u662F 64 \u4F4D\u5341\u516D\u8FDB\u5236`);
      const dest = requireString(source, a.dest, `artifacts[${i}].dest`);
      if (!dest.startsWith("~/") && !dest.startsWith("/")) fail(source, `artifacts[${i}].dest \u5FC5\u987B\u662F ~/ \u6216\u7EDD\u5BF9\u8DEF\u5F84`);
      return {
        id: requireString(source, a.id, `artifacts[${i}].id`),
        version: requireString(source, a.version, `artifacts[${i}].version`),
        url: requireString(source, a.url, `artifacts[${i}].url`),
        sha256,
        size: typeof a.size === "number" ? a.size : void 0,
        dest,
        mode: a.mode === void 0 ? void 0 : requireString(source, a.mode, `artifacts[${i}].mode`)
      };
    });
  }
  if (doc.extension !== void 0) {
    if (typeof doc.extension !== "object" || doc.extension === null) fail(source, "extension \u5FC5\u987B\u662F\u5BF9\u8C61");
    const e = doc.extension;
    const zip = requireString(source, e.zip, "extension.zip");
    if (!/^https:\/\//.test(zip) || !zip.endsWith(".zip")) fail(source, "extension.zip \u5FC5\u987B\u662F https .zip URL");
    manifest.extension = {
      apiVersion: typeof e.apiVersion === "number" ? e.apiVersion : fail(source, "extension.apiVersion \u5FC5\u987B\u662F\u6570\u5B57"),
      id: requireString(source, e.id, "extension.id"),
      zip,
      tag: e.tag === void 0 ? void 0 : requireString(source, e.tag, "extension.tag"),
      capabilities: Array.isArray(e.capabilities) ? e.capabilities.map((v) => requireString(source, v, "extension.capabilities[]")) : void 0,
      filesystem: Array.isArray(e.filesystem) ? e.filesystem.map((v) => requireString(source, v, "extension.filesystem[]")) : void 0
    };
  }
  if (doc.configSync !== void 0) {
    if (!Array.isArray(doc.configSync)) fail(source, "configSync \u5FC5\u987B\u662F\u6570\u7EC4");
    manifest.configSync = doc.configSync.map((v) => requireString(source, v, "configSync[]"));
  }
  if (doc.verify !== void 0) {
    if (!Array.isArray(doc.verify)) fail(source, "verify \u5FC5\u987B\u662F\u6570\u7EC4");
    manifest.verify = doc.verify.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) fail(source, `verify[${i}] \u5FC5\u987B\u662F\u5BF9\u8C61`);
      const v = entry;
      if (v.kind === "file") {
        const when = v.when === "directory" ? "directory" : void 0;
        return {
          kind: "file",
          path: requireString(source, v.path, `verify[${i}].path`),
          mode: v.mode === void 0 ? void 0 : requireString(source, v.mode, `verify[${i}].mode`),
          when
        };
      }
      if (v.kind === "engine-plugin-loaded") {
        return { kind: "engine-plugin-loaded", spec: requireString(source, v.spec, `verify[${i}].spec`) };
      }
      if (v.kind === "guest-installed") {
        return { kind: "guest-installed", id: requireString(source, v.id, `verify[${i}].id`) };
      }
      return fail(source, `verify[${i}].kind \u8BA4\u4E0D\u51FA\uFF08${String(v.kind)}\uFF09`);
    });
  }
  return manifest;
}
function tarBinary() {
  return process.platform === "win32" ? join8(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}
function readManifestFromDir(dir) {
  const file = join8(dir, "provision.json");
  if (!existsSync5(file)) throw new Error(`${dir}: \u6CA1\u6709 provision.json\uFF08\u7EC4\u4EF6\u5FC5\u987B\u81EA\u5E26\u5B89\u88C5\u5951\u7EA6\uFF09`);
  return parseComponentManifest(JSON.parse(readFileSync5(file, "utf8")), file);
}
function readManifestFromTarball(tarball) {
  let text;
  try {
    text = execFileSync(tarBinary(), ["-xOf", tarball, "package/provision.json"], { encoding: "utf8" });
  } catch {
    throw new Error(`${tarball}: \u5305\u91CC\u6CA1\u6709 package/provision.json`);
  }
  return parseComponentManifest(JSON.parse(text), `${tarball}:package/provision.json`);
}
function componentCacheDir() {
  const home = process.env.OCRC_HOME ?? join8(homedir3(), ".ocrc");
  return join8(home, "component-cache");
}
function sha256File(file) {
  return createHash4("sha256").update(readFileSync5(file)).digest("hex");
}
function packDirectory(dir) {
  const staging = join8(tmpdir(), `ocrc-component-${process.pid}-${Date.now()}`);
  const target = join8(staging, "package");
  mkdirSync7(target, { recursive: true });
  cpSync2(dir, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return name !== "node_modules" && name !== ".git" && name !== ".zcode";
    }
  });
  const out = `${staging}.tgz`;
  execFileSync(tarBinary(), ["-czf", out, "-C", staging, "package"]);
  rmSync4(staging, { recursive: true, force: true });
  return out;
}
function packNpmSpec(spec) {
  const dir = join8(tmpdir(), `ocrc-npm-${process.pid}-${Date.now()}`);
  mkdirSync7(dir, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["pack", spec, "--silent", "--pack-destination", dir], {
    stdio: ["ignore", "ignore", "pipe"],
    // Node 24 on Windows refuses to spawn .cmd files without a shell.
    shell: process.platform === "win32"
  });
  const tgz = readdirSync2(dir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack ${spec}: \u6CA1\u6709\u4EA7\u51FA tgz`);
  return join8(dir, tgz);
}
async function prepareComponent(source) {
  let tarball;
  let temporary;
  let directory;
  let manifest;
  if (existsSync5(source) && statSync4(source).isDirectory()) {
    directory = source;
    manifest = readManifestFromDir(source);
    tarball = packDirectory(source);
    temporary = tarball;
  } else if (existsSync5(source)) {
    manifest = readManifestFromTarball(source);
    tarball = source;
  } else {
    const packed = packNpmSpec(source);
    manifest = readManifestFromTarball(packed);
    tarball = packed;
    temporary = packed;
  }
  const cache = componentCacheDir();
  mkdirSync7(cache, { recursive: true });
  const cached = join8(cache, `${manifest.name}-${manifest.version}.tgz`);
  if (!existsSync5(cached) || sha256File(cached) !== sha256File(tarball)) {
    writeFileSync6(cached, readFileSync5(tarball), { mode: 420 });
  }
  if (temporary) rmSync4(temporary, { force: true });
  return { manifest, tarball: cached, sha256: sha256File(cached), directory };
}
function sourcesFromPins(pins, env = {}) {
  const out = [];
  for (const [name, pin] of Object.entries(pins.components ?? {})) {
    const envKey = `OCRC_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_PIN`;
    const override = env[envKey]?.trim();
    if (override) {
      out.push(override);
      continue;
    }
    if (pin.tarball) out.push(pin.tarball);
    else if (pin.spec) out.push(pin.spec);
    else if (pin.version) out.push(`${name}@${pin.version}`);
  }
  return out;
}
function defaultComponentSources(env = process.env) {
  const pinsFile = fileURLToPath(new URL("../../ops/components.json", import.meta.url));
  if (!existsSync5(pinsFile)) return [];
  let pins;
  try {
    pins = JSON.parse(readFileSync5(pinsFile, "utf8"));
  } catch {
    return [];
  }
  return sourcesFromPins(pins, env);
}
function componentRemoteDir(manifest) {
  return `$HOME/.ocrc/components/${manifest.name}`;
}
function pluginEntryFor(manifest, remoteHome, kind = manifest.enginePlugin?.kind ?? "package") {
  if (!manifest.enginePlugin) return void 0;
  return kind === "directory" ? `${remoteHome}/.ocrc/components/${manifest.name}/package` : manifest.enginePlugin.spec;
}
function buildComponentUnpackScript(manifest, tarballName) {
  const dir = componentRemoteDir(manifest);
  return [
    "set -e",
    `D="${dir}"`,
    `T="$D/${tarballName}"`,
    '[ -f "$T" ] || { echo "component tarball missing" >&2; exit 1; }',
    'rm -rf "$D.next" && mkdir -p "$D.next"',
    'tar xzf "$T" -C "$D.next"',
    '[ -f "$D.next/package/package.json" ] || { echo "component tree has no package.json" >&2; exit 1; }',
    'rm -rf "$D.bak"',
    'if [ -d "$D" ]; then mv "$D" "$D.bak"; fi',
    'mv "$D.next" "$D"',
    "echo component-unpacked"
  ].join("\n");
}
function buildArtifactProbeCommand(dest) {
  const f = dest.replace(/^~\//, "$HOME/");
  return `f="${f}"; if [ -f "$f" ]; then sha256sum "$f" | cut -d" " -f1; else echo MISSING; fi`;
}
function buildArtifactPushScript(dest, sha256, mode = "0644") {
  const f = dest.replace(/^~\//, "$HOME/");
  return [
    "set -e",
    `D="${dirname3(f)}"`,
    `F="${f}"`,
    'mkdir -p "$D"',
    'cat > "$F.part"',
    `echo "${sha256}  $F.part" | sha256sum -c - >/dev/null`,
    'if [ -f "$F" ]; then cp -p "$F" "$F.ocrc-bak" 2>/dev/null || true; fi',
    'mv "$F.part" "$F"',
    `chmod ${mode} "$F"`,
    `echo "${sha256}  $F" | sha256sum -c - >/dev/null`,
    "echo artifact-ok"
  ].join("\n");
}
function buildExtensionInstallScript(o) {
  const granted = o.capabilities.length > 0 ? o.capabilities.join(",") : "sessions";
  return [
    "set -e",
    'PW="${OPENCHAMBER_UI_PASSWORD:-}"',
    '[ -n "$PW" ] || { echo "no ui password in env" >&2; exit 1; }',
    "C=$(mktemp)",
    `trap 'rm -f "$C"' EXIT`,
    `curl -fsS -c "$C" -X POST "http://127.0.0.1:${o.port}/auth/session" -H 'Content-Type: application/json' --data-binary "{\\"password\\":\\"$PW\\"}" >/dev/null`,
    `curl -fsS -b "$C" -X POST "http://127.0.0.1:${o.port}/api/guests" -H 'Content-Type: application/json' --data-binary "{\\"path\\":\\"${o.zipPath}\\",\\"replace\\":true}" >/dev/null`,
    `curl -fsS -b "$C" -X PUT "http://127.0.0.1:${o.port}/api/guests/${o.id}/capabilities" -H 'Content-Type: application/json' --data-binary '{"granted":[${granted.split(",").map((c) => `"${c}"`).join(",")}]}' >/dev/null`,
    `curl -fsS -b "$C" "http://127.0.0.1:${o.port}/api/guests" | grep -q '"id":"${o.id}"'`,
    "echo extension-installed"
  ].join("\n");
}
async function remoteSha(target, dest) {
  const r = await sshRun(target, buildArtifactProbeCommand(dest), { timeoutMs: 3e4 });
  return (r.stdout.trim().split("\n").pop() ?? "").trim();
}
async function fetchArtifact(artifact) {
  const cache = join8(componentCacheDir(), "artifacts");
  mkdirSync7(cache, { recursive: true });
  const dest = join8(cache, `${artifact.id}-${artifact.version}`);
  if (existsSync5(dest) && sha256File(dest) === artifact.sha256) return dest;
  const buf = /^https?:/.test(artifact.url) ? await (async () => {
    const res = await proxyAwareFetch(artifact.url, 9e5);
    if (!res.ok || !res.body) throw new Error(`\u4E0B\u8F7D ${artifact.id} \u5931\u8D25\uFF1AHTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  })() : readFileSync5(artifact.url);
  if (artifact.size !== void 0 && buf.length !== artifact.size) {
    throw new Error(`${artifact.id} \u5927\u5C0F\u4E0D\u7B26\uFF1A\u671F\u671B ${artifact.size}\uFF0C\u6536\u5230 ${buf.length}`);
  }
  const actual = createHash4("sha256").update(buf).digest("hex");
  if (actual !== artifact.sha256) throw new Error(`${artifact.id} sha256 \u4E0D\u7B26\uFF1A\u671F\u671B ${artifact.sha256}\uFF0C\u6536\u5230 ${actual}`);
  writeFileSync6(dest, buf, { mode: 420 });
  return dest;
}
async function installPreparedComponent(target, component, opts) {
  const details = [];
  const plugins = [];
  const { manifest } = component;
  const dir = componentRemoteDir(manifest);
  const tarballName = `${manifest.name}-${manifest.version}.tgz`;
  mkdirSync7(componentCacheDir(), { recursive: true });
  const push = await pushFileOverSsh(target, component.tarball, [
    "set -e",
    `mkdir -p "${dir}"`,
    `cat > "${dir}/${tarballName}.part"`,
    `mv "${dir}/${tarballName}.part" "${dir}/${tarballName}"`,
    "echo tarball-ok"
  ].join("\n"), { timeoutMs: 3e5 });
  if (push.code !== 0) return { ok: false, details: [`${manifest.name}: \u63A8\u9001\u5B89\u88C5\u5305\u5931\u8D25\uFF08${push.stderr.trim() || `exit ${push.code}`}\uFF09`], plugins, extensionInstalled: false };
  const unpack = await sshRun(target, buildComponentUnpackScript(manifest, tarballName), { timeoutMs: 12e4 });
  if (unpack.code !== 0) return { ok: false, details: [`${manifest.name}: \u89E3\u5305\u5931\u8D25\uFF08${unpack.stderr.trim() || `exit ${unpack.code}`}\uFF09`], plugins, extensionInstalled: false };
  details.push(`${manifest.name} ${manifest.version} \u2192 ${dir}/package`);
  if (manifest.enginePlugin) {
    const spec = pluginEntryFor(manifest, opts.remoteHome, "directory");
    if (spec) {
      plugins.push(spec);
      details.push(`\u63D2\u4EF6\u6761\u76EE\uFF1A${spec}`);
    }
  }
  for (const artifact of manifest.artifacts ?? []) {
    const local = await fetchArtifact(artifact);
    const want = artifact.sha256;
    const have = await remoteSha(target, artifact.dest);
    if (have === want) {
      details.push(`${artifact.id} ${artifact.version} \u5DF2\u5728\u4F4D\uFF08sha256 \u547D\u4E2D\uFF09`);
      continue;
    }
    const pushed = await pushFileOverSsh(target, local, buildArtifactPushScript(artifact.dest, want, artifact.mode), { timeoutMs: 9e5 });
    if (pushed.code !== 0) {
      return { ok: false, details: [...details, `${artifact.id}: \u843D\u4F4D\u5931\u8D25\uFF08${pushed.stderr.trim() || `exit ${pushed.code}`}\uFF09`], plugins, extensionInstalled: false };
    }
    details.push(`${artifact.id} ${artifact.version} \u2192 ${artifact.dest}`);
  }
  let extensionInstalled = false;
  if (manifest.extension) {
    const ext = manifest.extension;
    const zipPath = `${dir}/${ext.id}.zip`;
    const envKey = `OCRC_EXTENSION_ZIP_${ext.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const source = process.env[envKey] ?? ext.zip;
    let buf;
    if (/^https?:/.test(source)) {
      const res = await proxyAwareFetch(source, 3e5);
      if (res.ok && res.body) buf = Buffer.from(await res.arrayBuffer());
      else details.push(`\u6269\u5C55 ${ext.id}\uFF1A\u4E0B\u8F7D\u5931\u8D25 HTTP ${res.status}\uFF08\u4E0D\u963B\u65AD\u5B9E\u4F8B\u542F\u52A8\uFF09`);
    } else {
      try {
        buf = readFileSync5(source);
      } catch {
        details.push(`\u6269\u5C55 ${ext.id}\uFF1A\u8BFB\u4E0D\u5230 ${source}\uFF08\u4E0D\u963B\u65AD\u5B9E\u4F8B\u542F\u52A8\uFF09`);
      }
    }
    if (buf) {
      if (buf.subarray(0, 2).toString() !== "PK") {
        details.push(`\u6269\u5C55 ${ext.id}\uFF1A\u62FF\u5230\u7684\u4E0D\u662F zip\uFF08\u4E0D\u963B\u65AD\u5B9E\u4F8B\u542F\u52A8\uFF09`);
      } else {
        const zipLocal = join8(componentCacheDir(), `${ext.id}-${manifest.version}.zip`);
        writeFileSync6(zipLocal, buf);
        const p = await pushFileOverSsh(target, zipLocal, [
          "set -e",
          `cat > "${zipPath}.part"`,
          `mv "${zipPath}.part" "${zipPath}"`,
          "echo zip-ok"
        ].join("\n"), { timeoutMs: 3e5 });
        if (p.code !== 0) {
          details.push(`\u6269\u5C55 ${ext.id}\uFF1A\u63A8\u9001\u5931\u8D25\uFF08\u4E0D\u963B\u65AD\u5B9E\u4F8B\u542F\u52A8\uFF09`);
        } else if (!opts.instanceRunning) {
          details.push(`\u6269\u5C55 ${ext.id}\uFF1A\u5305\u5DF2\u5C31\u4F4D\uFF08${zipPath}\uFF09\uFF0C\u5B9E\u4F8B\u672A\u8FD0\u884C\uFF0C\u542F\u52A8\u540E\u518D\u88C5`);
        } else {
          const cmd = buildExtensionInstallScript({
            port: opts.instancePort,
            zipPath,
            id: ext.id,
            capabilities: ext.capabilities ?? ["sessions"]
          });
          const install = await sshRunWithStdin(
            target,
            `export OPENCHAMBER_UI_PASSWORD=${JSON.stringify(opts.uiPassword ?? "")}
${cmd}`,
            "",
            { timeoutMs: 12e4 }
          );
          if (install.code === 0 && /extension-installed/.test(install.stdout)) {
            extensionInstalled = true;
            details.push(`\u6269\u5C55 ${ext.id} \u5DF2\u5B89\u88C5\u5E76\u6388\u6743\uFF1A${(ext.capabilities ?? ["sessions"]).join("+")}`);
          } else {
            details.push(`\u6269\u5C55 ${ext.id}\uFF1A\u5B89\u88C5\u672A\u5B8C\u6210\uFF08${(install.stderr || install.stdout).trim().split("\n").pop() || `exit ${install.code}`}\uFF1B\u4E0D\u963B\u65AD\u5B9E\u4F8B\u542F\u52A8\uFF09`);
          }
        }
      }
    }
  }
  return { ok: true, details, plugins, extensionInstalled };
}
async function registerPeerPlugins(target, specs, opts) {
  const log6 = opts.log ?? (() => {
  });
  const { parsePeerConfigRead: parsePeerConfigRead2 } = await Promise.resolve().then(() => (init_instance_config(), instance_config_exports));
  const read = await sshRun(target, opts.readScript, { timeoutMs: 45e3 });
  if (read.code !== 0) return { ok: false, detail: `\u8BFB\u53D6\u5BF9\u7AEF\u914D\u7F6E\u5931\u8D25\uFF1A${read.stderr.trim() || `exit ${read.code}`}` };
  const peer = parsePeerConfigRead2(read.stdout);
  const file = peer.targetBasename;
  const layer = peer.layers.find((l) => l.basename === file);
  const doc = layer ? JSON.parse(JSON.stringify(layer.parsed ?? {})) : { $schema: "https://opencode.ai/config.json" };
  const names = opts.componentNames ?? [];
  const stale = (entry) => names.some((name) => entry.includes(`@bd7pil/${name}`) || entry.includes(`/.ocrc/components/${name}/`));
  const current = Array.isArray(doc.plugins) ? doc.plugins.filter((v) => typeof v === "string" && !stale(v)) : [];
  const merged = [.../* @__PURE__ */ new Set([...current, ...specs])];
  if (merged.length === current.length && merged.every((v, i) => v === current[i])) {
    return { ok: true, detail: `plugins \u5DF2\u662F\u5E76\u96C6\uFF08${merged.length} \u6761\uFF09` };
  }
  doc.plugins = merged;
  const text = `${JSON.stringify(doc, null, 2)}
`;
  const path = `$HOME/.config/opencode/${file}`;
  const written2 = await sshRunWithStdin(
    target,
    [
      "set -e",
      `F="${path}"`,
      'mkdir -p "$(dirname "$F")"',
      'cat > "$F.part"',
      'if [ -f "$F" ]; then cp -p "$F" "$F.ocrc-bak"; fi',
      'mv "$F.part" "$F"',
      "echo config-ok"
    ].join("\n"),
    text,
    { timeoutMs: 45e3 }
  );
  if (written2.code !== 0) return { ok: false, detail: `\u5199\u5165 ${file} \u5931\u8D25\uFF1A${written2.stderr.trim() || `exit ${written2.code}`}` };
  log6(`\u5DF2\u767B\u8BB0 ${merged.length} \u4E2A\u63D2\u4EF6\uFF08${file}${file.endsWith(".jsonc") ? "\uFF0C\u6CE8\u91CA\u4F1A\u4E22\u5931\uFF0C\u65E7\u4EF6\u5728 .ocrc-bak" : ""}\uFF09`);
  return {
    ok: true,
    detail: layer ? `plugins \u5DF2\u5E76\u96C6\u5199\u5165 ${file}` : `\u5DF2\u521B\u5EFA ${file} \u5E76\u767B\u8BB0 ${merged.length} \u4E2A\u63D2\u4EF6`
  };
}

// ../../src/core/remote-instance-bridge.ts
init_config_merge();

// ../../src/core/forward-ownership.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync8, readFileSync as readFileSync6, readdirSync as readdirSync3, rmSync as rmSync5, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join9 } from "node:path";
function forwardMarkerDir(home = ocrcHome()) {
  return join9(home, "forwards");
}
function forwardMarkerPath(instanceId, kind, home = ocrcHome()) {
  const safe = instanceId.replace(/[^A-Za-z0-9._@-]/g, "-").replace(/^\.+/, "_") || "_";
  return join9(forwardMarkerDir(home), `${safe}.${kind}.json`);
}
function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function writeForwardMarker(marker, home = ocrcHome()) {
  try {
    mkdirSync8(forwardMarkerDir(home), { recursive: true });
    writeFileSync7(forwardMarkerPath(marker.instanceId, marker.kind, home), `${JSON.stringify(marker, null, 2)}
`);
  } catch {
  }
}
function clearForwardMarker(instanceId, kind, home = ocrcHome()) {
  try {
    rmSync5(forwardMarkerPath(instanceId, kind, home), { force: true });
  } catch {
  }
}
function readForwardMarker(instanceId, kind, home = ocrcHome()) {
  const path = forwardMarkerPath(instanceId, kind, home);
  if (!existsSync6(path)) return void 0;
  try {
    return JSON.parse(readFileSync6(path, "utf-8"));
  } catch {
    return void 0;
  }
}
function findHolder(instanceId, kind, home = ocrcHome()) {
  const marker = readForwardMarker(instanceId, kind, home);
  if (!marker) return { staleCleared: false };
  if (isAlive(marker.pid)) return { holder: marker, staleCleared: false };
  clearForwardMarker(instanceId, kind, home);
  return { staleCleared: true };
}
function describeHolders(instanceId, home = ocrcHome()) {
  const kinds = ["ui", "relay", "pair"];
  const lines = [];
  for (const kind of kinds) {
    const marker = readForwardMarker(instanceId, kind, home);
    if (!marker) continue;
    const alive = isAlive(marker.pid);
    lines.push(`${kind}: pid ${marker.pid}\uFF08${marker.owner}${marker.localPort ? `\uFF0C\u672C\u5730 :${marker.localPort}` : ""}${marker.remotePort ? `\uFF0C\u8FDC\u7A0B :${marker.remotePort}` : ""}\uFF09${alive ? "" : "\u2014\u2014\u8FDB\u7A0B\u5DF2\u4E0D\u5728\uFF08\u9648\u65E7\u6807\u8BB0\uFF09"}`);
  }
  return lines;
}

// ../../src/core/remote-instance-bridge.ts
var log5 = createLogger("remote-instance");
var EXTERNAL_MONITOR_MS = 2e4;
var LOG_CAP = 200;
var EGRESS_TTL_MS = 5 * 6e4;
function proxyConfig(instance) {
  return {
    enabled: instance.proxy?.enabled ?? PROXY_DEFAULTS.enabled,
    localPort: instance.proxy?.localPort && instance.proxy.localPort > 0 ? instance.proxy.localPort : PROXY_DEFAULTS.localPort,
    remotePort: instance.proxy?.remotePort && instance.proxy.remotePort > 0 ? instance.proxy.remotePort : PROXY_DEFAULTS.remotePort,
    allow: instance.proxy?.allow ?? []
  };
}
function isListening(port) {
  return new Promise((resolve) => {
    const srv = net2.connect(port, "127.0.0.1");
    const done = (v) => {
      srv.destroy();
      resolve(v);
    };
    srv.once("connect", () => done(true));
    srv.once("error", () => done(false));
    srv.setTimeout(1e3, () => done(false));
  });
}
function cleanSshNoise(text) {
  return (text ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => !/^\*\* WARNING: connection is not using/.test(l)).filter((l) => !/^\*\* This session may be vulnerable/.test(l)).filter((l) => !/^\*\* The server may need to be upgraded/.test(l)).filter((l) => !/^Warning: Permanently added /.test(l)).join("\n");
}
function buildInstanceEnvProbeCommand() {
  return [
    'echo "UNAME=$(uname -s -m 2>/dev/null)"',
    'echo "LDD=$(ldd --version 2>/dev/null | head -1)"',
    'echo "HOME=$HOME"'
  ].join("; ");
}
function buildRemoteHealthCommand(appVersion, port) {
  const node = instancePaths(appVersion).node;
  const js = `const h=require('http');const r=h.get({host:'127.0.0.1',port:${port},path:'/health',timeout:3000},s=>{console.log(s.statusCode);process.exit(0)});r.on('error',()=>{console.log('000');process.exit(0)});r.on('timeout',()=>{console.log('000');r.destroy();process.exit(0)})`;
  return `if [ -x ${node} ]; then ${node} -e "${js}"; else echo 000; fi`;
}
function parseEnvProbe(out) {
  const kv = /* @__PURE__ */ new Map();
  for (const line of (out ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return {
    uname: kv.get("UNAME") || void 0,
    glibc: parseGlibcVersion(kv.get("LDD")),
    home: kv.get("HOME") || void 0
  };
}
function ownerRoleFor(detachedForwards) {
  return detachedForwards ? "cli" : "service";
}
function instanceUrl(localPort) {
  return `http://127.0.0.1:${localPort}`;
}
function sshFields(instance) {
  return {
    host: instance.host,
    port: instance.port,
    user: instance.user,
    sshAuth: instance.sshAuth,
    sshPassword: instance.sshPassword
  };
}
function createRemoteInstanceManager(opts) {
  const runtimes = /* @__PURE__ */ new Map();
  const detachedForwards = opts.forwards === "detached";
  const externalTunnel = opts.tunnelOwner === "external";
  const forwardLogPath = opts.forwardLogPath ?? join10(opts.home ?? ocrcHome(), "remote-forward.log");
  const passthroughNames = opts.envPassthrough ?? (process.env.OCRC_INSTANCE_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const passthroughEnv = () => {
    const out = {};
    for (const name of passthroughNames) {
      const value = process.env[name];
      if (value !== void 0 && value !== "") out[name] = value;
    }
    return out;
  };
  const rt = (id) => {
    let r = runtimes.get(id);
    if (!r) {
      r = { state: "unknown", logs: [], forwardAttempts: 0, stopping: false };
      runtimes.set(id, r);
    }
    return r;
  };
  const pushLog = (id, line) => {
    const clean = cleanSshNoise(line).trim();
    if (!clean) return;
    const r = rt(id);
    for (const one of clean.split("\n")) if (one.trim()) r.logs.push(one.trim());
    if (r.logs.length > LOG_CAP) r.logs.splice(0, r.logs.length - LOG_CAP);
  };
  const setState = (id, state, detail) => {
    const r = rt(id);
    r.state = state;
    r.detail = detail;
    r.since = Date.now();
    log5.info(`instance ${id}: ${state}${detail ? ` \u2014 ${detail}` : ""}`);
  };
  const need = (id) => {
    const instance = opts.store.get(id);
    if (!instance) throw new Error(`unknown remote instance ${id}`);
    return instance;
  };
  const ssh = (instance, command, timeoutMs = 6e4) => sshRun(instance, command, { timeoutMs });
  const ownerRole = ownerRoleFor(detachedForwards);
  function holderOf(instance, kind) {
    const lookup = findHolder(instance.id, kind, opts.home);
    if (lookup.staleCleared) pushLog(instance.id, `${kind} \u7684\u6301\u6709\u8005\u6807\u8BB0\u662F\u9648\u65E7\u7684\uFF08\u8FDB\u7A0B\u5DF2\u4E0D\u5728\uFF09\uFF0C\u5DF2\u6E05\u7406`);
    return lookup.holder;
  }
  function markForward(instance, kind, child, ports) {
    if (!child.pid) return;
    writeForwardMarker({
      instanceId: instance.id,
      kind,
      pid: child.pid,
      owner: ownerRole,
      localPort: ports.localPort,
      remotePort: ports.remotePort,
      startedAt: Date.now(),
      host: instance.host
    }, opts.home);
  }
  function pipeTarToSsh(instance, dir, script, timeoutMs = 12e4) {
    return new Promise((resolve) => {
      const tar = spawn3("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "pipe"] });
      const remote = spawn3("ssh", buildSshExecArgs(instance, script), {
        stdio: ["pipe", "pipe", "pipe"],
        env: askpassEnv(instance)
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          remote.kill("SIGKILL");
        } catch {
        }
        try {
          tar.kill("SIGKILL");
        } catch {
        }
        done({ code: null, stdout, stderr: `${stderr}
timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      remote.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      remote.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      remote.on("error", (err) => done({ code: null, stdout, stderr: `${stderr}
${err.message}` }));
      remote.on("close", (code) => done({ code, stdout, stderr }));
      remote.stdin?.on("error", () => {
      });
      tar.on("error", (err) => {
        try {
          remote.kill();
        } catch {
        }
        done({ code: null, stdout, stderr: `${stderr}
tar: ${err.message}` });
      });
      tar.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      tar.stdout?.pipe(remote.stdin);
    });
  }
  async function probeEnv(instance) {
    const r = await ssh(instance, buildInstanceEnvProbeCommand(), 25e3);
    if (r.code !== 0) return void 0;
    return parseEnvProbe(r.stdout);
  }
  async function resolveEngine(instance) {
    const candidates = instance.enginePath ? [instance.enginePath] : DEFAULT_ENGINE_CANDIDATES;
    const r = await ssh(instance, buildEngineProbeCommand(candidates), 45e3);
    const parsed = parseEngineProbe(r.stdout);
    const pick = pickV2Engine(parsed);
    if (!pick.ok && instance.enginePath) {
      return {
        ok: false,
        seen: parsed,
        error: `pin \u7684 OpenCode \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF1A${parsed.map((c) => `${c.path} \u2192 ${c.raw || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"}`).join("\uFF1B") || instance.enginePath}`
      };
    }
    return pick;
  }
  async function remoteHealth(instance) {
    const r = await ssh(instance, buildRemoteHealthCommand(instance.appVersion, instance.instancePort), 2e4);
    return (r.stdout ?? "").trim().split("\n").pop()?.trim() || "000";
  }
  async function waitHealthy(instance, timeoutMs = 45e3) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await remoteHealth(instance) === "200") return true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }
  async function startInstance(instance, enginePath, guard = false) {
    const prefix = guard ? buildOfflineGuardExports() : opts.serveEnvPrefix?.(instance) ?? "";
    const relay = (await egressFor(instance)).relay ? relayProxyUrl(proxyConfig(instance).remotePort) : void 0;
    const script = `${prefix}${buildInstanceServeCommand({
      appVersion: instance.appVersion,
      port: instance.instancePort,
      uiPassword: instance.uiPassword,
      enginePath,
      proxy: relay ? { httpProxy: relay, httpsProxy: relay } : void 0,
      extraEnv: passthroughEnv(),
      detached: true
    })}`;
    pushLog(instance.id, `$ instance serve :${instance.instancePort}\uFF08engine ${enginePath}\uFF09`);
    const r = await ssh(instance, script, 6e4);
    if (r.code !== 0) return { ok: false, detail: `\u542F\u52A8\u5B9E\u4F8B\u5931\u8D25\uFF1A${cleanSshNoise(r.stderr || r.stdout).trim().split("\n").pop() ?? `exit ${r.code}`}` };
    if (!await waitHealthy(instance)) {
      const tail = await tailRemoteLog(instance);
      return { ok: false, detail: `\u5B9E\u4F8B\u542F\u52A8\u540E /health \u672A\u5C31\u7EEA${tail ? `\uFF1B\u8FDC\u7AEF\u65E5\u5FD7\u5C3E\uFF1A${tail}` : ""}` };
    }
    return { ok: true, detail: `\u5B9E\u4F8B\u5728 :${instance.instancePort} \u5C31\u7EEA` };
  }
  async function tailRemoteLog(instance) {
    const p = instancePaths(instance.appVersion);
    const r = await ssh(instance, `tail -n 5 ${p.log} 2>/dev/null || true`, 15e3);
    return cleanSshNoise(r.stdout).split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
  }
  async function probeInstanceProxy(instance) {
    const r = await ssh(instance, buildInstanceProxyProbeCommand(instance.appVersion, instance.instancePort), 25e3);
    if (r.code !== 0 && !r.stdout.trim()) return "unknown";
    return parseInstanceProxyProbe(r.stdout);
  }
  async function stopInstance(instance) {
    const r = await ssh(instance, buildInstanceStopCommand(instance.appVersion, instance.instancePort), 45e3);
    const code = await remoteHealth(instance) === "200";
    if (code) return { ok: false, detail: `\u5B9E\u4F8B\u4ECD\u5728 :${instance.instancePort} \u4E0A\u54CD\u5E94\uFF08stop \u672A\u751F\u6548\uFF09` };
    pushLog(instance.id, `$ instance stop :${instance.instancePort}`);
    return { ok: true, detail: r.stdout.trim().split("\n").pop() || "\u5DF2\u505C" };
  }
  async function installComponents(instance, sources, onLog) {
    const log6 = (line) => {
      pushLog(instance.id, line);
      onLog?.(line);
    };
    const prepared = [];
    for (const source of sources) {
      log6(`\u7EC4\u4EF6\uFF1A\u51C6\u5907 ${source}`);
      prepared.push(await prepareComponent(source));
    }
    const home = (await ssh(instance, 'printf %s "$HOME"', 2e4)).stdout.trim();
    if (!home) return { ok: false, details: ["\u8BFB\u4E0D\u5230\u5BF9\u7AEF\u7684 $HOME"], plugins: [] };
    const running = await remoteHealth(instance) === "200";
    const details = [];
    const plugins = [];
    let ok = true;
    let extensionInstalled = false;
    for (const component of prepared) {
      log6(`\u7EC4\u4EF6\uFF1A\u5B89\u88C5 ${component.manifest.name} ${component.manifest.version}`);
      const result = await installPreparedComponent(instance, component, {
        log: log6,
        uiPassword: instance.uiPassword,
        instancePort: instance.instancePort,
        remoteHome: home,
        instanceRunning: running
      });
      details.push(...result.details);
      plugins.push(...result.plugins);
      extensionInstalled = extensionInstalled || result.extensionInstalled;
      if (!result.ok) ok = false;
    }
    if (plugins.length > 0) {
      const registered = await registerPeerPlugins(instance, plugins, {
        readScript: buildPeerConfigReadScript(),
        log: log6,
        componentNames: prepared.map((c) => c.manifest.name)
      });
      details.push(registered.detail);
      if (!registered.ok) ok = false;
    }
    for (const component of prepared) {
      for (const check of component.manifest.verify ?? []) {
        if (check.kind === "file") {
          if (check.when === "directory" && component.manifest.enginePlugin?.kind !== "directory") continue;
          const path = check.path.replace(/^~\//, "$HOME/");
          const mode = check.mode ? `stat -c %a "$f"` : "echo PRESENT";
          const r = await ssh(instance, `f="${path}"; if [ ! -f "$f" ]; then echo MISSING; else ${mode}; fi`, 3e4);
          const out = r.stdout.trim().split("\n").pop() ?? "";
          if (out === "MISSING") {
            details.push(`\u9A8C\u8BC1\u5931\u8D25\uFF1A${check.path} \u4E0D\u5B58\u5728`);
            ok = false;
          } else if (check.mode && out.replace(/^0+/, "") !== check.mode.replace(/^0+/, "")) {
            details.push(`\u9A8C\u8BC1\u5931\u8D25\uFF1A${check.path} \u6A21\u5F0F ${out} \u2260 ${check.mode}`);
            ok = false;
          } else {
            details.push(`\u9A8C\u8BC1\u901A\u8FC7\uFF1A${check.path}`);
          }
        } else if (check.kind === "engine-plugin-loaded") {
          const dir = `$HOME/.ocrc/components/${component.manifest.name}/package`;
          const r = await ssh(instance, `test -f "${dir}/package.json" && { test -e "${dir}/index.js" || test -e "${dir}/server.js"; } && echo ok`, 3e4);
          if (!/ok/.test(r.stdout)) {
            details.push(`\u9A8C\u8BC1\u5931\u8D25\uFF1A${component.manifest.name} \u7684\u63D2\u4EF6\u6811\u4E0D\u5728 ${dir}`);
            ok = false;
          } else {
            details.push(`\u9A8C\u8BC1\u901A\u8FC7\uFF1A${component.manifest.name} \u63D2\u4EF6\u6811\u5DF2\u5C31\u4F4D`);
          }
        } else if (check.kind === "guest-installed") {
          details.push(extensionInstalled ? `\u9A8C\u8BC1\u901A\u8FC7\uFF1A\u6269\u5C55 ${check.id} \u5DF2\u5B89\u88C5` : `\u6CE8\u610F\uFF1A\u6269\u5C55 ${check.id} \u672A\u786E\u8BA4\u5B89\u88C5\uFF08\u4E0D\u963B\u65AD\u5B9E\u4F8B\u542F\u52A8\uFF09`);
        }
      }
    }
    return { ok, details, plugins };
  }
  async function installComponentsIfRequested(instance, applyOpts) {
    const sources = [
      ...applyOpts.components ?? [],
      ...applyOpts.componentsFromPins ? defaultComponentSources() : []
    ];
    if (sources.length === 0) return void 0;
    return installComponents(instance, sources, applyOpts.onLog);
  }
  async function componentPluginsFor(instance, sources) {
    if (!sources || sources.length === 0) return { plugins: [], names: [] };
    const home = (await ssh(instance, 'printf %s "$HOME"', 2e4)).stdout.trim();
    if (!home) throw new Error("\u8BFB\u4E0D\u5230\u5BF9\u7AEF\u7684 $HOME");
    const plugins = [];
    const names = [];
    for (const source of sources) {
      const prepared = await prepareComponent(source);
      const entry = pluginEntryFor(prepared.manifest, home, "directory");
      if (entry) plugins.push(entry);
      names.push(prepared.manifest.name);
    }
    return { plugins, names };
  }
  const proxies = /* @__PURE__ */ new Map();
  async function egressFor(instance) {
    const r = rt(instance.id);
    if (r.egress && Date.now() - r.egress.at < EGRESS_TTL_MS) return r.egress;
    const mode = instance.egress;
    let probe;
    if (mode !== "relay" && mode !== "direct") {
      const out = await ssh(instance, buildEgressProbeCommand({ appVersion: instance.appVersion }), 3e4);
      probe = parseEgressProbe(out.stdout);
    }
    const decision = resolveEgressPolicy({ mode, relayAllowed: proxyConfig(instance).enabled, probe });
    r.egress = { ...decision, probe, at: Date.now() };
    pushLog(instance.id, `\u8054\u7F51\u65B9\u5F0F\uFF1A${decision.relay ? "\u7ECF\u672C\u673A\u8F6C\u53D1" : "\u76F4\u8FDE"}\uFF08${decision.reason}\uFF09`);
    return r.egress;
  }
  function egressView(instance) {
    const mode = instance.egress ?? EGRESS_DEFAULT;
    const cached = rt(instance.id).egress;
    if (!cached) return { mode, relay: false, reason: "\u5C1A\u672A\u63A2\u6D4B\uFF08\u8DD1\u4E00\u6B21\u68C0\u67E5\u6216\u542F\u52A8\u5C31\u4F1A\u51B3\u5B9A\uFF09", cached: false };
    return { mode, relay: cached.relay, reason: cached.reason, probe: cached.probe, cached: true };
  }
  async function ensureProxy(instance) {
    const cfg = proxyConfig(instance);
    if (!cfg.enabled) return "off";
    if (!(await egressFor(instance)).relay) return "off";
    if (proxies.has(cfg.localPort)) return "in-process";
    if (await isListening(cfg.localPort)) {
      pushLog(instance.id, `\u51FA\u7F51\u8F6C\u53D1\u5DF2\u5728 :${cfg.localPort} \u4E0A\u76D1\u542C\uFF08\u5916\u90E8\u8FDB\u7A0B\uFF0C\u590D\u7528\uFF09`);
      return "external";
    }
    try {
      const proxy = await createInstanceProxy({
        port: cfg.localPort,
        allow: cfg.allow,
        onLog: (line) => pushLog(instance.id, `relay: ${line}`)
      });
      proxies.set(cfg.localPort, proxy);
      pushLog(instance.id, `\u51FA\u7F51\u8F6C\u53D1\u8D77\u5728 127.0.0.1:${cfg.localPort}\uFF08\u8FDC\u7A0B\u673A\u5668\u7ECF ssh -R 127.0.0.1:${cfg.remotePort} \u8FDB\u6765\u5230\u8FD9\uFF09`);
      return "in-process";
    } catch (err) {
      pushLog(instance.id, `\u51FA\u7F51\u8F6C\u53D1\u8D77\u4E0D\u6765\uFF1A${err.message}`);
      return "off";
    }
  }
  function stopForward(id) {
    const r = rt(id);
    if (r.forwardTimer) {
      clearTimeout(r.forwardTimer);
      r.forwardTimer = void 0;
    }
    const child = r.forward;
    r.forward = void 0;
    r.forwardPid = void 0;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
      }
    }
    clearForwardMarker(id, "ui", opts.home);
    clearForwardMarker(id, "relay", opts.home);
  }
  function stopPairForward(id) {
    const child = rt(id).pairForward;
    rt(id).pairForward = void 0;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
      }
    }
    clearForwardMarker(id, "pair", opts.home);
  }
  function startExternalMonitor(id) {
    if (!externalTunnel) return;
    const r = rt(id);
    if (r.monitorTimer) return;
    const tick = async () => {
      const here = rt(id);
      if (here.stopping) return;
      try {
        opts.store.reload();
      } catch {
      }
      const fresh = opts.store.get(id);
      if (!fresh || fresh.enabled === false) return;
      const health = await remoteHealth(fresh);
      if (health !== "200") {
        if (fresh.reconnect === false) {
          setState(id, "offline", "\u8FDC\u7A0B\u5B9E\u4F8B\u672A\u54CD\u5E94\uFF08reconnect \u5173\uFF0C\u4E0D\u81EA\u52A8\u91CD\u542F\uFF09");
          return;
        }
        const pick = await resolveEngine(fresh);
        if (!pick.ok) {
          setState(id, "error", `OpenCode \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF1A${pick.error}`);
          return;
        }
        const relay = await ensureProxy(fresh);
        if (relay !== "off") pushLog(id, `\u51FA\u7F51\u8F6C\u53D1\uFF1A${relay}`);
        await ensureExternalRelayAsync(fresh);
        const started = await startInstance(fresh, pick.candidate.path);
        setState(id, started.ok ? "online" : "error", started.ok ? `\u5B9E\u4F8B\u5DF2\u91CD\u65B0\u62C9\u8D77\uFF08${instanceUrl(fresh.localPort)}\uFF09` : started.detail);
        if (started.ok) pushLog(id, started.detail);
        return;
      }
      await ensureExternalRelayAsync(fresh);
      if (here.state !== "online") setState(id, "online", "\u8FDC\u7A0B\u5B9E\u4F8B\u5DF2\u5C31\u7EEA\uFF08\u8F6C\u53D1\u7531\u684C\u9762\u5E94\u7528\u6301\u6709\uFF09");
    };
    const timer = setInterval(() => {
      void tick().catch(() => {
      });
    }, EXTERNAL_MONITOR_MS);
    timer.unref?.();
    r.monitorTimer = timer;
  }
  function stopExternalMonitor(id) {
    const r = runtimes.get(id);
    if (r?.monitorTimer) {
      clearInterval(r.monitorTimer);
      r.monitorTimer = void 0;
    }
  }
  async function remoteRelayPresent(instance) {
    const cfg = proxyConfig(instance);
    if (!cfg.enabled) return false;
    const probe = await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, cfg.remotePort), 2e4);
    return probe.stdout.trim().endsWith("open");
  }
  function ensureForward(instance) {
    void ensureForwardAsync(instance);
  }
  async function ensureForwardAsync(instance) {
    if (externalTunnel) return;
    const r = rt(instance.id);
    if (r.forward && r.forward.exitCode === null) return;
    if (r.relayPending) return;
    const uiHolder = holderOf(instance, "ui");
    if (uiHolder) {
      pushLog(instance.id, `\u672C\u5730 :${uiHolder.localPort ?? instance.localPort} \u7531\u53E6\u4E00\u4E2A\u6301\u6709\u8005\u5360\u7740\uFF08pid ${uiHolder.pid}\uFF0C${uiHolder.owner}\uFF09\u2014\u2014\u672C\u8FDB\u7A0B\u4E0D\u518D\u8D77 -L\uFF0C\u6309 external \u65B9\u5F0F\u5BF9\u5F85`);
      setState(instance.id, "online", `\u8F6C\u53D1\u7531\u53E6\u4E00\u4E2A\u6301\u6709\u8005\uFF08pid ${uiHolder.pid}\uFF0C${uiHolder.owner}\uFF09\u6301\u6709`);
      return;
    }
    const cfg = proxyConfig(instance);
    r.relayPending = true;
    let adopted = false;
    try {
      adopted = await remoteRelayPresent(instance);
    } finally {
      r.relayPending = false;
    }
    if (adopted) pushLog(instance.id, `\u8FDC\u7AEF ${cfg.remotePort} \u5DF2\u5728\u76D1\u542C\u2014\u2014\u4E3B\u96A7\u9053\u4E0D\u5E26 -R\uFF08\u590D\u7528\u65E2\u6709\u51FA\u7F51\u8F6C\u53D1\uFF09`);
    const reverse = cfg.enabled && !adopted ? { remotePort: cfg.remotePort, localPort: cfg.localPort } : void 0;
    const args = buildForwardArgs({
      ...sshFields(instance),
      localPort: instance.localPort,
      remotePort: instance.instancePort,
      reverse
    });
    pushLog(instance.id, `$ ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort}${reverse ? ` -R 127.0.0.1:${reverse.remotePort}:127.0.0.1:${reverse.localPort}` : ""} ${instance.user ? `${instance.user}@` : ""}${instance.host}`);
    const child = detachedForwards ? spawn3("ssh", args, { stdio: ["ignore", "ignore", openSync(forwardLogPath, "a")], detached: true, env: askpassEnv(instance) }) : spawn3("ssh", args, { stdio: ["ignore", "pipe", "pipe"], env: askpassEnv(instance) });
    r.forward = child;
    r.forwardPid = child.pid;
    markForward(instance, "ui", child, { localPort: instance.localPort, remotePort: reverse ? reverse.remotePort : void 0 });
    if (detachedForwards) {
      child.unref();
      pushLog(instance.id, `\u96A7\u9053\u4EE5 detached \u65B9\u5F0F\u8D77\uFF08stderr \u2192 ${forwardLogPath}\uFF09\uFF0C\u672C\u8FDB\u7A0B\u9000\u51FA\u540E\u7EE7\u7EED\u6D3B\u7740`);
      return;
    }
    child.stdout?.on("data", (d) => pushLog(instance.id, d.toString()));
    child.stderr?.on("data", (d) => pushLog(instance.id, d.toString()));
    child.on("error", (err) => {
      pushLog(instance.id, `ssh: ${err.message}`);
      setState(instance.id, "error", `\u8F6C\u53D1\u8FDB\u7A0B\u8D77\u4E0D\u6765\uFF1A${err.message}`);
    });
    child.on("exit", (code) => {
      const current = rt(instance.id);
      if (current.forward === child) {
        current.forward = void 0;
        current.forwardPid = void 0;
      }
      if (current.stopping) return;
      if (code === 0) {
        setState(instance.id, "offline", "\u8F6C\u53D1\u5DF2\u9000\u51FA");
        return;
      }
      try {
        opts.store.reload();
      } catch {
      }
      const fresh = opts.store.get(instance.id);
      if (!fresh?.enabled || fresh.reconnect === false) {
        setState(instance.id, "offline", `\u8F6C\u53D1\u9000\u51FA\uFF08reconnect \u5173\uFF09\uFF1Aexit ${code}`);
        return;
      }
      current.forwardAttempts += 1;
      const delay = nextRetryDelay(current.forwardAttempts);
      setState(instance.id, "offline", `\u8F6C\u53D1\u65AD\u5F00\uFF0C${Math.round(delay / 1e3)}s \u540E\u91CD\u8FDE\uFF08\u7B2C ${current.forwardAttempts} \u6B21\uFF09`);
      current.forwardTimer = setTimeout(() => {
        current.forwardTimer = void 0;
        const again = opts.store.get(instance.id);
        if (!again || again.enabled === false || again.reconnect === false || current.stopping) return;
        void resumeForward(again);
      }, delay);
      current.forwardTimer.unref?.();
    });
  }
  async function resumeForward(instance) {
    await ensureForwardAsync(instance);
    await new Promise((r) => setTimeout(r, 800));
    const probe = await probeThroughForward(instance);
    if (probe.ok) {
      setState(instance.id, "online", `\u8F6C\u53D1\u5DF2\u6062\u590D\uFF08${probe.version}\uFF09`);
      rt(instance.id).forwardAttempts = 0;
    } else {
      pushLog(instance.id, `\u91CD\u8FDE\u540E\u63A2\u6D3B\u5931\u8D25\uFF1A${probe.error}`);
    }
  }
  async function probeThroughForward(instance) {
    try {
      const res = await fetch(`${instanceUrl(instance.localPort)}/api/version`, { signal: AbortSignal.timeout(5e3) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const payload = await res.json();
      return judgeInstanceVersion(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  async function freeLocalPort() {
    return await new Promise((resolve, reject) => {
      const srv = net2.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => port > 0 ? resolve(port) : reject(new Error("no free loopback port")));
      });
    });
  }
  async function withTempForward(instance, fn) {
    const port = await freeLocalPort();
    const temp = { ...instance, localPort: port };
    const args = buildForwardArgs({
      ...sshFields(instance),
      localPort: port,
      remotePort: instance.instancePort
    });
    const child = spawn3("ssh", args, { stdio: ["ignore", "ignore", "pipe"], env: askpassEnv(instance) });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const deadline = Date.now() + 8e3;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`\u4E34\u65F6\u8F6C\u53D1\u8D77\u4E0D\u6765\uFF1A${cleanSshNoise(stderr).trim() || `exit ${child.exitCode}`}`);
      }
      if (await isListening(port)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!await isListening(port)) {
      try {
        child.kill();
      } catch {
      }
      throw new Error("\u4E34\u65F6\u8F6C\u53D1\u672A\u5728 8s \u5185\u76D1\u542C");
    }
    try {
      return await fn(temp);
    } finally {
      try {
        child.kill();
      } catch {
      }
    }
  }
  async function ensurePairingForwardAsync(instance) {
    if ((await probeThroughForward(instance)).ok) return true;
    const r = rt(instance.id);
    const pairHolder = holderOf(instance, "pair");
    if (pairHolder) pushLog(instance.id, `\u914D\u5BF9\u7528\u7684 -L \u7531\u53E6\u4E00\u4E2A\u6301\u6709\u8005\u5360\u7740\uFF08pid ${pairHolder.pid}\uFF0C${pairHolder.owner}\uFF09\u2014\u2014\u7B49\u5B83\u901A\uFF0C\u4E0D\u62A2\u7AEF\u53E3`);
    if (!pairHolder && !(r.pairForward && r.pairForward.exitCode === null)) {
      const args = buildForwardArgs({
        ...sshFields(instance),
        localPort: instance.localPort,
        remotePort: instance.instancePort
      });
      pushLog(instance.id, `$ ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort} ${instance.user ? `${instance.user}@` : ""}${instance.host}`);
      const child = spawn3("ssh", args, { stdio: ["ignore", "ignore", openSync(forwardLogPath, "a")], detached: true, env: askpassEnv(instance) });
      child.unref();
      r.pairForward = child;
      markForward(instance, "pair", child, { localPort: instance.localPort });
    }
    const deadline = Date.now() + 1e4;
    while (Date.now() < deadline) {
      if ((await probeThroughForward(instance)).ok) return true;
      if (r.pairForward && r.pairForward.exitCode !== null) return false;
      await new Promise((res) => setTimeout(res, 250));
    }
    return (await probeThroughForward(instance)).ok;
  }
  async function pairLink(id) {
    const instance = opts.store.get(id);
    if (!instance) return { ok: false, detail: `\u6CA1\u6709\u8FD9\u4E2A\u5B9E\u4F8B\uFF1A${id}` };
    const forwarded = await ensurePairingForwardAsync(instance);
    if (!forwarded) {
      return { ok: false, detail: `\u672C\u5730\u8F6C\u53D1 127.0.0.1:${instance.localPort} \u8D77\u4E0D\u6765\u6216\u8FDC\u7A0B\u673A\u5668\u4E0D\u53EF\u8FBE\u2014\u2014\u5148\u542F\u52A8\u5B9E\u4F8B\uFF08\u914D\u5BF9\u94FE\u63A5\u8981\u6C42\u5B83\u5728\u8DD1\uFF09` };
    }
    await ensureExternalRelayAsync(instance);
    startExternalMonitor(id);
    const url = instanceUrl(instance.localPort);
    const r = await ssh(instance, buildPairLinkCommand({
      appVersion: instance.appVersion,
      instancePort: instance.instancePort,
      serverUrl: url,
      label: instance.name?.trim() || instance.id
    }), 45e3);
    const link = parsePairLink(r.stdout);
    if (!link) {
      return { ok: false, detail: `\u8FDC\u7A0B\u673A\u5668\u6CA1\u7ED9\u51FA\u914D\u5BF9\u94FE\u63A5\uFF1A${(r.stdout + r.stderr).replace(/\s+/g, " ").slice(-200)}` };
    }
    const info = describePairLink(link);
    pushLog(id, `\u914D\u5BF9\u94FE\u63A5\u5DF2\u751F\u6210\uFF08\u4E00\u6B21\u6027${info?.expiresAt ? `\uFF0C${info.expiresAt} \u8FC7\u671F` : ""}\uFF0C${info?.candidates ?? 0} \u6761\u8DEF\u7531\uFF09`);
    return { ok: true, detail: "\u914D\u5BF9\u94FE\u63A5\u5DF2\u751F\u6210\u2014\u2014\u5728\u684C\u9762\u7248\u91CC\u6253\u5F00\u5B83\uFF0C\u6216\u590D\u5236\u5230\u300C\u5BFC\u5165\u94FE\u63A5\u300D", link, ...info?.expiresAt ? { expiresAt: info.expiresAt } : {}, url };
  }
  function ensureExternalRelay(instance) {
    void ensureExternalRelayAsync(instance);
  }
  async function ensureExternalRelayAsync(instance) {
    const cfg = proxyConfig(instance);
    if (!cfg.enabled) return;
    if (!(await egressFor(instance)).relay) return;
    const r = rt(instance.id);
    if (r.forward && r.forward.exitCode === null) return;
    const relayHolder = holderOf(instance, "relay");
    if (relayHolder) {
      pushLog(instance.id, `\u51FA\u7F51\u817F\u7531\u53E6\u4E00\u4E2A\u6301\u6709\u8005\u5360\u7740\uFF08pid ${relayHolder.pid}\uFF0C${relayHolder.owner}\uFF09\u2014\u2014\u590D\u7528\uFF0C\u4E0D\u518D\u8D77 -R`);
      return;
    }
    if (r.relayPending) return;
    r.relayPending = true;
    try {
      if (await remoteRelayPresent(instance)) {
        pushLog(instance.id, `\u8FDC\u7AEF ${cfg.remotePort} \u5DF2\u5728\u76D1\u542C\uFF08\u51FA\u7F51\u8F6C\u53D1\u7531\u65E2\u6709\u96A7\u9053\u63D0\u4F9B\uFF0C\u590D\u7528\uFF09`);
        return;
      }
    } finally {
      r.relayPending = false;
    }
    const args = buildRelayForwardArgs({
      ...sshFields(instance),
      localPort: cfg.localPort,
      remotePort: instance.instancePort,
      reverse: { remotePort: cfg.remotePort, localPort: cfg.localPort }
    });
    pushLog(instance.id, `$ ssh -N -R 127.0.0.1:${cfg.remotePort}:127.0.0.1:${cfg.localPort} ${instance.user ? `${instance.user}@` : ""}${instance.host}`);
    const child = spawn3("ssh", args, { stdio: ["ignore", "pipe", "pipe"], env: askpassEnv(instance) });
    r.forward = child;
    r.forwardPid = child.pid;
    markForward(instance, "relay", child, { localPort: cfg.localPort, remotePort: cfg.remotePort });
    child.stdout?.on("data", (d) => pushLog(instance.id, d.toString()));
    child.stderr?.on("data", (d) => pushLog(instance.id, d.toString()));
    child.on("error", (err) => {
      pushLog(instance.id, `ssh -R: ${err.message}`);
      setState(instance.id, "error", `\u51FA\u7F51\u8F6C\u53D1\u8D77\u4E0D\u6765\uFF1A${err.message}`);
    });
    child.on("exit", (code) => {
      const current = rt(instance.id);
      if (current.forward === child) {
        current.forward = void 0;
        current.forwardPid = void 0;
      }
      if (current.stopping) return;
      if (code === 0) {
        setState(instance.id, "offline", "\u51FA\u7F51\u8F6C\u53D1\u5DF2\u9000\u51FA");
        return;
      }
      try {
        opts.store.reload();
      } catch {
      }
      const fresh = opts.store.get(instance.id);
      if (!fresh?.enabled || fresh.reconnect === false) {
        setState(instance.id, "offline", `\u51FA\u7F51\u8F6C\u53D1\u9000\u51FA\uFF08reconnect \u5173\uFF09\uFF1Aexit ${code}`);
        return;
      }
      current.forwardAttempts += 1;
      const delay = nextRetryDelay(current.forwardAttempts);
      setState(instance.id, "offline", `\u51FA\u7F51\u8F6C\u53D1\u65AD\u5F00\uFF0C${Math.round(delay / 1e3)}s \u540E\u91CD\u8FDE\uFF08\u7B2C ${current.forwardAttempts} \u6B21\uFF09`);
      current.forwardTimer = setTimeout(() => {
        current.forwardTimer = void 0;
        const again = opts.store.get(instance.id);
        if (!again || again.enabled === false || again.reconnect === false || current.stopping) return;
        ensureExternalRelay(again);
      }, delay);
      current.forwardTimer.unref?.();
    });
  }
  async function probeEngineCompat(instance) {
    const base = instanceUrl(instance.localPort);
    try {
      const headers = {};
      if (instance.uiPassword) {
        const login = await fetch(`${base}/auth/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: instance.uiPassword, trustDevice: true }),
          signal: AbortSignal.timeout(8e3)
        });
        const cookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
        if (!login.ok || !cookie) return { ok: false, error: `\u767B\u5F55\u5B9E\u4F8B\u5931\u8D25\uFF1AHTTP ${login.status}` };
        headers.cookie = cookie.split(";")[0];
      }
      const res = await fetch(`${base}/api/opencode/compatibility`, { headers, signal: AbortSignal.timeout(1e4) });
      if (!res.ok) return { ok: false, error: `\u517C\u5BB9\u6027\u63A5\u53E3 HTTP ${res.status}` };
      return judgeEngineCompat(await res.json());
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const manager = {
    async plan(id) {
      const instance = need(id);
      setState(id, "checking");
      const target = `${instance.user ? `${instance.user}@` : ""}${instance.host}:${instance.port}`;
      const actions = [];
      const url = instanceUrl(instance.localPort);
      const env = await probeEnv(instance);
      if (!env) {
        setState(id, "error", "ssh \u4E0D\u53EF\u8FBE");
        const how = instance.sshAuth === "password" ? "\u5BC6\u7801\u6863\uFF08askpass\uFF09" : "BatchMode";
        return { id, target, reachable: false, sshError: `ssh ${target} \u8FDE\u4E0D\u4E0A\uFF08${how}\uFF09`, engineCandidates: [], actions, url };
      }
      rt(id).inspected = env;
      const engineCmd = await ssh(instance, buildEngineProbeCommand(instance.enginePath ? [instance.enginePath] : DEFAULT_ENGINE_CANDIDATES), 45e3);
      const candidates = parseEngineProbe(engineCmd.stdout);
      const pick = await resolveEngine(instance);
      if (pick.ok) rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version };
      const runtimeProbe = await ssh(instance, buildRuntimeProbeCommand(), 25e3);
      const runtimeRaw = runtimeProbe.stdout.trim().split("\n").pop() ?? "";
      const runtime = runtimeRaw && runtimeRaw !== "MISSING" ? runtimeRaw : void 0;
      rt(id).runtimeVersion = runtime;
      const termProbe = await ssh(instance, buildTerminalProbeCommand(instance.appVersion), 25e3);
      const terminal = parseTerminalProbe(termProbe.stdout);
      rt(id).terminal = terminal.ok ? { ok: true } : { ok: false, reason: terminal.reason };
      const appProbe = await ssh(instance, buildAppProbeCommand(instance.appVersion), 45e3);
      const appRaw = appProbe.stdout.trim().split("\n").pop() ?? "";
      const app = appRaw && appRaw !== "MISSING" ? appRaw : void 0;
      rt(id).appVersion = app;
      actions.push(...provisionActions({
        provision: instance.provision,
        runtime,
        app,
        targetAppVersion: instance.appVersion,
        engineOk: pick.ok,
        engineError: pick.ok ? void 0 : pick.error
      }));
      const term = rt(id).terminal;
      if (term && term.ok === false) {
        actions.push(`\u6CE8\u610F\uFF1A\u7EC8\u7AEF\u6682\u4E0D\u53EF\u7528\uFF08${term.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF09\u2014\u2014\u5B9E\u4F8B\u5176\u4F59\u529F\u80FD\u4E0D\u53D7\u5F71\u54CD`);
      }
      actions.push(pick.ok ? `\u542F\u52A8\u5B9E\u4F8B\uFF1Aserve --hostname 127.0.0.1 --port ${instance.instancePort}\uFF08OpenCode ${pick.candidate.path} \u2192 ${pick.candidate.version}\uFF09` : `\u542F\u52A8\u5B9E\u4F8B\u524D\u5148\u88C5 OpenCode\uFF1Aopencode ${DEFAULT_ENGINE_PIN} \u2192 ~/.ocrc/remote/engine/opencode\uFF08\u8FDC\u7A0B\u673A\u5668\u73B0\u6709 v1 \u4E00\u5F8B\u4E0D\u52A8\uFF09`);
      actions.push(`\u5EFA\u8F6C\u53D1\uFF1Assh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort} \u2192 \u6253\u5F00 ${url}`);
      const egress = await egressFor(instance);
      actions.push(`\u8054\u7F51\u65B9\u5F0F\uFF1A${egress.relay ? "\u7ECF\u672C\u673A\u8F6C\u53D1" : "\u76F4\u8FDE"}\uFF08${egress.reason}\uFF09`);
      const portOut = await ssh(instance, buildPeerPortProbeCommand(instance.appVersion, instance.instancePort), 2e4);
      const peerPort = parsePortProbe(portOut.stdout);
      if (peerPort === "open") actions.push(`\u6CE8\u610F\uFF1A\u5B9E\u4F8B\u7AEF\u53E3 ${instance.instancePort} \u5728\u8FDC\u7A0B\u673A\u5668\u5DF2\u88AB\u5360\u7528\u2014\u2014\u6362\u4E2A\u5B9E\u4F8B\u7AEF\u53E3\uFF0C\u6216\u786E\u8BA4\u90A3\u662F\u4E0A\u4E00\u6B21\u7684\u5B9E\u4F8B\uFF08\u542F\u52A8\u4F1A\u590D\u7528\uFF09`);
      if (peerPort === "unknown") actions.push(`\u5B9E\u4F8B\u7AEF\u53E3 ${instance.instancePort}\uFF1A\u8FDC\u7A0B\u673A\u5668\u65E2\u6CA1\u6709\u6211\u4EEC\u7684\u8FD0\u884C\u65F6\u4E5F\u6CA1\u6709 ss/netstat\uFF0C\u5360\u7528\u60C5\u51B5\u65E0\u6CD5\u5224\u5B9A\uFF08\u542F\u52A8\u65F6\u624D\u4F1A\u77E5\u9053\uFF09`);
      setState(id, "unknown");
      return {
        id,
        target,
        reachable: true,
        inspected: env,
        runtime,
        app,
        engine: pick.ok ? { path: pick.candidate.path, version: pick.candidate.version } : void 0,
        engineError: pick.ok ? void 0 : pick.error,
        engineCandidates: candidates,
        actions,
        url,
        egress: { mode: instance.egress ?? EGRESS_DEFAULT, relay: egress.relay, reason: egress.reason, probe: egress.probe },
        provision: instance.provision ?? "push",
        tier: appPackTierForGlibc(env.glibc),
        peerPort
      };
    },
    /**
     * D5: one step from "the peer is on an older pin" to "the peer is on my pin".
     *
     * The app version is deliberately **not** a form field (the user settled that
     * pins are derived, not chosen), so the only meaningful upgrade action is this
     * one: compare the record against the control side's pin, and if they differ,
     * move the record and run the normal apply. Nothing happens when they already
     * match — an "upgrade" that reinstalls the same version is noise.
     */
    async upgrade(id) {
      const instance = need(id);
      const from = instance.appVersion;
      const to = DEFAULT_APP_VERSION;
      if (from === to) {
        return { ok: true, changed: false, from, to, detail: `\u5DF2\u7ECF\u662F\u8FDC\u7A0B\u673A\u5668\u8BE5\u6709\u7684\u90A3\u4E00\u4EFD\uFF1A${to}\uFF08pin \u6765\u81EA\u63A7\u5236\u7AEF\uFF09` };
      }
      pushLog(id, `\u5347\u7EA7\uFF1A${from} \u2192 ${to}\uFF08\u65E7\u6811\u7559 .ocrc-bak\uFF0C\u4E00\u4EFD\u5C31\u591F\uFF09`);
      opts.store.update(id, { appVersion: to });
      const result = await manager.apply(id, { force: false });
      return { ...result, changed: true, from, to };
    },
    async apply(id, applyOpts = {}) {
      const instance = need(id);
      if (instance.provision === "reuse" && !applyOpts.force) {
        setState(id, "provisioning", "\u590D\u7528\u5DF2\u5B89\u88C5\uFF1A\u53EA\u68C0\u67E5\uFF0C\u4E0D\u5199\u8FDC\u7A0B\u673A\u5668");
        const runtime = (await ssh(instance, buildRuntimeProbeCommand(), 25e3)).stdout.trim().split("\n").pop() ?? "MISSING";
        const appRaw = (await ssh(instance, buildAppProbeCommand(instance.appVersion), 45e3)).stdout.trim().split("\n").pop() ?? "";
        const pick = await resolveEngine(instance);
        const detail = `\u590D\u7528\u5DF2\u5B89\u88C5\uFF1A\u8FD0\u884C\u65F6 ${runtime === "MISSING" ? "\u7F3A\u5931" : runtime}\uFF1BOpenChamber ${appRaw === instance.appVersion ? instance.appVersion : `\u4E0D\u7B26\uFF08${appRaw || "\u7F3A\u5931"}\uFF09`}\uFF1BOpenCode ${pick.ok ? `${pick.candidate.version} @ ${pick.candidate.path}` : "\u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981"}`;
        pushLog(id, detail);
        if (runtime === "MISSING" || appRaw !== instance.appVersion || !pick.ok) {
          setState(id, "error", "\u590D\u7528\u5DF2\u5B89\u88C5\u68C0\u67E5\u672A\u901A\u8FC7");
          return { ok: false, detail: `${detail} \u2014\u2014 \u590D\u7528\u5DF2\u5B89\u88C5\u4E0D\u5199\u4EFB\u4F55\u5B57\u8282\uFF1B\u6539\u7528\u300C\u63A8\u9001\u5B89\u88C5\u300D\u6216\u5148\u5728\u8FDC\u7A0B\u673A\u5668\u4E0A\u88C5\u597D ${instance.appVersion}` };
        }
        if (pick.ok) {
          opts.store.update(id, { enginePath: pick.candidate.path, engineVersion: pick.candidate.version });
          rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version };
        }
        setState(id, "offline", "\u590D\u7528\u5DF2\u5B89\u88C5\u68C0\u67E5\u901A\u8FC7\uFF08\u672A\u542F\u52A8\uFF09");
        const components2 = await installComponentsIfRequested(instance, applyOpts);
        if (components2) {
          const full2 = `${detail}\uFF1B\u7EC4\u4EF6\uFF1A${components2.details.join("\uFF1B")}`;
          setState(id, components2.ok ? "offline" : "error", components2.ok ? "\u590D\u7528\u68C0\u67E5 + \u7EC4\u4EF6\u5B89\u88C5\u5B8C\u6210\uFF08\u672A\u542F\u52A8\uFF09" : "\u7EC4\u4EF6\u5B89\u88C5\u672A\u5B8C\u5168\u901A\u8FC7");
          return { ok: components2.ok, detail: full2 };
        }
        return { ok: true, detail };
      }
      const inspected = await probeEnv(instance);
      const tier = applyOpts.tier ?? appPackTierForGlibc(inspected?.glibc);
      pushLog(id, `OpenChamber \u5305\u517C\u5BB9\u6863\uFF1A${tier}${inspected?.glibc ? `\uFF08\u8FDC\u7A0B\u673A\u5668 glibc ${inspected.glibc}\uFF09` : ""}`);
      applyOpts.onLog?.(`OpenChamber \u5305\u517C\u5BB9\u6863\uFF1A${tier}${inspected?.glibc ? `\uFF08\u8FDC\u7A0B\u673A\u5668 glibc ${inspected.glibc}\uFF09` : ""}`);
      const ourEngine = `${instancePaths("x").engineDir}/opencode`;
      const foreignPin = instance.enginePath && instance.enginePath !== ourEngine ? instance.enginePath : void 0;
      if (foreignPin) {
        setState(id, "provisioning", "\u65AD\u8A00 pin \u7684 OpenCode");
        const pick = await resolveEngine(instance);
        if (!pick.ok) {
          setState(id, "error", "OpenCode \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981");
          return { ok: false, detail: `${pick.error}\uFF08R12\uFF1A\u4E0D\u8BB8\u56DE\u843D v1\uFF09` };
        }
        rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version };
      } else {
        setState(id, "provisioning", "\u63A8\u9001\u8FD0\u884C\u65F6 / OpenCode / OpenChamber");
      }
      const result = await provisionOffline(instance, instance.appVersion, {
        force: applyOpts.force,
        skipEngine: !!foreignPin,
        engineVersion: applyOpts.engineVersion,
        guard: applyOpts.guard,
        trace: applyOpts.trace,
        tier,
        onLog: (line) => {
          pushLog(id, line);
          applyOpts.onLog?.(line);
        }
      });
      const enginePath = result.engine.path ?? ourEngine;
      if (result.engine.ok && !foreignPin) {
        opts.store.update(id, { enginePath, engineVersion: result.engine.version });
        rt(id).engine = { path: enginePath, version: result.engine.version ?? "" };
      }
      if (result.runtime.ok) rt(id).runtimeVersion = result.runtime.detail.replace(/^已推送 |^已在位 /, "");
      if (result.app.ok) rt(id).appVersion = instance.appVersion;
      const parts = `\u8FD0\u884C\u65F6\uFF1A${result.runtime.detail}\uFF1BOpenCode\uFF1A${result.engine.detail}\uFF1BOpenChamber\uFF1A${result.app.detail}`;
      if (!result.ok) {
        setState(id, "error", parts);
        return { ok: false, detail: parts };
      }
      const components = await installComponentsIfRequested(instance, applyOpts);
      const full = components ? `${parts}\uFF1B\u7EC4\u4EF6\uFF1A${components.details.join("\uFF1B")}` : parts;
      setState(id, components && !components.ok ? "error" : "offline", components && !components.ok ? "\u7EC4\u4EF6\u5B89\u88C5\u672A\u5B8C\u5168\u901A\u8FC7" : "\u5B89\u88C5\u5B8C\u6210\uFF08\u672A\u542F\u52A8\uFF09");
      return { ok: components ? components.ok : true, detail: full };
    },
    async up(id, upOpts = {}) {
      const instance = need(id);
      setState(id, "starting");
      if (externalTunnel) startExternalMonitor(id);
      const pick = await resolveEngine(instance);
      if (!pick.ok) {
        setState(id, "error", "OpenCode \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981");
        return { ok: false, detail: `${pick.error}\uFF08R12\uFF1A\u4E0D\u8BB8\u56DE\u843D v1\uFF09` };
      }
      const runtime = await ssh(instance, buildRuntimeProbeCommand(), 25e3);
      if ((runtime.stdout.trim().split("\n").pop() ?? "MISSING") === "MISSING") {
        setState(id, "error", "\u8FD0\u884C\u65F6\u7F3A\u5931");
        return { ok: false, detail: "\u76EE\u6807\u673A\u4E0A\u8FD8\u6CA1\u6709\u8FD0\u884C\u65F6/\u5E94\u7528\u2014\u2014\u5148\u8DD1 ocrc remote apply <id>" };
      }
      if (await remoteHealth(instance) !== "200") {
        const relay = await ensureProxy(instance);
        if (relay !== "off") pushLog(instance.id, `\u51FA\u7F51\u8F6C\u53D1\uFF1A${relay}`);
        if (externalTunnel) ensureExternalRelay(instance);
        const started = await startInstance(instance, pick.candidate.path, upOpts.guard);
        if (!started.ok) {
          setState(id, "error", started.detail);
          return started;
        }
        pushLog(id, started.detail);
      } else {
        const wantsRelay = (await egressFor(instance)).relay;
        const running = await probeInstanceProxy(instance);
        const expected = wantsRelay ? relayProxyUrl(proxyConfig(instance).remotePort) : "none";
        if (running === "unknown") {
          pushLog(id, `\u5B9E\u4F8B\u5DF2\u5728 :${instance.instancePort} \u4E0A\u670D\u52A1\uFF08\u590D\u7528\uFF1B\u8BFB\u4E0D\u5230\u8FDC\u7A0B\u673A\u5668\u8FDB\u7A0B\u7684 env\uFF0C\u8054\u7F51\u662F\u5426\u4E0E\u7B56\u7565\u4E00\u81F4\u672A\u77E5\uFF09`);
        } else if (running === expected) {
          pushLog(id, `\u5B9E\u4F8B\u5DF2\u5728 :${instance.instancePort} \u4E0A\u670D\u52A1\uFF08\u590D\u7528\uFF0C\u4E0D\u91CD\u542F\uFF1B\u51FA\u53E3 ${running === "none" ? "\u76F4\u8FDE" : running} \u4E0E\u7B56\u7565\u4E00\u81F4\uFF09`);
        } else {
          const why = wantsRelay ? "\u7B56\u7565\u8981\u6C42\u7ECF\u672C\u673A\u8F6C\u53D1\uFF08\u8FDC\u7A0B\u673A\u5668\u51FA\u4E0D\u4E86\u7F51\uFF09\uFF0C\u4F46\u5B9E\u4F8B\u662F\u5728\u76F4\u8FDE\u6863\u8D77\u7684" : "\u7B56\u7565\u662F\u76F4\u8FDE\uFF0C\u4F46\u5B9E\u4F8B\u8FD8\u6302\u5728\u6211\u4EEC\u8F6C\u53D1\u4E0A";
          pushLog(id, `${why}\u2014\u2014\u91CD\u542F\u5B9E\u4F8B\u8BA9 env \u8DDF\u4E0A\uFF08\u73B0\u5728 ${running}\uFF0C\u671F\u671B ${expected}\uFF09`);
          const stopped = await stopInstance(instance);
          if (!stopped.ok) {
            setState(id, "error", stopped.detail);
            return stopped;
          }
          const relay = await ensureProxy(instance);
          if (relay !== "off") pushLog(instance.id, `\u51FA\u7F51\u8F6C\u53D1\uFF1A${relay}`);
          if (externalTunnel) ensureExternalRelay(instance);
          const restarted = await startInstance(instance, pick.candidate.path, upOpts.guard);
          if (!restarted.ok) {
            setState(id, "error", restarted.detail);
            return restarted;
          }
          pushLog(id, `${restarted.detail}\uFF08\u56E0\u51FA\u53E3\u7B56\u7565\u53D8\u5316\u800C\u91CD\u542F\uFF09`);
        }
      }
      if (proxyConfig(instance).enabled) await ensureProxy(instance);
      if (externalTunnel) {
        ensureExternalRelay(instance);
        const verified = await withTempForward(instance, async (temp) => {
          let probe2 = await probeThroughForward(temp);
          const deadline2 = Date.now() + 2e4;
          while (!probe2.ok && Date.now() < deadline2) {
            await new Promise((r3) => setTimeout(r3, 1e3));
            probe2 = await probeThroughForward(temp);
          }
          if (!probe2.ok) return { ok: false, detail: `\u5B9E\u4F8B\u5DF2\u8D77\u4F46\u8F6C\u53D1\u63A2\u6D3B\u5931\u8D25\uFF1A${probe2.error}` };
          const compat2 = await probeEngineCompat(temp);
          if (!compat2.ok) return { ok: false, detail: `\u5B9E\u4F8B\u5728\u8DD1\uFF0C\u4F46OpenCode\u95E8\u7981\u672A\u8FC7\uFF1A${compat2.error}` };
          return { ok: true, version: probe2.version, compat: compat2 };
        }).catch((err) => ({ ok: false, detail: err.message }));
        if (!verified.ok) {
          setState(id, "error", verified.detail);
          return { ok: false, detail: verified.detail };
        }
        const r2 = rt(id);
        r2.forwardAttempts = 0;
        r2.engine = { path: verified.compat.binary, version: verified.compat.version };
        setState(id, "online", `openchamber ${verified.version}\uFF08OpenCode ${verified.compat.version} @ ${verified.compat.binary}\uFF1B\u8F6C\u53D1\u7531\u684C\u9762\u5E94\u7528\u6301\u6709\uFF09`);
        return { ok: true, detail: `\u8FDC\u7AEF\u5B9E\u4F8B\u5728\u7EBF\uFF1B\u8F6C\u53D1\u7531\u684C\u9762\u5E94\u7528\u6301\u6709\uFF08${instanceUrl(instance.localPort)}\uFF1Bopenchamber ${verified.version}\uFF0COpenCode ${verified.compat.version} @ ${verified.compat.binary}\uFF09` };
      }
      if (await isListening(instance.localPort)) {
        const relayLive = proxyConfig(instance).enabled ? (await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, proxyConfig(instance).remotePort), 2e4)).stdout.trim().endsWith("open") : true;
        if (relayLive) {
          pushLog(id, `\u672C\u5730 ${instance.localPort} \u5DF2\u5728\u76D1\u542C\u4E14\u5E26 -R \u8F6C\u53D1\u2014\u2014\u590D\u7528\u8FD9\u6761\u96A7\u9053`);
        } else {
          const detail = `\u672C\u5730 127.0.0.1:${instance.localPort} \u5DF2\u88AB\u5360\u7528\uFF0C\u4F46\u5B83\u6CA1\u6709 -R \u51FA\u7F51\u8F6C\u53D1\uFF08\u591A\u534A\u662F\u65E7\u547D\u4EE4\u7559\u4E0B\u7684\u96A7\u9053\uFF09\u2014\u2014\u5148\u505C\u6389\u5B83\u518D up`;
          setState(id, "error", detail);
          return { ok: false, detail };
        }
      }
      ensureForward(instance);
      const deadline = Date.now() + 2e4;
      let probe = await probeThroughForward(instance);
      while (!probe.ok && Date.now() < deadline) {
        await new Promise((r2) => setTimeout(r2, 1e3));
        probe = await probeThroughForward(instance);
      }
      if (!probe.ok) {
        setState(id, "error", `\u8F6C\u53D1\u63A2\u6D3B\u5931\u8D25\uFF1A${probe.error}`);
        return { ok: false, detail: `\u5B9E\u4F8B\u5DF2\u8D77\u4F46\u8F6C\u53D1\u63A2\u6D3B\u5931\u8D25\uFF1A${probe.error}` };
      }
      const compat = await probeEngineCompat(instance);
      if (!compat.ok) {
        setState(id, "error", `OpenCode\u95E8\u7981\u672A\u8FC7\uFF1A${compat.error}`);
        return { ok: false, detail: `\u5B9E\u4F8B\u5728\u8DD1\uFF0C\u4F46OpenCode\u95E8\u7981\u672A\u8FC7\uFF1A${compat.error}` };
      }
      const r = rt(id);
      r.forwardAttempts = 0;
      r.engine = { path: compat.binary, version: compat.version };
      setState(id, "online", `openchamber ${probe.version}\uFF08OpenCode ${compat.version} @ ${compat.binary}\uFF09`);
      return { ok: true, detail: `online\uFF1A${instanceUrl(instance.localPort)}\uFF08openchamber ${probe.version}\uFF0COpenCode ${compat.version} @ ${compat.binary}\uFF09` };
    },
    async down(id) {
      const instance = need(id);
      const r = rt(id);
      r.stopping = true;
      stopExternalMonitor(id);
      try {
        stopForward(id);
        stopPairForward(id);
        const stopped = await stopInstance(instance);
        setState(id, stopped.ok ? "offline" : "error", stopped.detail);
        return stopped;
      } finally {
        r.stopping = false;
      }
    },
    async probe(id) {
      const instance = opts.store.get(id);
      if (!instance) return { online: false, detail: "no such instance" };
      if (externalTunnel) {
        const health2 = await remoteHealth(instance);
        if (health2 !== "200") {
          const r2 = rt(id);
          if (r2.state === "online") setState(id, "offline", `\u8FDC\u7A0B\u5B9E\u4F8B\u672A\u54CD\u5E94\uFF08health ${health2}\uFF09`);
          return { online: false, detail: `\u8FDC\u7A0B\u5B9E\u4F8B\u672A\u54CD\u5E94\uFF08health ${health2}\uFF09` };
        }
        await ensureExternalRelayAsync(instance);
        const relayUp = !(await egressFor(instance)).relay || (await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, proxyConfig(instance).remotePort), 2e4)).stdout.trim().endsWith("open");
        if (!relayUp) return { online: false, detail: `\u8FDC\u7A0B\u5B9E\u4F8B\u5728\u8DD1\uFF0C\u4F46\u51FA\u7F51\u8F6C\u53D1 :${proxyConfig(instance).remotePort} \u672A\u5EFA\u7ACB` };
        const r = rt(id);
        const probe2 = await withTempForward(instance, (temp) => probeThroughForward(temp)).catch(() => ({ ok: false, error: "\u4E34\u65F6\u8F6C\u53D1\u5931\u8D25" }));
        const version = probe2.ok ? probe2.version : void 0;
        const ui = await isListening(instance.localPort) ? `\uFF1B\u672C\u5730\u8F6C\u53D1 :${instance.localPort} \u4E5F\u5728\u542C` : "\uFF1B\u8F6C\u53D1\u7531\u684C\u9762\u5E94\u7528\u6301\u6709";
        if (r.state !== "online") setState(id, "online", version ? `openchamber ${version}\uFF08\u8FDC\u7AEF\u5B9E\u6D4B\uFF09` : `\u8FDC\u7A0B\u673A\u5668\u5C31\u7EEA${ui}`);
        return { online: true, version, detail: `\u8FDC\u7A0B\u5B9E\u4F8B\u5728\u7EBF${ui}` };
      }
      const probe = await probeThroughForward(instance);
      if (probe.ok) {
        const r = rt(id);
        if (r.state !== "online") setState(id, "online", `openchamber ${probe.version}\uFF08\u5B9E\u6D4B\uFF09`);
        return { online: true, version: probe.version };
      }
      const health = await remoteHealth(instance);
      if (health === "200") {
        return {
          online: false,
          remote: true,
          detail: `\u8FDC\u7AEF\u5B9E\u4F8B\u5728\u7EBF\uFF08health 200\uFF09\uFF1B\u672C\u5730\u8F6C\u53D1 :${instance.localPort} \u672A\u8D77\u2014\u2014\u96A7\u9053\u53EF\u80FD\u7531\u684C\u9762\u7248\u6216\u53E6\u4E00\u4E2A\u8FDB\u7A0B\u6301\u6709`
        };
      }
      return { online: false, detail: probe.error };
    },
    pairLink(id) {
      return pairLink(id);
    },
    status(id) {
      const instance = opts.store.get(id);
      const r = runtimes.get(id);
      if (!instance) return void 0;
      const cfg = proxyConfig(instance);
      const proxy = proxies.get(cfg.localPort);
      return {
        id,
        state: r?.state ?? (instance.enabled ? "unknown" : "disabled"),
        detail: r?.detail,
        since: r?.since,
        url: instanceUrl(instance.localPort),
        tunnelOwner: externalTunnel ? "external" : "self",
        forwardPid: r?.forwardPid,
        forwardAttempts: r?.forwardAttempts,
        /** D7: who holds each leg, so "端口被占" has a name attached. */
        holders: describeHolders(instance.id, opts.home),
        engine: r?.engine ?? (instance.enginePath ? { path: instance.enginePath, version: instance.engineVersion ?? "" } : void 0),
        runtime: r?.runtimeVersion,
        app: r?.appVersion,
        inspected: r?.inspected,
        terminal: r?.terminal,
        proxy: {
          ...cfg,
          listening: !!proxy,
          connects: (proxy?.connects ?? []).slice(-20).map((t) => `${t.host}:${t.port}`)
        },
        egress: egressView(instance),
        logTail: r?.logs.slice(-40) ?? []
      };
    },
    statusAll() {
      return opts.store.list().map((i) => manager.status(i.id)).filter((s) => !!s);
    },
    async egress(id) {
      const instance = need(id);
      const decision = await egressFor(instance);
      return { mode: instance.egress ?? EGRESS_DEFAULT, ...decision };
    },
    // ── C1–C4: config and credentials for the peer's engine ────────────────────
    async configDiff(id, diffOpts = {}) {
      const instance = need(id);
      const local = readLocalConfig({ dir: opts.localConfigDir, authPath: opts.localAuthPath });
      const read = await ssh(instance, buildPeerConfigReadScript(), 45e3);
      const peer = parsePeerConfigRead(read.stdout);
      const peerError = read.code === 0 ? void 0 : cleanSshNoise(read.stderr || read.stdout).trim().split("\n").pop();
      const diff = diffConfig(local, peer);
      const component = await componentPluginsFor(instance, diffOpts.components);
      const plan = planConfigSync(local, peer, {
        diff,
        providerBaseUrl: instance.providerBaseUrl,
        componentPlugins: component.plugins,
        componentNames: component.names
      });
      const notConfig = (rel) => rel !== "opencode.json" && rel !== "opencode.jsonc";
      return {
        localDir: local.dir,
        add: diff.add.filter(notConfig),
        change: diff.change.filter(notConfig),
        same: diff.same.filter(notConfig),
        peerOnly: diff.peerOnly.filter(notConfig),
        unknown: diff.unknown.filter(notConfig),
        auth: diff.auth,
        plan: {
          basename: plan.basename,
          configChanged: plan.configChanged,
          files: plan.files,
          deletes: plan.deletes,
          keyDeletes: plan.keyDeletes,
          keyDeleteCandidates: plan.keyDeleteCandidates,
          managedPlugins: plan.managedPlugins,
          droppedManagedKeys: plan.droppedManagedKeys,
          secretsReplaced: plan.secretsReplaced,
          baseUrlRewrites: plan.baseUrlRewrites,
          commentsWillBeLost: plan.commentsWillBeLost,
          shadowed: plan.shadowed,
          notes: plan.notes
        },
        peerError
      };
    },
    async syncConfig(id, syncOpts = {}) {
      const instance = need(id);
      const local = readLocalConfig({ dir: opts.localConfigDir, authPath: opts.localAuthPath });
      const read = await ssh(instance, buildPeerConfigReadScript(), 45e3);
      if (read.code !== 0) {
        const detail = `\u8BFB\u8FDC\u7A0B\u673A\u5668\u914D\u7F6E\u5931\u8D25\uFF1A${cleanSshNoise(read.stderr || read.stdout).trim().split("\n").pop() ?? `exit ${read.code}`}`;
        pushLog(id, detail);
        return { ok: false, detail };
      }
      const peer = parsePeerConfigRead(read.stdout);
      const diff = diffConfig(local, peer);
      const component = await componentPluginsFor(instance, syncOpts.components);
      const plan = planConfigSync(local, peer, {
        diff,
        deletes: syncOpts.deletes,
        keyDeletes: syncOpts.keyDeletes,
        providerBaseUrl: instance.providerBaseUrl,
        preferCommentedTarget: syncOpts.preferCommentedTarget,
        componentPlugins: component.plugins,
        componentNames: component.names
      });
      const nothing = plan.files.length === 0 && plan.deletes.length === 0;
      if (nothing) {
        pushLog(id, "sync-config: \u65E0\u5DEE\u5F02\uFF0C\u672A\u5199\u8FDC\u7A0B\u673A\u5668");
        return { ok: true, detail: "\u65E0\u5DEE\u5F02\uFF1A\u8FDC\u7A0B\u673A\u5668\u5DF2\u7ECF\u548C\u672C\u5730\u4E00\u81F4\uFF08\u672A\u5199\u4EFB\u4F55\u6587\u4EF6\uFF09" };
      }
      if (syncOpts.dryRun) {
        return {
          ok: true,
          detail: `\u8BD5\u8FD0\u884C\uFF1A\u5C06\u5199 ${plan.files.length} \u4E2A\u6587\u4EF6${plan.deletes.length ? `\u3001\u5220 ${plan.deletes.length} \u4E2A` : ""}\uFF1B${plan.notes.join("\uFF1B")}`
        };
      }
      const staging = mkdtempSync(join10(tmpdir2(), "ocrc-cfgsync-"));
      try {
        const content = plan.merged && plan.configChanged ? renderConfig(plan.merged) : void 0;
        const topLevel = [...new Set(plan.files.map((rel) => rel.split("/")[0]).filter((e) => e !== plan.basename))];
        const staged = stageConfigTree({
          sourceDir: local.dir,
          destDir: staging,
          entries: topLevel,
          mergedConfig: content ? { basename: plan.basename, content } : void 0
        });
        if (staged.length === 0 && plan.deletes.length === 0) {
          pushLog(id, "sync-config: \u65E0\u5DEE\u5F02\uFF0C\u672A\u5199\u8FDC\u7A0B\u673A\u5668");
          return { ok: true, detail: "\u65E0\u5DEE\u5F02\uFF1A\u8FDC\u7A0B\u673A\u5668\u5DF2\u7ECF\u548C\u672C\u5730\u4E00\u81F4\uFF08\u672A\u5199\u4EFB\u4F55\u6587\u4EF6\uFF09" };
        }
        pushLog(id, `$ sync-config ${staged.join(" ")}${plan.deletes.length ? ` (delete ${plan.deletes.join(" ")})` : ""}`);
        const result = await pipeTarToSsh(instance, staging, buildConfigApplyScript(plan.deletes), 12e4);
        for (const line of result.stdout.split("\n")) if (line.trim()) pushLog(id, line.trim());
        if (result.code !== 0) {
          const detail2 = `sync-config \u5931\u8D25\uFF08exit ${result.code}\uFF09\uFF1A${cleanSshNoise(result.stderr || result.stdout).trim().split("\n").pop() ?? ""}`;
          pushLog(id, detail2);
          return { ok: false, detail: detail2 };
        }
        const written2 = result.stdout.split("\n").filter((l) => l.startsWith("new:") || l.startsWith("backup:")).length;
        const backedUp = result.stdout.split("\n").filter((l) => l.startsWith("backup:")).length;
        const deleted = result.stdout.split("\n").filter((l) => l.startsWith("deleted:")).length;
        const detail = `\u540C\u6B65 ${written2} \u4E2A\u6587\u4EF6${backedUp ? `\uFF08${backedUp} \u4E2A\u65E7\u4EF6\u7559 .ocrc-bak\uFF09` : ""}${deleted ? `\uFF0C\u5220 ${deleted} \u4E2A\uFF08\u4E5F\u7559 .ocrc-bak\uFF09` : ""}` + (plan.droppedManagedKeys.length ? `\uFF1B\u8DF3\u8FC7 ${plan.droppedManagedKeys.join("/")}\uFF08\u8FDC\u7A0B\u673A\u5668\u81EA\u5DF1\u7684\u63D2\u4EF6\u5C42\uFF09` : "");
        pushLog(id, detail);
        if (plan.secretsReplaced.length > 0) pushLog(id, `\u5BC6\u94A5\u6539\u5199\u4E3A {env:\u2026}\uFF1A${plan.secretsReplaced.map((s) => s.env).join(", ")}\uFF08\u503C\u4E0D\u843D\u8FDC\u7A0B\u673A\u5668\u6587\u4EF6\uFF09`);
        return { ok: true, detail };
      } finally {
        discardStaging(staging);
      }
    },
    async syncAuth(id) {
      const instance = need(id);
      const local = readLocalConfig({ dir: opts.localConfigDir, authPath: opts.localAuthPath });
      if (!local.authPresent) {
        return { ok: false, detail: `\u672C\u673A\u6CA1\u6709 ${local.authPath}\u2014\u2014\u5148\u5728\u672C\u673A\u767B\u5F55 provider\uFF08opencode auth login\uFF09` };
      }
      const content = readFileSync7(local.authPath);
      const result = await sshRunWithStdin(instance, buildAuthPushScript(), content, { timeoutMs: 45e3 });
      if (result.code !== 0) {
        const detail = `\u51ED\u636E\u540C\u6B65\u5931\u8D25\uFF08exit ${result.code}\uFF09\uFF1A${cleanSshNoise(result.stderr || result.stdout).trim().split("\n").pop() ?? ""}`;
        pushLog(id, detail);
        return { ok: false, detail };
      }
      pushLog(id, "sync-auth: \u51ED\u636E\u5DF2\u5199\u5230\u8FDC\u7A0B\u673A\u5668\uFF080600\uFF0C\u65E7\u4EF6\u7559 .ocrc-bak\uFF09");
      return { ok: true, detail: `\u51ED\u636E\u5DF2\u540C\u6B65\uFF08${content.length} \u5B57\u8282 \u2192 \u8FDC\u7A0B\u673A\u5668 0600\uFF09` };
    },
    logs(id) {
      return rt(id).logs.slice(-LOG_CAP);
    },
    async peerLogs(id, logOpts = {}) {
      const instance = need(id);
      const lines = logOpts.lines && logOpts.lines > 0 ? Math.min(logOpts.lines, 400) : 40;
      const r = await ssh(instance, buildPeerLogCommand(instance.appVersion, instance.instancePort, lines), 3e4);
      const parsed = parsePeerLogs(r.stdout);
      if (r.code !== 0) {
        return { ...parsed, ok: false, error: cleanSshNoise(r.stderr || r.stdout).trim().split("\n").pop() ?? `exit ${r.code}` };
      }
      return { ...parsed, ok: true };
    },
    ensureAll() {
      for (const instance of opts.store.list()) {
        if (!instance.enabled) {
          setState(instance.id, "disabled");
          continue;
        }
        if (instance.restoreOnStart === false) {
          pushLog(instance.id, "restoreOnStart \u5173\uFF1A\u4E0D\u81EA\u52A8\u62C9\u8D77\uFF08R10 \u5F00\u5173 \u2461\uFF09");
          continue;
        }
        void manager.up(instance.id).catch((err) => {
          setState(instance.id, "error", `\u81EA\u6062\u590D\u5931\u8D25\uFF1A${err.message}`);
        });
      }
    },
    dispose() {
      if (!detachedForwards) {
        for (const id of runtimes.keys()) {
          const r = rt(id);
          r.stopping = true;
          stopExternalMonitor(id);
          stopForward(id);
        }
      }
      for (const [port, proxy] of proxies) {
        void proxy.close().catch(() => {
        });
        proxies.delete(port);
      }
    }
  };
  return manager;
}

// src/service/remote-instance-ops.ts
import { randomUUID } from "node:crypto";
import net3 from "node:net";
async function firstFreeLocalPort(from = DEFAULT_LOCAL_PORT, window = 40) {
  for (let port = from; port < from + window; port += 1) {
    if (!await isPortListening(port)) return port;
  }
  return from;
}
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net3.connect(port, "127.0.0.1");
    const done = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(700, () => done(false));
  });
}
function validateInstancePayload(payload) {
  const auth = payload?.sshAuth;
  if (auth !== void 0 && auth !== null && auth !== "key" && auth !== "password") {
    return `\u767B\u5F55\u65B9\u5F0F\u4E0D\u5408\u6CD5\uFF1A${String(auth)}\uFF08\u53EA\u63A5\u53D7 key / password\uFF09`;
  }
  const egress = payload?.egress;
  if (egress !== void 0 && egress !== null && egress !== "auto" && egress !== "relay" && egress !== "direct") {
    return `\u8054\u7F51\u65B9\u5F0F\u4E0D\u5408\u6CD5\uFF1A${String(egress)}\uFF08\u53EA\u63A5\u53D7 auto / relay / direct\uFF09`;
  }
  const provision = payload?.provision;
  if (provision !== void 0 && provision !== null && provision !== "push" && provision !== "reuse") {
    return `\u5B89\u88C5\u65B9\u5F0F\u4E0D\u5408\u6CD5\uFF1A${String(provision)}\uFF08\u53EA\u63A5\u53D7 push / reuse\uFF09`;
  }
  return void 0;
}
var withStatus = (manager) => (i) => ({
  ...redactInstance(i),
  status: manager.status(i.id) ?? null
});
function createRemoteInstanceOps({
  store,
  manager,
  jobTtlMs = 10 * 6e4
}) {
  const jobs = /* @__PURE__ */ new Map();
  const prune = () => {
    const cutoff = Date.now() - jobTtlMs;
    for (const [id, job] of jobs) {
      if (job.state !== "running" && job.startedAt < cutoff) jobs.delete(id);
    }
    if (jobs.size > 100) {
      for (const id of jobs.keys()) {
        if (jobs.size <= 100) break;
        if (jobs.get(id)?.state !== "running") jobs.delete(id);
      }
    }
  };
  const start = (fn) => {
    prune();
    const jobId = randomUUID();
    const job = { state: "running", startedAt: Date.now() };
    jobs.set(jobId, job);
    void fn().then((result) => {
      job.state = "done";
      job.result = result;
    }).catch((err) => {
      job.state = "error";
      job.error = err.message;
    });
    return { status: 202, body: { jobId } };
  };
  const statusFor = (id) => manager.status(id);
  return {
    async handle(op) {
      switch (op.op) {
        case "list":
          return { status: 200, body: { instances: store.list().map(withStatus(manager)) } };
        case "add": {
          const body = op.payload;
          if (!body?.host || typeof body.host !== "string") return { status: 400, body: { error: "\u9700\u8981\u4E3B\u673A\u5730\u5740" } };
          for (const [key, value] of [["port", body.port], ["instancePort", body.instancePort], ["localPort", body.localPort]]) {
            if (value != null && (!Number.isFinite(value) || value < 1 || value > 65535)) {
              return { status: 400, body: { error: `${key} \u4E0D\u662F\u5408\u6CD5\u7AEF\u53E3` } };
            }
          }
          const authError = validateInstancePayload(body);
          if (authError) return { status: 400, body: { error: authError } };
          const saved = store.upsert({ ...body, host: body.host });
          return { status: 200, body: { instance: { ...redactInstance(saved), status: statusFor(saved.id) ?? null } } };
        }
        case "patch": {
          const authError = validateInstancePayload(op.payload);
          if (authError) return { status: 400, body: { error: authError } };
          const updated = store.update(op.id, op.payload);
          if (!updated) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return { status: 200, body: { instance: { ...redactInstance(updated), status: statusFor(updated.id) ?? null } } };
        }
        case "delete": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          await manager.down(op.id).catch(() => {
          });
          store.remove(op.id);
          return { status: 200, body: { ok: true } };
        }
        case "plan": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.plan(op.id));
        }
        case "apply": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          if (op.payload?.confirm !== true) {
            return { status: 409, body: { error: "\u5199\u8FDC\u7A0B\u673A\u5668\u9700\u8981\u4E00\u6B21\u663E\u5F0F\u786E\u8BA4\uFF08confirm:true\uFF09", dryRun: true } };
          }
          return start(() => manager.apply(op.id, { force: op.payload?.force === true }));
        }
        case "upgrade": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.upgrade(op.id));
        }
        case "up":
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.up(op.id));
        case "down":
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.down(op.id));
        case "probe":
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.probe(op.id));
        case "status": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          const status = statusFor(op.id);
          if (!status) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          const live = await manager.probe(op.id);
          if (live.online) {
            return {
              status: 200,
              body: {
                status: {
                  ...status,
                  state: "online",
                  detail: live.version ? `openchamber ${live.version}\uFF08\u5B9E\u6D4B\uFF09` : live.detail ?? status.detail
                }
              }
            };
          }
          return {
            status: 200,
            body: {
              status: {
                ...status,
                state: status.state === "online" ? "offline" : status.state,
                detail: live.detail ?? status.detail
              }
            }
          };
        }
        case "logs": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          const lines = manager.logs(op.id);
          const tail = Number(op.tail ?? 100);
          return { status: 200, body: { lines: Number.isFinite(tail) && tail > 0 ? lines.slice(-tail) : lines } };
        }
        case "peerlog": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.peerLogs(op.id, { lines: op.lines }));
        }
        case "url": {
          const instance = store.get(op.id);
          if (!instance) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return {
            status: 200,
            body: { url: `http://127.0.0.1:${instance.localPort}`, online: manager.status(op.id)?.state === "online" }
          };
        }
        case "pairlink": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.pairLink(op.id));
        }
        case "defaults": {
          const localPort = await firstFreeLocalPort();
          return {
            status: 200,
            body: {
              localPort,
              instancePort: DEFAULT_INSTANCE_PORT,
              appVersion: DEFAULT_APP_VERSION,
              enginePin: DEFAULT_ENGINE_PIN,
              nodeRuntime: NODE_RUNTIME.version,
              bind: "127.0.0.1",
              // Two records must not share the control-side forward port, so the
              // suggestion also avoids what the store already claims.
              taken: store.list().map((i) => i.localPort)
            }
          };
        }
        case "uipassword": {
          const instance = store.get(op.id);
          if (!instance) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          if (!instance.uiPassword) return { status: 404, body: { error: "\u8FD9\u53F0\u670D\u52A1\u5668\u6CA1\u6709\u754C\u9762\u5BC6\u7801" } };
          return { status: 200, body: { uiPassword: instance.uiPassword, url: `http://127.0.0.1:${instance.localPort}` } };
        }
        case "configdiff": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.configDiff(op.id));
        }
        case "syncconfig": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          for (const field of ["deletes", "keyDeletes"]) {
            const value = op.payload?.[field];
            if (value !== void 0 && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
              return { status: 400, body: { error: `${field} must be a string[]` } };
            }
          }
          return start(() => manager.syncConfig(op.id, {
            deletes: op.payload?.deletes,
            keyDeletes: op.payload?.keyDeletes,
            dryRun: op.payload?.dryRun === true
          }));
        }
        case "syncauth": {
          if (!store.get(op.id)) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return start(() => manager.syncAuth(op.id));
        }
        case "job": {
          const job = jobs.get(op.jobId);
          if (!job) return { status: 404, body: { error: "\u6CA1\u6709\u8FD9\u53F0\u670D\u52A1\u5668" } };
          return {
            status: 200,
            body: {
              job: { state: job.state, result: job.result, error: job.error, startedAt: job.startedAt }
            }
          };
        }
        default: {
          const exhaustive = op;
          return { status: 400, body: { error: `unknown op: ${JSON.stringify(exhaustive)}` } };
        }
      }
    },
    dispose() {
      jobs.clear();
    }
  };
}

// src/service/main.ts
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var remoteInstances = createRemoteInstancesStore(remoteInstancesPath(ocrcHome()), { flushOnExit: false });
var remoteManager = createRemoteInstanceManager({ store: remoteInstances, tunnelOwner: "external" });
var remoteOps = createRemoteInstanceOps({ store: remoteInstances, manager: remoteManager });
function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
}
var server = http2.createServer(async (req, res) => {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/remote-instance") {
      const body = await readBody(req);
      if (!body?.op) {
        json(res, 400, { error: "op required" });
        return;
      }
      const reply = await remoteOps.handle(body);
      json(res, reply.status, reply.body);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});
if (process.env.OPENCHAMBER_SERVICE_PORT === void 0 || process.env.OPENCHAMBER_SERVICE_PORT === "") {
  console.error("[ocrc] OPENCHAMBER_SERVICE_PORT missing \u2014 not launched by openchamber?");
  process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const bound = addr && typeof addr !== "string" ? addr.port : PORT;
  console.log(`[ocrc] service listening on 127.0.0.1:${bound}`);
  remoteManager.ensureAll();
});
var shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  remoteInstances.flush();
  remoteOps.dispose();
  remoteManager.dispose();
}
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
