// src/service/main.ts
import http3 from "node:http";
import { readFileSync as readFileSync5, existsSync as existsSync5, writeFileSync as writeFileSync4, mkdirSync as mkdirSync5 } from "node:fs";
import { join as join9 } from "node:path";
import { homedir as homedir5 } from "node:os";

// src/service/tunnel.ts
import { spawn } from "node:child_process";
import http from "node:http";

// src/shared/protocol.ts
var DEFAULT_REMOTE_PORT = 4096;
var DEFAULT_LOCAL_PORT = 4096;
function normalizeProfile(raw) {
  return {
    id: raw.id ?? `p-${Date.now().toString(36)}`,
    name: raw.name?.trim() || raw.host,
    host: raw.host.trim(),
    port: raw.port && raw.port > 0 ? raw.port : 22,
    user: raw.user?.trim() || "root",
    keyPath: raw.keyPath?.trim() || void 0,
    remotePort: raw.remotePort && raw.remotePort > 0 ? raw.remotePort : DEFAULT_REMOTE_PORT,
    localPort: raw.localPort && raw.localPort > 0 ? raw.localPort : DEFAULT_LOCAL_PORT,
    allowedRoots: Array.isArray(raw.allowedRoots) ? raw.allowedRoots.map((r) => String(r).trim()).filter((r) => r.startsWith("/")) : void 0,
    projects: Array.isArray(raw.projects) ? raw.projects.map((p) => ({ path: String(p.path ?? "").trim(), label: p.label?.trim() || void 0 })).filter((p) => p.path.startsWith("/")) : void 0,
    forwards: Array.isArray(raw.forwards) ? raw.forwards : void 0,
    engineVersion: raw.engineVersion?.trim() || void 0
  };
}
function buildSshArgs(p) {
  const args = [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    // accept-new is OpenSSH 8.0+; EL7-era ssh (5.3/7.4) rejects the whole
    // option line. Use the permissive classic form — hosts come from an
    // explicit user-authored profile, and the tunnel only forwards loopback.
    "-o",
    "StrictHostKeyChecking=no",
    "-p",
    String(p.port)
  ];
  if (p.keyPath) args.push("-i", p.keyPath);
  args.push("-L", `127.0.0.1:${p.localPort}:127.0.0.1:${p.remotePort}`);
  for (const forward of p.forwards ?? []) {
    if (!forward.port) continue;
    args.push(
      forward.direction === "local" ? "-L" : "-R",
      `127.0.0.1:${forward.port}:${forward.peerHost}:${forward.peerPort}`
    );
  }
  args.push(`${p.user}@${p.host}`);
  return args;
}

// src/service/tunnel.ts
var RETRY_BASE_MS = 2e3;
var RETRY_MAX_MS = 6e4;
function createTunnelSupervisor(deps = {}) {
  const spawnSsh = deps.spawnSsh ?? ((args) => spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] }));
  const probeEngine = deps.probeEngine ?? defaultProbeEngine;
  const now = deps.now ?? (() => Date.now());
  let child;
  let profile;
  let stopped = true;
  let retryTimer;
  let retryAttempt = 0;
  let lastExitDetail = "";
  function status() {
    if (!profile) return { profileId: null, tunnel: "down", engine: "unknown", detail: "no profile" };
    const up = !stopped && child && child.exitCode === null;
    return {
      profileId: profile.id,
      tunnel: up ? "up" : stopped ? "down" : "starting",
      engine: "unknown",
      detail: lastExitDetail || void 0,
      since: up ? now() : void 0
    };
  }
  function start(p) {
    stop();
    profile = p;
    stopped = false;
    retryAttempt = 0;
    launch();
  }
  function launch() {
    if (stopped || !profile) return;
    const args = buildSshArgs(profile);
    child = spawnSsh(args);
    let errTail = "";
    child.stderr?.on("data", (d) => {
      errTail = (errTail + d.toString()).split("\n").slice(-3).join("\n");
    });
    child.on("exit", (code, signal) => {
      if (stopped) return;
      lastExitDetail = `ssh exited (${signal ?? code})${errTail ? `: ${errTail.split("\n")[0]}` : ""}`;
      child = void 0;
      const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 5), RETRY_MAX_MS);
      retryAttempt += 1;
      retryTimer = setTimeout(launch, delay);
      retryTimer.unref?.();
    });
  }
  function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = void 0;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      child = void 0;
    }
    profile = void 0;
  }
  async function statusProbed() {
    if (!profile) return status();
    const s = status();
    if (s.tunnel !== "up") return s;
    const reachable = await probeEngine(profile.localPort).catch(() => false);
    return { ...s, engine: reachable ? "reachable" : "unreachable" };
  }
  return { start, stop, status, statusProbed, get profile() {
    return profile;
  }, activeProfile: () => profile };
}
function defaultProbeEngine(port, timeoutMs = 4e3) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/global/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== void 0 && res.statusCode > 0);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

// src/service/remote-fs.ts
import { spawn as spawn2 } from "node:child_process";
function sshExec(p, command, opts = {}) {
  return new Promise((resolve) => {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=no",
      "-p",
      String(p.port || 22)
    ];
    if (p.keyPath) args.push("-i", p.keyPath);
    args.push(`${p.user}@${p.host}`, command);
    const child = spawn2("ssh", args, { stdio: opts.stdin === void 0 ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cap = opts.maxStdout ?? 512 * 1024;
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : void 0;
    child.stdout?.on("data", (d) => {
      if (stdout.length < cap) stdout += d.toString();
      else truncated = true;
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}
${err.message}`.trim() });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: truncated ? stdout + "\n\u2026[truncated]" : stdout, stderr });
    });
    if (opts.stdin !== void 0) child.stdin?.end(opts.stdin);
  });
}
function normalizeVirtualPath(vpath) {
  if (typeof vpath !== "string" || !vpath.startsWith("/")) return null;
  const norm = vpath.replace(/\/+/g, "/");
  if (norm.split("/").includes("..")) return null;
  return norm;
}
function isInsideRoots(vpath, roots) {
  const n = vpath.replace(/\/+$/, "") || "/";
  return roots.some((r) => {
    const rr = r.replace(/\/+$/, "") || "/";
    return n === rr || n.startsWith(`${rr}/`);
  });
}
function buildListScript(vpath) {
  const q5 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return [
    "set -e",
    `P=${q5(vpath)}`,
    'if [ ! -d "$P" ]; then echo "ERR: not-a-directory"; exit 0; fi',
    'cd "$P"',
    "ls -1Ap | while IFS= read -r name; do",
    '  case "$name" in',
    '    */) echo "d ${name%/}";;',
    "    *)",
    '      if [ -f "$name" ]; then',
    '        sz=$(wc -c < "$name" | tr -d " ")',
    '        echo "f $name $sz"',
    "      fi",
    "      ;;",
    "  esac",
    "done"
  ].join("\n");
}
function parseListOutput(stdout) {
  if (stdout.startsWith("ERR: not-a-directory")) return { entries: [], error: "not a directory" };
  const entries = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("d ")) entries.push({ name: t.slice(2).trim(), type: "dir" });
    else if (t.startsWith("f ")) {
      const rest = t.slice(2);
      const sp = rest.lastIndexOf(" ");
      if (sp > 0) {
        const size = Number(rest.slice(sp + 1));
        entries.push({ name: rest.slice(0, sp), type: "file", size: Number.isFinite(size) ? size : void 0 });
      } else entries.push({ name: rest, type: "file" });
    }
  }
  return { entries };
}
function buildReadScript(vpath, maxBytes) {
  const q5 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return [
    "set -e",
    `P=${q5(vpath)}`,
    'if [ ! -f "$P" ]; then echo "ERR: not-a-file"; exit 0; fi',
    `SZ=$(wc -c < "$P" | tr -d " ")`,
    'echo "SIZE:$SZ"',
    `if [ "$SZ" -gt ${maxBytes} ]; then echo "ERR: too-large:$SZ"; exit 0; fi`,
    'base64 < "$P"'
  ].join("\n");
}
function buildWriteScript(vpath, b64) {
  const q5 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const script = [
    "set -e",
    `P=${q5(vpath)}`,
    'D=$(dirname "$P")',
    'mkdir -p "$D"',
    'T=$(mktemp "$D/.ocrc-w.XXXXXX")',
    'base64 -d > "$T"',
    'if [ -f "$P" ]; then cp -p "$P" "$P.bak"; echo "bak: $P.bak"; fi',
    'mv "$T" "$P"',
    'echo "written: $P"'
  ].join("\n");
  return { script, stdin: b64 };
}
function buildStatScript(vpath) {
  const q5 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return [
    "set -e",
    `P=${q5(vpath)}`,
    'if [ -d "$P" ]; then echo "type:dir"',
    'elif [ -f "$P" ]; then',
    '  echo "type:file"',
    '  echo "size:$(wc -c < "$P" | tr -d " ")"',
    '  echo "mtime:$(stat -c %Y "$P" 2>/dev/null || stat -f %m "$P" 2>/dev/null || echo 0)"',
    'else echo "type:missing"; fi'
  ].join("\n");
}
function buildMkdirScript(vpath) {
  const q5 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return `mkdir -p ${q5(vpath)} && echo "mkdir-ok"`;
}
function buildGitScript(root, sub, args = {}) {
  const q5 = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const cd = `cd ${q5(root)} || { echo "ERR: no-root"; exit 0; }`;
  switch (sub) {
    case "status":
      return [cd, 'git status --porcelain=v1 -b 2>&1 || echo "ERR: not-a-repo"'].join("\n");
    case "diff": {
      const cap = args.maxDiff ?? 2e5;
      return [cd, `git diff --no-color ${args.paths?.length ? "-- " + args.paths.map(q5).join(" ") : ""} 2>&1 | head -c ${cap}`].join("\n");
    }
    case "log":
      return [cd, 'git log --oneline -n 30 2>&1 || echo "ERR: not-a-repo"'].join("\n");
    case "stage":
      return [cd, `git add ${args.paths?.length ? "-- " + args.paths.map(q5).join(" ") : "-A"} && echo staged`].join("\n");
    case "commit":
      return [
        cd,
        `git commit -m ${q5(args.message ?? "(no message)")} 2>&1 || { git diff --cached --quiet && echo "nothing-to-commit" || echo "ERR: commit-failed"; }`
      ].join("\n");
  }
}
function parseGitStatus(stdout) {
  if (stdout.startsWith("ERR: not-a-repo")) return { entries: [], error: "not a git repository" };
  const lines = stdout.split("\n").filter((l) => l.trim());
  let branch;
  const entries = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split(/[. ]/)[0] || void 0;
      continue;
    }
    if (line.length > 3) entries.push({ x: line[0], y: line[1], path: line.slice(3) });
  }
  return { branch, entries };
}

// src/service/config-bridge.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var BRIDGE_SECTIONS = ["agent", "agents", "mcp", "providers", "provider"];
function resolvePanelConfigPath(env = process.env, platform = process.platform) {
  const dir = env.OPENCODE_CONFIG_DIR?.trim() || (env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME.trim(), "opencode") : "") || (platform === "win32" && env.APPDATA?.trim() ? join(env.APPDATA.trim(), "opencode") : "") || join(homedir(), ".config", "opencode");
  return join(dir, "opencode.json");
}
function resolvePanelAgentsDir(env = process.env, platform = process.platform) {
  const cfg = resolvePanelConfigPath(env, platform);
  return join(cfg, "..", "agents");
}
function inspectConfigSource(env = process.env, exists = (p) => existsSync(p), read = (p) => readFileSync(p, "utf-8"), listDir = (p) => readdirSync(p), stat2 = (p) => statSync(p)) {
  const configPath = resolvePanelConfigPath(env);
  const report = { configPath, exists: exists(configPath), sections: {}, agentFiles: [] };
  if (report.exists) {
    try {
      const raw = read(configPath);
      const cfg = JSON.parse(raw.replace(/^\uFEFF/, ""));
      for (const section of BRIDGE_SECTIONS) {
        const node = cfg[section];
        if (node && typeof node === "object" && !Array.isArray(node)) {
          report.sections[section] = Object.keys(node).sort();
        }
      }
    } catch (e) {
      report.parseError = e instanceof Error ? e.message : String(e);
    }
  }
  const agentsDir = resolvePanelAgentsDir(env);
  if (exists(agentsDir)) {
    try {
      for (const name of listDir(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
        const p = join(agentsDir, name);
        try {
          report.agentFiles.push({ name: name.replace(/\.md$/, ""), path: p, size: stat2(p).size });
        } catch {
        }
      }
    } catch {
    }
  }
  return report;
}

// ../../src/core/remote-instance.ts
var PROXY_DEFAULTS = { enabled: true, localPort: 4711, remotePort: 2711, allow: [] };
var RECONNECT_DEFAULTS = { reconnect: true, restoreOnStart: true, replayQueued: false };
var DEFAULT_APP_VERSION = "2.3.3";
var DEFAULT_INSTANCE_PORT = 2610;
var DEFAULT_LOCAL_PORT2 = 4610;
function instanceIdFor(target) {
  const raw = `${target.user ? `${target.user}@` : ""}${target.host}`;
  return raw.replace(/[^A-Za-z0-9._@-]/g, "-");
}
function redactInstance(i) {
  const { uiPassword, ...rest } = i;
  return { ...rest, hasUiPassword: !!uiPassword };
}
var MIN_ENGINE_VERSION = "2.0.20";
var ENGINE_MAJOR = 2;
var DEFAULT_ENGINE_PIN = "2.0.27";
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
    return { ok: false, error: `\u76EE\u6807\u673A\u4E0A\u6CA1\u6709\u627E\u5230 opencode \u5F15\u64CE\uFF08\u5019\u9009\uFF1A${DEFAULT_ENGINE_CANDIDATES.join(", ")}\uFF09\u2014\u2014\u8BF7\u5148\u7528\u300C\u90E8\u7F72\u5F15\u64CE\u300D\u88C5\u4E00\u4EFD v2`, seen: [] };
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
function buildSshExecArgs(target, command) {
  return [
    "-o",
    "BatchMode=yes",
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
function buildDesktopHandoff(instance, status) {
  const url = `http://127.0.0.1:${instance.localPort}`;
  const running = status?.state === "online";
  const lines = [
    `\u5730\u5740 : ${url}`,
    instance.uiPassword ? `\u5BC6\u7801 : ${instance.uiPassword}` : "\u5BC6\u7801 : \uFF08\u6863\u6848\u91CC\u6CA1\u6709\uFF0C\u5148 ocrc remote add\uFF09",
    `\u7AEF\u53E3 : ${instance.localPort}\uFF08\u5BF9\u5E94\u5B9E\u4F8B\u7AEF\u53E3 ${instance.instancePort}\uFF09`,
    running ? "\u72B6\u6001 : \u5728\u7EBF\uFF0C\u53EF\u4EE5\u76F4\u63A5\u6253\u5F00" : `\u72B6\u6001 : ${status?.state ?? "unknown"}\u2014\u2014\u5148 ocrc remote up ${instance.id}`
  ];
  return {
    id: instance.id,
    url,
    uiPassword: instance.uiPassword,
    port: instance.localPort,
    instancePort: instance.instancePort,
    appVersion: instance.appVersion,
    running,
    engine: status?.engine,
    lines
  };
}
function buildForwardArgs(spec) {
  return [
    "-o",
    "BatchMode=yes",
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
  if (!payload || typeof payload !== "object") return { ok: false, error: "\u5B9E\u4F8B\u6CA1\u6709\u8FD4\u56DE\u5F15\u64CE\u517C\u5BB9\u6027" };
  const state = String(payload.state ?? "");
  const version = normalizeEngineVersion(String(payload.version ?? ""));
  const binary = String(payload.binary ?? "");
  if (state !== "compatible") {
    return { ok: false, error: `\u5B9E\u4F8B\u5F15\u64CE\u517C\u5BB9\u6027 state=${state || "\uFF08\u7A7A\uFF09"}\uFF08\u9700\u8981 compatible\uFF09` };
  }
  if (!isSupportedEngineVersion(version)) {
    return { ok: false, error: `\u5B9E\u4F8B\u7528\u7684\u5F15\u64CE ${version || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"} \u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF08\u9700 major=2 \u4E14 \u2265 ${MIN_ENGINE_VERSION}\uFF09${binary ? `\uFF1B\u4E8C\u8FDB\u5236 ${binary}` : ""}` };
  }
  if (!binary.startsWith("/")) {
    return { ok: false, error: `\u5B9E\u4F8B\u62A5\u7684\u5F15\u64CE\u8DEF\u5F84\u4E0D\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF1A${binary || "\uFF08\u7A7A\uFF09"}` };
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
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync } from "node:fs";
import { dirname, join as join4 } from "node:path";

// ../../src/utils/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync as statSync2 } from "node:fs";
import { join as join3 } from "node:path";

// ../../src/utils/paths.ts
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
function ocrcHome() {
  return process.env.OCRC_HOME ?? join2(homedir2(), ".ocrc");
}

// ../../src/utils/logger.ts
var LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function currentLevel() {
  const raw = (process.env.LOG_LEVEL ?? "warn").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}
function logFilePath() {
  return join3(ocrcHome(), "ocrc.log");
}
var DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
function maxLogBytes() {
  const raw = Number(process.env.OCRC_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LOG_BYTES;
}
function rotateIfNeeded(fp) {
  try {
    if (statSync2(fp).size >= maxLogBytes()) renameSync(fp, `${fp}.old`);
  } catch {
  }
}
var logFileReady = false;
function ensureLogFile() {
  if (logFileReady) return;
  try {
    const fp = logFilePath();
    mkdirSync(join3(fp, ".."), { recursive: true });
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

// ../../src/core/remotes.ts
import { randomBytes } from "node:crypto";
var log = createLogger("remotes");
function generateServerPassword() {
  return randomBytes(18).toString("base64url");
}

// ../../src/core/remote-instances.ts
var log2 = createLogger("remote-instances");
function remoteInstancesPath(home) {
  return join4(home, "remote-instances.json");
}
function createRemoteInstancesStore(path, opts = {}) {
  let instances = [];
  function load() {
    if (!existsSync2(path)) return;
    try {
      const raw = JSON.parse(readFileSync2(path, "utf-8"));
      if (!Array.isArray(raw.instances)) return;
      instances = raw.instances.filter((i) => i && typeof i.id === "string" && typeof i.host === "string" && i.host);
    } catch (err) {
      log2.warn(`failed to load ${path}: ${err.message}`);
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
      log2.warn(`persist failed: ${err.message}`);
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
    return {
      ...i,
      name: i.name?.trim() || void 0,
      user: i.user?.trim() || void 0,
      port: i.port > 0 ? i.port : 22,
      instancePort: i.instancePort > 0 ? i.instancePort : DEFAULT_INSTANCE_PORT,
      localPort: i.localPort > 0 ? i.localPort : DEFAULT_LOCAL_PORT2,
      appVersion: i.appVersion?.trim() || DEFAULT_APP_VERSION,
      enabled: i.enabled ?? true,
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
        existing.uiPassword ??= generateServerPassword();
        persist();
        return { ...existing };
      }
      const fresh = normalize({
        id,
        host: instance.host,
        port: instance.port ?? 22,
        user: instance.user,
        name: instance.name,
        instancePort: instance.instancePort ?? DEFAULT_INSTANCE_PORT,
        localPort: instance.localPort ?? DEFAULT_LOCAL_PORT2,
        uiPassword: instance.uiPassword || generateServerPassword(),
        enginePath: instance.enginePath,
        engineVersion: instance.engineVersion,
        appVersion: instance.appVersion ?? DEFAULT_APP_VERSION,
        enabled: instance.enabled ?? true,
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
import { spawn as spawn5 } from "node:child_process";
import net2 from "node:net";
import { openSync } from "node:fs";
import { join as join7 } from "node:path";

// ../../src/core/remote-common.ts
function parseGlibcVersion(firstLine) {
  const m = firstLine?.match(/(\d+\.\d+)/);
  return m?.[1];
}
function nextRetryDelay(attempt) {
  return Math.min(6e4, 2e3 * 2 ** Math.max(0, attempt - 1));
}

// ../../src/core/remote-instance-proxy.ts
import http2 from "node:http";
import net from "node:net";
var log3 = createLogger("remote-instance-proxy");
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
    log3.info(line);
    opts.onLog?.(line);
  };
  const server2 = http2.createServer((req, res) => {
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
    const upstream = http2.request(
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
import { spawn as spawn4 } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  rmSync as rmSync2,
  statSync as statSync3,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";

// ../../src/core/bin-cache.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2, rmSync, chmodSync } from "node:fs";
import { spawn as spawn3 } from "node:child_process";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
var log4 = createLogger("bin-cache");
var REGISTRY = "https://registry.npmjs.org";
function binCacheRoot() {
  const ocrcHome2 = process.env.OCRC_HOME ?? join5(homedir3(), ".ocrc");
  return join5(ocrcHome2, "bin-cache");
}
function npmTargetFor(platform, arch) {
  const a = arch === "arm64" || arch === "aarch64" ? "arm64" : "x64";
  return `${platform}-${a}`;
}
function verifyIntegrity(file, integrity) {
  const expected = integrity.startsWith("sha512-") ? integrity.slice(7) : integrity;
  const actual = createHash("sha512").update(readFileSync3(file)).digest("base64");
  return actual === expected;
}
function proxyAwareFetch(url, timeoutMs) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (proxy) log4.warn(`HTTPS_PROXY=${proxy} is set but not applied to registry fetch (no proxy agent dependency); direct fetch attempted`);
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
  const dir = join5(root, version);
  const dest = join5(dir, `cli-${target}-${version}.tgz`);
  if (existsSync3(dest)) {
    log4.info(`cache hit: ${dest}`);
    return dest;
  }
  mkdirSync3(dir, { recursive: true });
  const integrity = await fetchIntegrity(version, target);
  const url = `${REGISTRY}/@opencode/cli-${target}/-/cli-${target}-${version}.tgz`;
  log4.info(`downloading ${url}`);
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
    const child = spawn3("tar", [...forceLocal, "-xzf", tarPath(tgzPath), "-C", tarPath(destDir), "package/bin/opencode"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tar extract failed: ${err.trim()}`)));
  });
  const bin = join5(destDir, "package", "bin", "opencode");
  if (!existsSync3(bin)) throw new Error(`binary missing after extract: ${bin}`);
  chmodSync(bin, 493);
  return bin;
}
function readManifest() {
  const p = join5(binCacheRoot(), "manifest.json");
  if (!existsSync3(p)) return void 0;
  try {
    return JSON.parse(readFileSync3(p, "utf-8"));
  } catch {
    return void 0;
  }
}
function resolveV2Pin() {
  return readManifest()?.opencodePin ?? process.env.OCRC_V2_PIN ?? void 0;
}

// ../../src/core/remote-instance-push.ts
var log5 = createLogger("remote-instance-push");
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
  if (!existsSync4(file) || !existsSync4(marker)) return void 0;
  const sha = readFileSync4(marker, "utf-8").trim();
  if (!sha || sha512Base64(file) !== sha) return void 0;
  return { sha, shaHex: sha512Hex(file) };
}
async function ensureAppPack(appVersion, tier, opts = {}) {
  const file = appPackPath(appVersion, tier);
  const marker = `${file}.sha512`;
  if (!opts.force) {
    const cached = verifiedPack(file, marker);
    if (cached) return { file, bytes: statSync3(file).size, sha: cached.sha, shaHex: cached.shaHex, prepared: false, tier };
  }
  for (const dir of [opts.packDir, process.env.OCRC_PACK_DIR].filter((d) => !!d?.trim())) {
    const candidate = join6(dir, appPackName(appVersion, tier));
    if (!existsSync4(candidate)) continue;
    const sha = sha512Base64(candidate);
    mkdirSync4(dirname2(file), { recursive: true });
    copyFileSync(candidate, file);
    writeFileSync3(marker, `${sha}
`);
    opts.onLog?.(`\u5E94\u7528\u5305\u5DF2\u5C31\u4F4D\uFF1A${appPackName(appVersion, tier)}\uFF08\u672C\u5730\u76EE\u5F55\uFF09`);
    return { file, bytes: statSync3(file).size, sha, shaHex: sha512Hex(file), prepared: false, tier };
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
    mkdirSync4(dirname2(file), { recursive: true });
    writeFileSync3(file, bytes);
    writeFileSync3(marker, `${sha}
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
    if (existsSync4(join6(dir, "package.json"))) return dir;
  }
  return void 0;
}
function normalizeTreeLayout(treeDir) {
  const app = findAppPackageDir(treeDir);
  if (!app) throw new Error(`app package not found in tree: ${treeDir}\uFF08\u5148\u8DD1\u4EA4\u53C9\u5B89\u88C5\uFF09`);
  if (app.startsWith(join6(treeDir, "lib"))) return { appPackageDir: app, moved: false };
  const src = join6(treeDir, "node_modules");
  const dest = join6(treeDir, "lib", "node_modules");
  mkdirSync4(join6(treeDir, "lib"), { recursive: true });
  if (existsSync4(dest)) rmSync2(dest, { recursive: true, force: true });
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
  return createHash2("sha512").update(readFileSync4(file)).digest("base64");
}
function sha512Hex(file) {
  return createHash2("sha512").update(readFileSync4(file)).digest("hex");
}
function sha256Hex(file) {
  return createHash2("sha256").update(readFileSync4(file)).digest("hex");
}
function sshRun(target, command, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn4("ssh", buildSshExecArgs(target, command), { stdio: ["ignore", "pipe", "pipe"] });
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
function pushFileOverSsh(target, file, script, opts = {}) {
  return new Promise((resolve) => {
    const total = statSync3(file).size;
    let sent = 0;
    const child = spawn4("ssh", buildSshExecArgs(target, script), { stdio: ["pipe", "pipe", "pipe"] });
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
    const child = inv.needsShell ? spawn4(buildWindowsCommandLine(inv.cmd, inv.args), { cwd, shell: true, stdio: ["ignore", "ignore", "pipe"] }) : spawn4(inv.cmd, inv.args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
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
  mkdirSync4(dirname2(treeDir), { recursive: true });
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
  const fresh = existsSync4(payload) && existsSync4(marker) && statSync3(payload).mtimeMs >= statSync3(treeDir).mtimeMs;
  if (fresh && !opts.force) {
    const bytes = statSync3(payload).size;
    return { file: payload, bytes, sha: readFileSync4(marker, "utf-8").trim(), shaHex: sha512Hex(payload), prepared: false };
  }
  const inv = buildPackInvocation("tree", `app-${appVersion}.tar.gz`);
  opts.onLog?.(`$ tar czf ${payload} -C ${treeDir} .`);
  await runInvocation(inv, appCacheDir(appVersion));
  const sha = sha512Base64(payload);
  writeFileSync3(marker, `${sha}
`);
  return { file: payload, bytes: statSync3(payload).size, sha, shaHex: sha512Hex(payload), prepared: true };
}
async function ensureRuntimePayload(opts = {}) {
  const file = runtimePayloadPath();
  const sums = join6(runtimeCacheDir(), "SHASUMS256.txt");
  const marker = `${file}.sha256`;
  if (existsSync4(file) && existsSync4(marker) && !opts.force) {
    const sha2 = readFileSync4(marker, "utf-8").trim();
    if (sha256Hex(file) === sha2) return { file, bytes: statSync3(file).size, sha: sha2, shaHex: sha2, prepared: false };
    opts.onLog?.(`\u7F13\u5B58\u6821\u9A8C\u4E0D\u7B26\uFF0C\u91CD\u65B0\u53D6\u4EF6\uFF1A${file}`);
    rmSync2(file, { force: true });
  }
  mkdirSync4(runtimeCacheDir(), { recursive: true });
  const fetchTo = async (url, dest) => {
    opts.onLog?.(`$ curl -fsSL ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(6e5) });
    if (!res.ok) throw new Error(`GET ${url} \u2192 HTTP ${res.status}`);
    writeFileSync3(dest, Buffer.from(await res.arrayBuffer()));
  };
  await fetchTo(`${NODE_RUNTIME.base}/SHASUMS256.txt`, sums);
  await fetchTo(`${NODE_RUNTIME.base}/${NODE_RUNTIME.tarball}`, file);
  const expected = parseShasumsLine(readFileSync4(sums, "utf-8"), NODE_RUNTIME.tarball);
  if (!expected) throw new Error(`SHASUMS256.txt \u91CC\u6CA1\u6709 ${NODE_RUNTIME.tarball}`);
  const sha = sha256Hex(file);
  if (sha !== expected) {
    rmSync2(file, { force: true });
    throw new Error(`\u8FD0\u884C\u65F6\u5305 sha256 \u4E0D\u7B26\uFF1A\u671F\u671B ${expected.slice(0, 16)}\u2026\uFF0C\u5B9E\u5F97 ${sha.slice(0, 16)}\u2026`);
  }
  writeFileSync3(marker, `${sha}
`);
  return { file, bytes: statSync3(file).size, sha, shaHex: sha, prepared: true };
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
  if (existsSync4(bin) && existsSync4(marker) && !opts.force) {
    const sha2 = sha256Hex(bin);
    if (sha2 === readFileSync4(marker, "utf-8").trim()) {
      return { file: bin, bytes: statSync3(bin).size, sha: sha2, shaHex: sha2, prepared: false, version, target };
    }
    opts.onLog?.(`\u5F15\u64CE\u7F13\u5B58\u6821\u9A8C\u4E0D\u7B26\uFF0C\u91CD\u65B0\u53D6\u4EF6\uFF1A${bin}`);
    rmSync2(bin, { force: true });
  }
  opts.onLog?.(`$ bin-cache: @opencode/cli-${target}@${version}`);
  const tgz = await cacheArtifact(version, target);
  const extracted = await extractBinary(tgz, engineCacheDir(version, target));
  const sha = sha256Hex(extracted);
  writeFileSync3(`${extracted}.sha256`, `${sha}
`);
  return { file: extracted, bytes: statSync3(extracted).size, sha, shaHex: sha, prepared: true, version, target };
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
var log6 = createLogger("remote-instance");
var EXTERNAL_MONITOR_MS = 2e4;
var LOG_CAP = 200;
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
function instanceUrl(localPort) {
  return `http://127.0.0.1:${localPort}`;
}
function createRemoteInstanceManager(opts) {
  const runtimes = /* @__PURE__ */ new Map();
  const detachedForwards = opts.forwards === "detached";
  const externalTunnel = opts.tunnelOwner === "external";
  const forwardLogPath = opts.forwardLogPath ?? join7(opts.home ?? ocrcHome(), "remote-forward.log");
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
    log6.info(`instance ${id}: ${state}${detail ? ` \u2014 ${detail}` : ""}`);
  };
  const need = (id) => {
    const instance = opts.store.get(id);
    if (!instance) throw new Error(`unknown remote instance ${id}`);
    return instance;
  };
  const ssh = (instance, command, timeoutMs = 6e4) => sshRun(instance, command, { timeoutMs });
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
        error: `pin \u7684\u5F15\u64CE\u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF1A${parsed.map((c) => `${c.path} \u2192 ${c.raw || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"}`).join("\uFF1B") || instance.enginePath}`
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
    const relay = instance.proxy?.enabled !== false ? `http://127.0.0.1:${proxyConfig(instance).remotePort}` : void 0;
    const script = `${prefix}${buildInstanceServeCommand({
      appVersion: instance.appVersion,
      port: instance.instancePort,
      uiPassword: instance.uiPassword,
      enginePath,
      proxy: relay ? { httpProxy: relay, httpsProxy: relay } : void 0,
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
  async function stopInstance(instance) {
    const r = await ssh(instance, buildInstanceStopCommand(instance.appVersion, instance.instancePort), 45e3);
    const code = await remoteHealth(instance) === "200";
    if (code) return { ok: false, detail: `\u5B9E\u4F8B\u4ECD\u5728 :${instance.instancePort} \u4E0A\u54CD\u5E94\uFF08stop \u672A\u751F\u6548\uFF09` };
    pushLog(instance.id, `$ instance stop :${instance.instancePort}`);
    return { ok: true, detail: r.stdout.trim().split("\n").pop() || "\u5DF2\u505C" };
  }
  const proxies = /* @__PURE__ */ new Map();
  async function ensureProxy(instance) {
    const cfg = proxyConfig(instance);
    if (!cfg.enabled) return "off";
    if (proxies.has(cfg.localPort)) return "in-process";
    if (await isListening(cfg.localPort)) {
      pushLog(instance.id, `egress relay \u5DF2\u5728 :${cfg.localPort} \u4E0A\u76D1\u542C\uFF08\u5916\u90E8\u8FDB\u7A0B\uFF0C\u590D\u7528\uFF09`);
      return "external";
    }
    try {
      const proxy = await createInstanceProxy({
        port: cfg.localPort,
        allow: cfg.allow,
        onLog: (line) => pushLog(instance.id, `relay: ${line}`)
      });
      proxies.set(cfg.localPort, proxy);
      pushLog(instance.id, `egress relay \u8D77\u5728 127.0.0.1:${cfg.localPort}\uFF08\u5BF9\u7AEF\u7ECF ssh -R 127.0.0.1:${cfg.remotePort} \u8FDB\u6765\u5230\u8FD9\uFF09`);
      return "in-process";
    } catch (err) {
      pushLog(instance.id, `egress relay \u8D77\u4E0D\u6765\uFF1A${err.message}`);
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
          setState(id, "offline", "\u5BF9\u7AEF\u5B9E\u4F8B\u672A\u54CD\u5E94\uFF08reconnect \u5173\uFF0C\u4E0D\u81EA\u52A8\u91CD\u542F\uFF09");
          return;
        }
        const pick = await resolveEngine(fresh);
        if (!pick.ok) {
          setState(id, "error", `\u5F15\u64CE\u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981\uFF1A${pick.error}`);
          return;
        }
        const relay = await ensureProxy(fresh);
        if (relay !== "off") pushLog(id, `egress relay: ${relay}`);
        await ensureExternalRelayAsync(fresh);
        const started = await startInstance(fresh, pick.candidate.path);
        setState(id, started.ok ? "online" : "error", started.ok ? `\u5B9E\u4F8B\u5DF2\u91CD\u65B0\u62C9\u8D77\uFF08${instanceUrl(fresh.localPort)}\uFF09` : started.detail);
        if (started.ok) pushLog(id, started.detail);
        return;
      }
      await ensureExternalRelayAsync(fresh);
      if (here.state !== "online") setState(id, "online", "\u5BF9\u7AEF\u5C31\u7EEA\uFF08\u96A7\u9053\u7531\u684C\u9762\u7248\u6301\u6709\uFF09");
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
    const cfg = proxyConfig(instance);
    r.relayPending = true;
    let adopted = false;
    try {
      adopted = await remoteRelayPresent(instance);
    } finally {
      r.relayPending = false;
    }
    if (adopted) pushLog(instance.id, `\u8FDC\u7AEF ${cfg.remotePort} \u5DF2\u5728\u76D1\u542C\u2014\u2014\u4E3B\u96A7\u9053\u4E0D\u5E26 -R\uFF08\u590D\u7528\u65E2\u6709\u51FA\u7F51\u4E2D\u7EE7\uFF09`);
    const reverse = cfg.enabled && !adopted ? { remotePort: cfg.remotePort, localPort: cfg.localPort } : void 0;
    const args = buildForwardArgs({
      host: instance.host,
      port: instance.port,
      user: instance.user,
      localPort: instance.localPort,
      remotePort: instance.instancePort,
      reverse
    });
    pushLog(instance.id, `$ ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort}${reverse ? ` -R 127.0.0.1:${reverse.remotePort}:127.0.0.1:${reverse.localPort}` : ""} ${instance.user ? `${instance.user}@` : ""}${instance.host}`);
    const child = detachedForwards ? spawn5("ssh", args, { stdio: ["ignore", "ignore", openSync(forwardLogPath, "a")], detached: true }) : spawn5("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    r.forward = child;
    r.forwardPid = child.pid;
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
      host: instance.host,
      port: instance.port,
      user: instance.user,
      localPort: port,
      remotePort: instance.instancePort
    });
    const child = spawn5("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
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
    if (!(r.pairForward && r.pairForward.exitCode === null)) {
      const args = buildForwardArgs({
        host: instance.host,
        port: instance.port,
        user: instance.user,
        localPort: instance.localPort,
        remotePort: instance.instancePort
      });
      pushLog(instance.id, `$ ssh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort} ${instance.user ? `${instance.user}@` : ""}${instance.host}`);
      const child = spawn5("ssh", args, { stdio: ["ignore", "ignore", openSync(forwardLogPath, "a")], detached: true });
      child.unref();
      r.pairForward = child;
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
      return { ok: false, detail: `\u672C\u5730\u8F6C\u53D1 127.0.0.1:${instance.localPort} \u8D77\u4E0D\u6765\u6216\u5BF9\u7AEF\u4E0D\u53EF\u8FBE\u2014\u2014\u5148\u542F\u52A8\u5B9E\u4F8B\uFF08\u914D\u5BF9\u94FE\u63A5\u8981\u6C42\u5B83\u5728\u8DD1\uFF09` };
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
      return { ok: false, detail: `\u5BF9\u7AEF\u6CA1\u7ED9\u51FA\u914D\u5BF9\u94FE\u63A5\uFF1A${(r.stdout + r.stderr).replace(/\s+/g, " ").slice(-200)}` };
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
    const r = rt(instance.id);
    if (r.forward && r.forward.exitCode === null) return;
    if (r.relayPending) return;
    r.relayPending = true;
    try {
      if (await remoteRelayPresent(instance)) {
        pushLog(instance.id, `\u8FDC\u7AEF ${cfg.remotePort} \u5DF2\u5728\u76D1\u542C\uFF08\u51FA\u7F51\u4E2D\u7EE7\u7531\u65E2\u6709\u96A7\u9053\u63D0\u4F9B\uFF0C\u590D\u7528\uFF09`);
        return;
      }
    } finally {
      r.relayPending = false;
    }
    const args = buildRelayForwardArgs({
      host: instance.host,
      port: instance.port,
      user: instance.user,
      localPort: cfg.localPort,
      remotePort: instance.instancePort,
      reverse: { remotePort: cfg.remotePort, localPort: cfg.localPort }
    });
    pushLog(instance.id, `$ ssh -N -R 127.0.0.1:${cfg.remotePort}:127.0.0.1:${cfg.localPort} ${instance.user ? `${instance.user}@` : ""}${instance.host}`);
    const child = spawn5("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    r.forward = child;
    r.forwardPid = child.pid;
    child.stdout?.on("data", (d) => pushLog(instance.id, d.toString()));
    child.stderr?.on("data", (d) => pushLog(instance.id, d.toString()));
    child.on("error", (err) => {
      pushLog(instance.id, `ssh -R: ${err.message}`);
      setState(instance.id, "error", `\u51FA\u7F51\u4E2D\u7EE7\u8D77\u4E0D\u6765\uFF1A${err.message}`);
    });
    child.on("exit", (code) => {
      const current = rt(instance.id);
      if (current.forward === child) {
        current.forward = void 0;
        current.forwardPid = void 0;
      }
      if (current.stopping) return;
      if (code === 0) {
        setState(instance.id, "offline", "\u51FA\u7F51\u4E2D\u7EE7\u5DF2\u9000\u51FA");
        return;
      }
      try {
        opts.store.reload();
      } catch {
      }
      const fresh = opts.store.get(instance.id);
      if (!fresh?.enabled || fresh.reconnect === false) {
        setState(instance.id, "offline", `\u51FA\u7F51\u4E2D\u7EE7\u9000\u51FA\uFF08reconnect \u5173\uFF09\uFF1Aexit ${code}`);
        return;
      }
      current.forwardAttempts += 1;
      const delay = nextRetryDelay(current.forwardAttempts);
      setState(instance.id, "offline", `\u51FA\u7F51\u4E2D\u7EE7\u65AD\u5F00\uFF0C${Math.round(delay / 1e3)}s \u540E\u91CD\u8FDE\uFF08\u7B2C ${current.forwardAttempts} \u6B21\uFF09`);
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
        return { id, target, reachable: false, sshError: `ssh ${target} \u8FDE\u4E0D\u4E0A\uFF08BatchMode\uFF09`, engineCandidates: [], actions, url };
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
      if (!runtime) actions.push(`\u63A8\u9001\u8FD0\u884C\u65F6 node v${NODE_RUNTIME.version}\uFF08\u63A7\u5236\u7AEF\u5DF2\u5907\u4EF6\uFF0C\u79BB\u7EBF\uFF09`);
      if (app !== instance.appVersion) actions.push(`\u63A8\u9001\u5E94\u7528 ${instance.appVersion} \u5230 ~/.ocrc/remote/openchamber/${instance.appVersion}\uFF08\u65E7\u6811\u7559 .ocrc-bak\uFF09`);
      if (runtime && app === instance.appVersion) actions.push("\u8FD0\u884C\u65F6\u4E0E\u5E94\u7528\u90FD\u5728\u4F4D\uFF0C\u63A8\u9001\u4F1A\u8DF3\u8FC7");
      const term = rt(id).terminal;
      if (term && term.ok === false) {
        actions.push(`\u6CE8\u610F\uFF1A\u7EC8\u7AEF\u6682\u4E0D\u53EF\u7528\uFF08${term.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF09\u2014\u2014\u5B9E\u4F8B\u5176\u4F59\u529F\u80FD\u4E0D\u53D7\u5F71\u54CD`);
      }
      actions.push(pick.ok ? `\u542F\u52A8\u5B9E\u4F8B\uFF1Aserve --hostname 127.0.0.1 --port ${instance.instancePort}\uFF08\u5F15\u64CE ${pick.candidate.path} \u2192 ${pick.candidate.version}\uFF09` : `\u90E8\u7F72\u6211\u4EEC pin \u7684\u5F15\u64CE opencode ${DEFAULT_ENGINE_PIN} \u5230 ~/.ocrc/remote/engine/opencode\uFF08\u5BF9\u7AEF\u73B0\u6709 v1 \u4E00\u5F8B\u4E0D\u52A8\uFF09`);
      actions.push(`\u5EFA\u8F6C\u53D1\uFF1Assh -N -L 127.0.0.1:${instance.localPort}:127.0.0.1:${instance.instancePort} \u2192 \u6253\u5F00 ${url}`);
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
        url
      };
    },
    async apply(id, applyOpts = {}) {
      const instance = need(id);
      const inspected = await probeEnv(instance);
      const tier = applyOpts.tier ?? appPackTierForGlibc(inspected?.glibc);
      pushLog(id, `\u5E94\u7528\u5305\u6863\u4F4D\uFF1A${tier}${inspected?.glibc ? `\uFF08\u5BF9\u7AEF glibc ${inspected.glibc}\uFF09` : ""}`);
      applyOpts.onLog?.(`\u5E94\u7528\u5305\u6863\u4F4D\uFF1A${tier}${inspected?.glibc ? `\uFF08\u5BF9\u7AEF glibc ${inspected.glibc}\uFF09` : ""}`);
      const ourEngine = `${instancePaths("x").engineDir}/opencode`;
      const foreignPin = instance.enginePath && instance.enginePath !== ourEngine ? instance.enginePath : void 0;
      if (foreignPin) {
        setState(id, "provisioning", "\u65AD\u8A00 pin \u7684\u5F15\u64CE");
        const pick = await resolveEngine(instance);
        if (!pick.ok) {
          setState(id, "error", "\u5F15\u64CE\u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981");
          return { ok: false, detail: `${pick.error}\uFF08R12\uFF1A\u4E0D\u8BB8\u56DE\u843D v1\uFF09` };
        }
        rt(id).engine = { path: pick.candidate.path, version: pick.candidate.version };
      } else {
        setState(id, "provisioning", "\u63A8\u9001\u8FD0\u884C\u65F6/\u5F15\u64CE/\u5E94\u7528");
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
      const parts = `\u8FD0\u884C\u65F6\uFF1A${result.runtime.detail}\uFF1B\u5F15\u64CE\uFF1A${result.engine.detail}\uFF1B\u5E94\u7528\uFF1A${result.app.detail}`;
      setState(id, result.ok ? "offline" : "error", result.ok ? "\u88C5\u673A\u5B8C\u6210\uFF08\u672A\u542F\u52A8\uFF09" : parts);
      return { ok: result.ok, detail: parts };
    },
    async up(id, upOpts = {}) {
      const instance = need(id);
      setState(id, "starting");
      if (externalTunnel) startExternalMonitor(id);
      const pick = await resolveEngine(instance);
      if (!pick.ok) {
        setState(id, "error", "\u5F15\u64CE\u4E0D\u6EE1\u8DB3 v2 \u95E8\u7981");
        return { ok: false, detail: `${pick.error}\uFF08R12\uFF1A\u4E0D\u8BB8\u56DE\u843D v1\uFF09` };
      }
      const runtime = await ssh(instance, buildRuntimeProbeCommand(), 25e3);
      if ((runtime.stdout.trim().split("\n").pop() ?? "MISSING") === "MISSING") {
        setState(id, "error", "\u8FD0\u884C\u65F6\u7F3A\u5931");
        return { ok: false, detail: "\u76EE\u6807\u673A\u4E0A\u8FD8\u6CA1\u6709\u8FD0\u884C\u65F6/\u5E94\u7528\u2014\u2014\u5148\u8DD1 ocrc remote apply <id>" };
      }
      if (await remoteHealth(instance) !== "200") {
        const relay = await ensureProxy(instance);
        if (relay !== "off") pushLog(instance.id, `egress relay: ${relay}`);
        if (externalTunnel) ensureExternalRelay(instance);
        const started = await startInstance(instance, pick.candidate.path, upOpts.guard);
        if (!started.ok) {
          setState(id, "error", started.detail);
          return started;
        }
        pushLog(id, started.detail);
      } else {
        pushLog(id, `\u5B9E\u4F8B\u5DF2\u5728 :${instance.instancePort} \u4E0A\u670D\u52A1\uFF08\u590D\u7528\uFF0C\u4E0D\u91CD\u542F\uFF09`);
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
          if (!compat2.ok) return { ok: false, detail: `\u5B9E\u4F8B\u5728\u8DD1\uFF0C\u4F46\u5F15\u64CE\u95E8\u7981\u672A\u8FC7\uFF1A${compat2.error}` };
          return { ok: true, version: probe2.version, compat: compat2 };
        }).catch((err) => ({ ok: false, detail: err.message }));
        if (!verified.ok) {
          setState(id, "error", verified.detail);
          return { ok: false, detail: verified.detail };
        }
        const r2 = rt(id);
        r2.forwardAttempts = 0;
        r2.engine = { path: verified.compat.binary, version: verified.compat.version };
        setState(id, "online", `openchamber ${verified.version}\uFF08\u5F15\u64CE ${verified.compat.version} @ ${verified.compat.binary}\uFF1B\u96A7\u9053\u7531\u684C\u9762\u7248\u6301\u6709\uFF09`);
        return { ok: true, detail: `\u8FDC\u7AEF\u5B9E\u4F8B\u5728\u7EBF\uFF1B\u96A7\u9053\u7531\u684C\u9762\u7248\u6301\u6709\uFF08${instanceUrl(instance.localPort)}\uFF1Bopenchamber ${verified.version}\uFF0C\u5F15\u64CE ${verified.compat.version} @ ${verified.compat.binary}\uFF09` };
      }
      if (await isListening(instance.localPort)) {
        const relayLive = proxyConfig(instance).enabled ? (await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, proxyConfig(instance).remotePort), 2e4)).stdout.trim().endsWith("open") : true;
        if (relayLive) {
          pushLog(id, `\u672C\u5730 ${instance.localPort} \u5DF2\u5728\u76D1\u542C\u4E14\u5E26 -R \u4E2D\u7EE7\u2014\u2014\u590D\u7528\u8FD9\u6761\u96A7\u9053`);
        } else {
          const detail = `\u672C\u5730 127.0.0.1:${instance.localPort} \u5DF2\u88AB\u5360\u7528\uFF0C\u4F46\u5B83\u6CA1\u6709 -R \u51FA\u7F51\u4E2D\u7EE7\uFF08\u591A\u534A\u662F\u65E7\u547D\u4EE4\u7559\u4E0B\u7684\u96A7\u9053\uFF09\u2014\u2014\u5148\u505C\u6389\u5B83\u518D up`;
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
        setState(id, "error", `\u5F15\u64CE\u95E8\u7981\u672A\u8FC7\uFF1A${compat.error}`);
        return { ok: false, detail: `\u5B9E\u4F8B\u5728\u8DD1\uFF0C\u4F46\u5F15\u64CE\u95E8\u7981\u672A\u8FC7\uFF1A${compat.error}` };
      }
      const r = rt(id);
      r.forwardAttempts = 0;
      r.engine = { path: compat.binary, version: compat.version };
      setState(id, "online", `openchamber ${probe.version}\uFF08\u5F15\u64CE ${compat.version} @ ${compat.binary}\uFF09`);
      return { ok: true, detail: `online\uFF1A${instanceUrl(instance.localPort)}\uFF08openchamber ${probe.version}\uFF0C\u5F15\u64CE ${compat.version} @ ${compat.binary}\uFF09` };
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
          if (r2.state === "online") setState(id, "offline", `\u5BF9\u7AEF\u5B9E\u4F8B\u672A\u54CD\u5E94\uFF08health ${health2}\uFF09`);
          return { online: false, detail: `\u5BF9\u7AEF\u5B9E\u4F8B\u672A\u54CD\u5E94\uFF08health ${health2}\uFF09` };
        }
        await ensureExternalRelayAsync(instance);
        const relayUp = !proxyConfig(instance).enabled || (await ssh(instance, buildRemotePortProbeCommand(instance.appVersion, proxyConfig(instance).remotePort), 2e4)).stdout.trim().endsWith("open");
        if (!relayUp) return { online: false, detail: `\u5BF9\u7AEF\u5B9E\u4F8B\u5728\u8DD1\uFF0C\u4F46\u51FA\u7F51\u4E2D\u7EE7 :${proxyConfig(instance).remotePort} \u672A\u5EFA\u7ACB` };
        const r = rt(id);
        const probe2 = await withTempForward(instance, (temp) => probeThroughForward(temp)).catch(() => ({ ok: false, error: "\u4E34\u65F6\u8F6C\u53D1\u5931\u8D25" }));
        const version = probe2.ok ? probe2.version : void 0;
        const ui = await isListening(instance.localPort) ? `\uFF1B\u672C\u5730\u8F6C\u53D1 :${instance.localPort} \u4E5F\u5728\u542C` : "\uFF1B\u96A7\u9053\u7531\u684C\u9762\u7248\u6301\u6709";
        if (r.state !== "online") setState(id, "online", version ? `openchamber ${version}\uFF08\u8FDC\u7AEF\u5B9E\u6D4B\uFF09` : `\u5BF9\u7AEF\u5C31\u7EEA${ui}`);
        return { online: true, version, detail: `\u5BF9\u7AEF\u5B9E\u4F8B\u5728\u7EBF${ui}` };
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
        logTail: r?.logs.slice(-40) ?? []
      };
    },
    statusAll() {
      return opts.store.list().map((i) => manager.status(i.id)).filter((s) => !!s);
    },
    logs(id) {
      return rt(id).logs.slice(-LOG_CAP);
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
          if (!body?.host || typeof body.host !== "string") return { status: 400, body: { error: "host required" } };
          for (const [key, value] of [["port", body.port], ["instancePort", body.instancePort], ["localPort", body.localPort]]) {
            if (value != null && (!Number.isFinite(value) || value < 1 || value > 65535)) {
              return { status: 400, body: { error: `invalid ${key}` } };
            }
          }
          const saved2 = store.upsert({ ...body, host: body.host });
          return { status: 200, body: { instance: { ...redactInstance(saved2), status: statusFor(saved2.id) ?? null } } };
        }
        case "patch": {
          const updated = store.update(op.id, op.payload);
          if (!updated) return { status: 404, body: { error: "not found" } };
          return { status: 200, body: { instance: { ...redactInstance(updated), status: statusFor(updated.id) ?? null } } };
        }
        case "delete": {
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          await manager.down(op.id).catch(() => {
          });
          store.remove(op.id);
          return { status: 200, body: { ok: true } };
        }
        case "plan": {
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          return start(() => manager.plan(op.id));
        }
        case "apply": {
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          if (op.payload?.confirm !== true) {
            return { status: 409, body: { error: "confirm:true required", dryRun: true } };
          }
          return start(() => manager.apply(op.id, { force: op.payload?.force === true }));
        }
        case "up":
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          return start(() => manager.up(op.id));
        case "down":
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          return start(() => manager.down(op.id));
        case "probe":
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          return start(() => manager.probe(op.id));
        case "status": {
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          const status = statusFor(op.id);
          if (!status) return { status: 404, body: { error: "not found" } };
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
          if (!store.get(op.id)) return { status: 404, body: { error: "not found" } };
          const lines = manager.logs(op.id);
          const tail = Number(op.tail ?? 100);
          return { status: 200, body: { lines: Number.isFinite(tail) && tail > 0 ? lines.slice(-tail) : lines } };
        }
        case "url": {
          const instance = store.get(op.id);
          if (!instance) return { status: 404, body: { error: "not found" } };
          return {
            status: 200,
            body: { url: `http://127.0.0.1:${instance.localPort}`, online: manager.status(op.id)?.state === "online" }
          };
        }
        case "connect": {
          const instance = store.get(op.id);
          if (!instance) return { status: 404, body: { error: "not found" } };
          const { uiPassword, lines, ...handoff } = buildDesktopHandoff(instance, manager.status(instance.id) ?? void 0);
          return {
            status: 200,
            body: {
              handoff: {
                ...handoff,
                hasUiPassword: !!uiPassword,
                lines: lines.map((l) => l.replace(/^密码 : .*$/, "\u5BC6\u7801 : \uFF08\u89C1\u672C\u673A ocrc remote connect\uFF09"))
              }
            }
          };
        }
        case "job": {
          const job = jobs.get(op.jobId);
          if (!job) return { status: 404, body: { error: "not found" } };
          return {
            status: 200,
            body: {
              job: { state: job.state, result: job.result, error: job.error, startedAt: job.startedAt }
            }
          };
        }
        default:
          return { status: 400, body: { error: "unknown op" } };
      }
    },
    dispose() {
      jobs.clear();
    }
  };
}

// src/service/omo-schema.ts
var OMO_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "preset": {
      "type": "string"
    },
    "setDefaultAgent": {
      "type": "boolean"
    },
    "compactSidebar": {
      "description": "Use the compact TUI sidebar layout. Defaults to true; set false to use the expanded layout.",
      "type": "boolean"
    },
    "stripOrchestratorModel": {
      "description": "When true, omit orchestrator.model and orchestrator.variant from the SDK config so OpenCode uses the session model selected with /model after subagent dispatch. An explicitly selected preset that sets orchestrator.model is preserved. Defaults to false.",
      "type": "boolean"
    },
    "routingBlock": {
      "description": "When false, removes the <Agents> routing block from the v2 orchestrator prompt. The host's native subagent roster (appended to the subagent tool description) still lists every enabled agent, but it carries no Delegate/Don't routing criteria \u2014 set false only to drop stock routing claims that drift against custom agent prompts, or to trim tokens. Ignored with a warning on v1 hosts, where the orchestrator prompt is a frozen template; use an orchestrator.md override there. No effect when an orchestrator.md override already replaces the whole prompt. Defaults to true.",
      "type": "boolean"
    },
    "autoUpdate": {
      "description": "Disable automatic installation of plugin updates when false. Defaults to true.",
      "type": "boolean"
    },
    "presets": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "extends": {
                "type": "string",
                "minLength": 1
              },
              "agents": {
                "type": "object",
                "propertyNames": {
                  "type": "string"
                },
                "additionalProperties": {
                  "type": "object",
                  "properties": {
                    "model": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "minItems": 1,
                          "type": "array",
                          "items": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "type": "string"
                                  },
                                  "variant": {
                                    "type": "string"
                                  }
                                },
                                "required": [
                                  "id"
                                ]
                              }
                            ]
                          }
                        }
                      ]
                    },
                    "inheritModelFrom": {
                      "type": "string",
                      "enum": [
                        "session",
                        "orchestrator"
                      ]
                    },
                    "temperature": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 2
                    },
                    "variant": {
                      "type": "string"
                    },
                    "skills": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "skills_add": {
                      "description": "Skill names to add to this agent's effective skills list. Applied after the resolved `skills` list during config resolution; removal via `skills_remove` wins. Folded into `skills` at resolution time.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "skills_remove": {
                      "description": "Skill names to remove from this agent's effective skills list. Applied after `skills_add` during config resolution, so removal wins over addition. Folded into `skills` at resolution time.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "skills_include_local": {
                      "description": "When true, adds valid skills from the current/ancestor project `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees to this agent's effective skills before `skills_remove`. Global and external skill sources are excluded.",
                      "type": "boolean"
                    },
                    "mcps": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "prompt": {
                      "type": "string",
                      "minLength": 1
                    },
                    "orchestratorPrompt": {
                      "type": "string",
                      "minLength": 1
                    },
                    "options": {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "displayName": {
                      "type": "string",
                      "minLength": 1
                    },
                    "color": {
                      "description": "Agent display color as #RRGGBB or an OpenCode theme color",
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^#[0-9a-fA-F]{6}$"
                        },
                        {
                          "type": "string",
                          "enum": [
                            "primary",
                            "secondary",
                            "accent",
                            "success",
                            "warning",
                            "error",
                            "info"
                          ]
                        }
                      ]
                    },
                    "description": {
                      "type": "string",
                      "minLength": 1
                    },
                    "permission": {
                      "anyOf": [
                        {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        {
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {
                            "anyOf": [
                              {
                                "type": "string",
                                "enum": [
                                  "ask",
                                  "allow",
                                  "deny"
                                ]
                              },
                              {
                                "type": "object",
                                "propertyNames": {
                                  "type": "string"
                                },
                                "additionalProperties": {
                                  "type": "string",
                                  "enum": [
                                    "ask",
                                    "allow",
                                    "deny"
                                  ]
                                }
                              }
                            ]
                          }
                        }
                      ]
                    }
                  },
                  "additionalProperties": false
                }
              },
              "marketplace": {
                "type": "object",
                "properties": {
                  "agents": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                    }
                  },
                  "agents_add": {
                    "description": "Package IDs to add to the inherited marketplace agents list after optional agents replacement.",
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                    }
                  },
                  "agents_remove": {
                    "description": "Package IDs to remove after additions; removal wins over addition.",
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                    }
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "agents"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "extends": {
                "type": "string",
                "minLength": 1
              },
              "marketplace": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "agents": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                        }
                      },
                      "agents_add": {
                        "description": "Package IDs to add to the inherited marketplace agents list after optional agents replacement.",
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                        }
                      },
                      "agents_remove": {
                        "description": "Package IDs to remove after additions; removal wins over addition.",
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                        }
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "model": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "minItems": 1,
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "id": {
                                      "type": "string"
                                    },
                                    "variant": {
                                      "type": "string"
                                    }
                                  },
                                  "required": [
                                    "id"
                                  ]
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "inheritModelFrom": {
                        "type": "string",
                        "enum": [
                          "session",
                          "orchestrator"
                        ]
                      },
                      "temperature": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "variant": {
                        "type": "string"
                      },
                      "skills": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skills_add": {
                        "description": "Skill names to add to this agent's effective skills list. Applied after the resolved `skills` list during config resolution; removal via `skills_remove` wins. Folded into `skills` at resolution time.",
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skills_remove": {
                        "description": "Skill names to remove from this agent's effective skills list. Applied after `skills_add` during config resolution, so removal wins over addition. Folded into `skills` at resolution time.",
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skills_include_local": {
                        "description": "When true, adds valid skills from the current/ancestor project `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees to this agent's effective skills before `skills_remove`. Global and external skill sources are excluded.",
                        "type": "boolean"
                      },
                      "mcps": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "prompt": {
                        "type": "string",
                        "minLength": 1
                      },
                      "orchestratorPrompt": {
                        "type": "string",
                        "minLength": 1
                      },
                      "options": {
                        "type": "object",
                        "propertyNames": {
                          "type": "string"
                        },
                        "additionalProperties": {}
                      },
                      "displayName": {
                        "type": "string",
                        "minLength": 1
                      },
                      "color": {
                        "description": "Agent display color as #RRGGBB or an OpenCode theme color",
                        "anyOf": [
                          {
                            "type": "string",
                            "pattern": "^#[0-9a-fA-F]{6}$"
                          },
                          {
                            "type": "string",
                            "enum": [
                              "primary",
                              "secondary",
                              "accent",
                              "success",
                              "warning",
                              "error",
                              "info"
                            ]
                          }
                        ]
                      },
                      "description": {
                        "type": "string",
                        "minLength": 1
                      },
                      "permission": {
                        "anyOf": [
                          {
                            "type": "string",
                            "enum": [
                              "ask",
                              "allow",
                              "deny"
                            ]
                          },
                          {
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "enum": [
                                    "ask",
                                    "allow",
                                    "deny"
                                  ]
                                },
                                {
                                  "type": "object",
                                  "propertyNames": {
                                    "type": "string"
                                  },
                                  "additionalProperties": {
                                    "type": "string",
                                    "enum": [
                                      "ask",
                                      "allow",
                                      "deny"
                                    ]
                                  }
                                }
                              ]
                            }
                          }
                        ]
                      }
                    },
                    "additionalProperties": false
                  }
                ]
              }
            },
            "required": [
              "extends"
            ],
            "additionalProperties": {
              "type": "object",
              "properties": {
                "model": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string"
                              },
                              "variant": {
                                "type": "string"
                              }
                            },
                            "required": [
                              "id"
                            ]
                          }
                        ]
                      }
                    }
                  ]
                },
                "inheritModelFrom": {
                  "type": "string",
                  "enum": [
                    "session",
                    "orchestrator"
                  ]
                },
                "temperature": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 2
                },
                "variant": {
                  "type": "string"
                },
                "skills": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "skills_add": {
                  "description": "Skill names to add to this agent's effective skills list. Applied after the resolved `skills` list during config resolution; removal via `skills_remove` wins. Folded into `skills` at resolution time.",
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "skills_remove": {
                  "description": "Skill names to remove from this agent's effective skills list. Applied after `skills_add` during config resolution, so removal wins over addition. Folded into `skills` at resolution time.",
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "skills_include_local": {
                  "description": "When true, adds valid skills from the current/ancestor project `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees to this agent's effective skills before `skills_remove`. Global and external skill sources are excluded.",
                  "type": "boolean"
                },
                "mcps": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "prompt": {
                  "type": "string",
                  "minLength": 1
                },
                "orchestratorPrompt": {
                  "type": "string",
                  "minLength": 1
                },
                "options": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                },
                "displayName": {
                  "type": "string",
                  "minLength": 1
                },
                "color": {
                  "description": "Agent display color as #RRGGBB or an OpenCode theme color",
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^#[0-9a-fA-F]{6}$"
                    },
                    {
                      "type": "string",
                      "enum": [
                        "primary",
                        "secondary",
                        "accent",
                        "success",
                        "warning",
                        "error",
                        "info"
                      ]
                    }
                  ]
                },
                "description": {
                  "type": "string",
                  "minLength": 1
                },
                "permission": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "ask",
                        "allow",
                        "deny"
                      ]
                    },
                    {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "anyOf": [
                          {
                            "type": "string",
                            "enum": [
                              "ask",
                              "allow",
                              "deny"
                            ]
                          },
                          {
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {
                              "type": "string",
                              "enum": [
                                "ask",
                                "allow",
                                "deny"
                              ]
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              },
              "additionalProperties": false
            }
          },
          {
            "type": "object",
            "properties": {
              "marketplace": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "agents": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                        }
                      },
                      "agents_add": {
                        "description": "Package IDs to add to the inherited marketplace agents list after optional agents replacement.",
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                        }
                      },
                      "agents_remove": {
                        "description": "Package IDs to remove after additions; removal wins over addition.",
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._-]{0,63}$"
                        }
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "model": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "minItems": 1,
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "id": {
                                      "type": "string"
                                    },
                                    "variant": {
                                      "type": "string"
                                    }
                                  },
                                  "required": [
                                    "id"
                                  ]
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "inheritModelFrom": {
                        "type": "string",
                        "enum": [
                          "session",
                          "orchestrator"
                        ]
                      },
                      "temperature": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "variant": {
                        "type": "string"
                      },
                      "skills": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skills_add": {
                        "description": "Skill names to add to this agent's effective skills list. Applied after the resolved `skills` list during config resolution; removal via `skills_remove` wins. Folded into `skills` at resolution time.",
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skills_remove": {
                        "description": "Skill names to remove from this agent's effective skills list. Applied after `skills_add` during config resolution, so removal wins over addition. Folded into `skills` at resolution time.",
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skills_include_local": {
                        "description": "When true, adds valid skills from the current/ancestor project `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees to this agent's effective skills before `skills_remove`. Global and external skill sources are excluded.",
                        "type": "boolean"
                      },
                      "mcps": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "prompt": {
                        "type": "string",
                        "minLength": 1
                      },
                      "orchestratorPrompt": {
                        "type": "string",
                        "minLength": 1
                      },
                      "options": {
                        "type": "object",
                        "propertyNames": {
                          "type": "string"
                        },
                        "additionalProperties": {}
                      },
                      "displayName": {
                        "type": "string",
                        "minLength": 1
                      },
                      "color": {
                        "description": "Agent display color as #RRGGBB or an OpenCode theme color",
                        "anyOf": [
                          {
                            "type": "string",
                            "pattern": "^#[0-9a-fA-F]{6}$"
                          },
                          {
                            "type": "string",
                            "enum": [
                              "primary",
                              "secondary",
                              "accent",
                              "success",
                              "warning",
                              "error",
                              "info"
                            ]
                          }
                        ]
                      },
                      "description": {
                        "type": "string",
                        "minLength": 1
                      },
                      "permission": {
                        "anyOf": [
                          {
                            "type": "string",
                            "enum": [
                              "ask",
                              "allow",
                              "deny"
                            ]
                          },
                          {
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "enum": [
                                    "ask",
                                    "allow",
                                    "deny"
                                  ]
                                },
                                {
                                  "type": "object",
                                  "propertyNames": {
                                    "type": "string"
                                  },
                                  "additionalProperties": {
                                    "type": "string",
                                    "enum": [
                                      "ask",
                                      "allow",
                                      "deny"
                                    ]
                                  }
                                }
                              ]
                            }
                          }
                        ]
                      }
                    },
                    "additionalProperties": false
                  }
                ]
              }
            },
            "additionalProperties": {
              "type": "object",
              "properties": {
                "model": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string"
                              },
                              "variant": {
                                "type": "string"
                              }
                            },
                            "required": [
                              "id"
                            ]
                          }
                        ]
                      }
                    }
                  ]
                },
                "inheritModelFrom": {
                  "type": "string",
                  "enum": [
                    "session",
                    "orchestrator"
                  ]
                },
                "temperature": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 2
                },
                "variant": {
                  "type": "string"
                },
                "skills": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "skills_add": {
                  "description": "Skill names to add to this agent's effective skills list. Applied after the resolved `skills` list during config resolution; removal via `skills_remove` wins. Folded into `skills` at resolution time.",
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "skills_remove": {
                  "description": "Skill names to remove from this agent's effective skills list. Applied after `skills_add` during config resolution, so removal wins over addition. Folded into `skills` at resolution time.",
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "skills_include_local": {
                  "description": "When true, adds valid skills from the current/ancestor project `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees to this agent's effective skills before `skills_remove`. Global and external skill sources are excluded.",
                  "type": "boolean"
                },
                "mcps": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "prompt": {
                  "type": "string",
                  "minLength": 1
                },
                "orchestratorPrompt": {
                  "type": "string",
                  "minLength": 1
                },
                "options": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                },
                "displayName": {
                  "type": "string",
                  "minLength": 1
                },
                "color": {
                  "description": "Agent display color as #RRGGBB or an OpenCode theme color",
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^#[0-9a-fA-F]{6}$"
                    },
                    {
                      "type": "string",
                      "enum": [
                        "primary",
                        "secondary",
                        "accent",
                        "success",
                        "warning",
                        "error",
                        "info"
                      ]
                    }
                  ]
                },
                "description": {
                  "type": "string",
                  "minLength": 1
                },
                "permission": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "ask",
                        "allow",
                        "deny"
                      ]
                    },
                    {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "anyOf": [
                          {
                            "type": "string",
                            "enum": [
                              "ask",
                              "allow",
                              "deny"
                            ]
                          },
                          {
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {
                              "type": "string",
                              "enum": [
                                "ask",
                                "allow",
                                "deny"
                              ]
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              },
              "additionalProperties": false
            }
          }
        ]
      }
    },
    "agents": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "model": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "minItems": 1,
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "variant": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "id"
                      ]
                    }
                  ]
                }
              }
            ]
          },
          "inheritModelFrom": {
            "type": "string",
            "enum": [
              "session",
              "orchestrator"
            ]
          },
          "temperature": {
            "type": "number",
            "minimum": 0,
            "maximum": 2
          },
          "variant": {
            "type": "string"
          },
          "skills": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "skills_add": {
            "description": "Skill names to add to this agent's effective skills list. Applied after the resolved `skills` list during config resolution; removal via `skills_remove` wins. Folded into `skills` at resolution time.",
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "skills_remove": {
            "description": "Skill names to remove from this agent's effective skills list. Applied after `skills_add` during config resolution, so removal wins over addition. Folded into `skills` at resolution time.",
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "skills_include_local": {
            "description": "When true, adds valid skills from the current/ancestor project `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees to this agent's effective skills before `skills_remove`. Global and external skill sources are excluded.",
            "type": "boolean"
          },
          "mcps": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "prompt": {
            "type": "string",
            "minLength": 1
          },
          "orchestratorPrompt": {
            "type": "string",
            "minLength": 1
          },
          "options": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          },
          "displayName": {
            "type": "string",
            "minLength": 1
          },
          "color": {
            "description": "Agent display color as #RRGGBB or an OpenCode theme color",
            "anyOf": [
              {
                "type": "string",
                "pattern": "^#[0-9a-fA-F]{6}$"
              },
              {
                "type": "string",
                "enum": [
                  "primary",
                  "secondary",
                  "accent",
                  "success",
                  "warning",
                  "error",
                  "info"
                ]
              }
            ]
          },
          "description": {
            "type": "string",
            "minLength": 1
          },
          "permission": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "ask",
                  "allow",
                  "deny"
                ]
              },
              {
                "type": "object",
                "propertyNames": {
                  "type": "string"
                },
                "additionalProperties": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "ask",
                        "allow",
                        "deny"
                      ]
                    },
                    {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "type": "string",
                        "enum": [
                          "ask",
                          "allow",
                          "deny"
                        ]
                      }
                    }
                  ]
                }
              }
            ]
          }
        },
        "additionalProperties": false
      }
    },
    "disabled_agents": {
      "description": "Agent names to disable completely. Disabled agents are not instantiated and cannot be delegated to. Orchestrator and council internal agents (councillor) cannot be disabled. By default, 'observer' is disabled. Remove it from this list and configure a vision-capable model to enable.",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "image_routing": {
      "description": 'How image attachments are handled. When omitted, preserves legacy conditional behavior: intercept attachments only when observer is enabled. "auto": requires observer to be enabled and saves attachments to disk before nudging delegation to @observer. "direct": always passes attachments to the orchestrator untouched.',
      "type": "string",
      "enum": [
        "auto",
        "direct"
      ]
    },
    "deepworkGuardMode": {
      "description": 'Deepwork guard mode. "shadow" (default) records receipts and claim markers under .slim/deepwork/.runtime/ but never blocks; "enforce" additionally blocks completion writes whose tombstone references artifacts with no recorded receipt. The guard itself is disabled by listing "deepwork-guard" in disabled_hooks.',
      "type": "string",
      "enum": [
        "shadow",
        "enforce"
      ]
    },
    "disabled_mcps": {
      "description": "MCP server names to disable completely. Disabled servers are not started and cannot be used by agents.",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "disabled_tools": {
      "description": "Tool names to disable completely. Disabled tools are not registered with OpenCode and cannot be used by agents.",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "disabled_skills": {
      "description": "Skill names to disable completely. Disabled skills are not granted to agents, even when referenced by presets or agent overrides.",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "disabled_hooks": {
      "description": `Hook names to disable completely. Valid values: phase-reminder, foreground-fallback, deepwork-guard, deepwork-goal, chat-headers, cache-monitor, json-error-recovery, tool-loop-guard, search-path-guard, absolute-path-rescue, apply-patch, council-inject. "phase-reminder" is not registered, so orchestrator phase reminders are never injected; "foreground-fallback" marks the fallback manager inert: it is still constructed but never triggers automatic intervention, same effect as fallback.enabled = false; "chat-headers" is not registered, so the Copilot x-initiator header is never stamped (v1 chat.headers and the v2 model.request bridge); "cache-monitor" stops the prompt-cache bust watchdog, so cache warnings are never logged; the on-demand tool guards ("json-error-recovery", "tool-loop-guard", "search-path-guard", "absolute-path-rescue", "apply-patch") stop intercepting tool calls entirely, so malformed output, repeated identical calls, and invalid or guessed paths surface raw to the model; "council-inject" is not registered, so the keyword-triggered Council Mode injection is never appended to orchestrator messages. Unknown values are stripped with a warning when the config loads. A value consisting only of unknown names is treated as unset, so a lower config layer's list still applies.`,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "phase-reminder",
          "foreground-fallback",
          "deepwork-guard",
          "deepwork-goal",
          "chat-headers",
          "cache-monitor",
          "json-error-recovery",
          "tool-loop-guard",
          "search-path-guard",
          "absolute-path-rescue",
          "apply-patch",
          "council-inject"
        ]
      }
    },
    "disabled_commands": {
      "description": `Slash-command names to disable completely. Valid values: implement, interview, deepwork, reflect, loop. Disabled commands are neither registered nor intercepted at execution time, so a user-defined command with the same name is left untouched. The /reflect command is also disabled when "reflect" is listed in disabled_skills. Unknown values are stripped with a warning when the config loads. A value consisting only of unknown names is treated as unset, so a lower config layer's list still applies.`,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "implement",
          "interview",
          "deepwork",
          "reflect",
          "loop"
        ]
      }
    },
    "multiplexer": {
      "type": "object",
      "properties": {
        "type": {
          "default": "none",
          "type": "string",
          "enum": [
            "auto",
            "tmux",
            "zellij",
            "herdr",
            "kitty",
            "cmux-tui",
            "none"
          ]
        },
        "layout": {
          "default": "main-vertical",
          "type": "string",
          "enum": [
            "main-horizontal",
            "main-vertical",
            "tiled",
            "even-horizontal",
            "even-vertical"
          ]
        },
        "main_pane_size": {
          "default": 60,
          "type": "number",
          "minimum": 20,
          "maximum": 80
        },
        "cmux_tui_binary": {
          "description": "Explicit path to the cmux-tui binary. When unset, the adapter probes PATH for `cmux-tui` first and falls back to `cmux`.",
          "type": "string",
          "minLength": 1
        },
        "viewer": {
          "description": 'Which opencode TUI surface subagent panes open. Defaults to "tui" on OpenCode v1 and "mini" on v2. "mini" uses `attach ... --mini` on v1 (requires OpenCode >= 1.17.10) and `opencode mini` on v2; "tui" runs the full interface.',
          "type": "string",
          "enum": [
            "tui",
            "mini"
          ]
        }
      }
    },
    "interview": {
      "type": "object",
      "properties": {
        "maxQuestions": {
          "default": 2,
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "outputFolder": {
          "default": "interview",
          "type": "string",
          "minLength": 1,
          "pattern": "^(?![\\\\/])(?![A-Za-z]:[\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$"
        },
        "autoOpenBrowser": {
          "default": true,
          "description": "Automatically open the interview UI in your default browser during interactive runs. Disabled automatically in tests and CI.",
          "type": "boolean"
        },
        "port": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 65535
        },
        "dashboard": {
          "default": false,
          "type": "boolean"
        },
        "printState": {
          "default": false,
          "description": "When true, the interview model prints the full <interview_state> block in the TUI instead of submitting state through the interview_submit_state tool.",
          "type": "boolean"
        }
      }
    },
    "backgroundJobs": {
      "type": "object",
      "properties": {
        "strategy": {
          "default": "latest",
          "description": 'Board injection strategy. "latest" retains and replays one frozen board part per eligible turn without a cap; unchanged boards use a short marker for up to nine turns, then a full board. "checkpoint-compatible" appends only changed snapshots with a bounded cache epoch.',
          "type": "string",
          "enum": [
            "latest",
            "checkpoint-compatible"
          ]
        },
        "maxSessionsPerAgent": {
          "default": 2,
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "maxContextLines": {
          "default": 5e4,
          "type": "integer",
          "minimum": 0,
          "maximum": 5e5
        },
        "readContextMinLines": {
          "default": 10,
          "type": "integer",
          "minimum": 0,
          "maximum": 1e3
        },
        "readContextMaxFiles": {
          "default": 8,
          "type": "integer",
          "minimum": 0,
          "maximum": 50
        },
        "maxRetainedSnapshots": {
          "default": 20,
          "description": "Maximum board snapshots retained per checkpoint cache epoch (1\u2013100). Exceeding the limit starts a new epoch with the current snapshot and intentionally creates one cache miss.",
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "orchestratorWake": {
          "default": {
            "enabled": true,
            "intervalMs": 3e5,
            "mode": "auto",
            "periodicWakeEnabled": true,
            "wakeOnTerminalPublication": true,
            "publicationWakeMinIntervalMs": 3e4
          },
          "description": "Periodic orchestrator wake scheduler for idle sessions. v1: requires host session APIs (session.get, todo, children, status, promptAsync) and wakes while incomplete todos remain. v2: runs in children-driven degraded mode (requires session.list + promptAsync) and wakes while un-finished child sessions remain. Default enabled at a 5-minute interval.",
          "type": "object",
          "properties": {
            "enabled": {
              "default": true,
              "description": "When true, idle orchestrator sessions with incomplete todos may receive periodic internal wake prompts. Default enabled.",
              "type": "boolean"
            },
            "intervalMs": {
              "default": 3e5,
              "description": "Continuous parent-idle interval between orchestrator wake evaluations (60,000\u20132,147,483,647ms). Default 300,000 (5 minutes). 0 is invalid.",
              "type": "integer",
              "minimum": 6e4,
              "maximum": 2147483647
            },
            "mode": {
              "default": "auto",
              "description": 'Wake-condition source. "auto" uses todo-gating on v1 hosts and children-driven degraded mode on v2 hosts (no todo surface there); "todo" or "children" pin one mode, degrading to children when the host lacks the todo API. Default "auto".',
              "type": "string",
              "enum": [
                "auto",
                "todo",
                "children"
              ]
            },
            "periodicWakeEnabled": {
              "default": true,
              "description": "When false, the periodic idle evaluation never runs; only event-driven wakes (stopped-job recovery, terminal-publication rev>1, child-input) still deliver. Failed event wakes keep their timer-based retry path. Default enabled; v2 hosts derive a disabled default when the key is not explicitly configured.",
              "type": "boolean"
            },
            "wakeOnTerminalPublication": {
              "default": true,
              "description": "When true, a terminal completed/error publication wakes an idle parent orchestrator immediately (bounded by publicationWakeMinIntervalMs) instead of waiting for the next periodic evaluation. Busy parents are skipped: the native steer already delivered the completion. Default enabled.",
              "type": "boolean"
            },
            "publicationWakeMinIntervalMs": {
              "default": 3e4,
              "description": "Per-parent minimum spacing between terminal-publication wakes (1,000\u20132,147,483,647ms; 0 is invalid at the config layer). Default 30,000 (30 seconds). A burst of publications collapses into one wake.",
              "type": "integer",
              "minimum": 1e3,
              "maximum": 2147483647
            }
          }
        },
        "wallClockTimeoutMs": {
          "default": 0,
          "description": "Explicit opt-in wall-clock deadline for native task(..., background: true) child sessions. 0 disables supervision; finite values are 60,000\u20132,147,483,647ms.",
          "anyOf": [
            {
              "type": "number",
              "const": 0
            },
            {
              "type": "integer",
              "minimum": 6e4,
              "maximum": 2147483647
            }
          ]
        },
        "abortGraceMs": {
          "default": 1e4,
          "description": "Grace period after a wall-clock deadline while OpenCode confirms the child terminal state (1,000\u201360,000ms).",
          "type": "integer",
          "minimum": 1e3,
          "maximum": 6e4
        },
        "stopConfirmationMs": {
          "default": 5e3,
          "description": "Terminal-gate grace period the background-job terminal gate waits for stop confirmation evidence before publishing a stopped job (1,000\u201360,000ms). Default 5,000 (5 seconds).",
          "type": "integer",
          "minimum": 1e3,
          "maximum": 6e4
        },
        "concurrency": {
          "default": {
            "defaultConcurrency": 0,
            "providerConcurrency": {},
            "modelConcurrency": {}
          },
          "type": "object",
          "properties": {
            "defaultConcurrency": {
              "default": 0,
              "description": "Maximum concurrently running native background tasks. 0 disables the default cap.",
              "type": "integer",
              "minimum": 0,
              "maximum": 1e3
            },
            "providerConcurrency": {
              "default": {},
              "description": "Per-provider concurrency caps keyed by provider ID. The most specific configured cap wins: model > provider > default. 0 means unlimited for that provider.",
              "type": "object",
              "propertyNames": {
                "type": "string",
                "minLength": 1
              },
              "additionalProperties": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1e3
              }
            },
            "modelConcurrency": {
              "default": {},
              "description": "Per-model concurrency caps keyed by provider/model ID. The most specific configured cap wins: model > provider > default. 0 means unlimited for that model.",
              "type": "object",
              "propertyNames": {
                "type": "string",
                "minLength": 1
              },
              "additionalProperties": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1e3
              }
            }
          },
          "additionalProperties": false
        },
        "sameProviderPolicy": {
          "default": {},
          "description": 'Opt-in per-provider policy for native background tasks: when the parent session and the child agent both resolve to a provider listed here with value "foreground", the background request is converted to foreground execution (existing foreground path, no concurrency admission). Unlisted or unknown providers keep background behavior. Default {} (no conversion).',
          "type": "object",
          "propertyNames": {
            "type": "string",
            "minLength": 1
          },
          "additionalProperties": {
            "type": "string",
            "const": "foreground"
          }
        },
        "waitForUserGuard": {
          "default": true,
          "description": "When true, intercept wait_for_user calls made while background tasks are still running and the orchestrator wake scheduler is enabled, returning guidance to end the turn instead of blocking on manual input. Default enabled.",
          "type": "boolean"
        },
        "boardInjection": {
          "default": true,
          "description": "When false, the Background Job Board reminder is never injected into prompts. Background task tracking, wake, and task_status all keep working; the orchestrator simply no longer passively sees the board. Default enabled; v2 hosts derive a disabled default when the key is not explicitly configured.",
          "type": "boolean"
        },
        "childInputWake": {
          "default": true,
          "description": "When true, a background child that asks a question or permission request wakes its parent with the ask content. Permissions can be answered with task_reply when the host exposes permission.reply; OpenCode v2 form questions are observable but not answerable through the pinned plugin context. Default enabled.",
          "type": "boolean"
        },
        "pruneEvictedSessions": {
          "default": false,
          "description": "When true, removes the host child session when a retention trim evicts its terminal or retained-stopped record, only for background children this plugin launched itself (never foreground, unattributed placeholder, adopted, or restored sessions) and only after a host read confirms the session still belongs to the record parent. Never fires for parent deletion or explicit drops. v1 hosts only for now (v2 has no live session-status map, so every prune is skipped). Default disabled.",
          "type": "boolean"
        }
      }
    },
    "fallback": {
      "type": "object",
      "properties": {
        "enabled": {
          "default": true,
          "type": "boolean"
        },
        "maxRetries": {
          "default": 3,
          "description": "Number of current-model retries allowed before Slim switches to the next fallback model (or aborts when no chain is configured). The budget is shared across the whole fallback chain and is not reset by a model switch; it resets only on a successful assistant response, session deletion, or a new user turn. 0 switches immediately.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "initialRetryDelayMs": {
          "default": 0,
          "description": "Delay in milliseconds before triggering the first fallback on a failover-worthy error. Gives intercepting plugins time to recover the current model before the fallback chain advances. 0 disables.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "retryDelayMs": {
          "default": 500,
          "description": "Delay in milliseconds between consecutive fallback attempts after the initial trigger. 0 disables.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "continuationPolicy": {
          "default": "retry-primary",
          "description": 'Model policy for unpinned OpenCode v1 internal continuations (for example, background completion and lifecycle wakes) after a confirmed fallback. "retry-primary" lets the host try the configured primary again; "stick-to-fallback" keeps the confirmed fallback until a new external user turn.',
          "type": "string",
          "enum": [
            "retry-primary",
            "stick-to-fallback"
          ]
        }
      },
      "additionalProperties": false
    },
    "council": {
      "type": "object",
      "properties": {
        "presets": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            }
          }
        },
        "default_preset": {
          "default": "default",
          "type": "string"
        }
      },
      "required": [
        "presets"
      ],
      "additionalProperties": {}
    },
    "companion": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "binaryPath": {
          "description": "Path to a custom companion binary to launch.",
          "type": "string",
          "minLength": 1
        },
        "position": {
          "type": "string",
          "enum": [
            "bottom-right",
            "bottom-left",
            "top-right",
            "top-left"
          ]
        },
        "size": {
          "type": "string",
          "enum": [
            "small",
            "medium",
            "large"
          ]
        },
        "gifPack": {
          "description": "Bundled companion animation pack to use.",
          "type": "string",
          "enum": [
            "default"
          ]
        },
        "loopStyle": {
          "description": "Companion animation playback style: classic loops or smooth ping-pong playback.",
          "type": "string",
          "enum": [
            "classic",
            "smooth"
          ]
        },
        "speed": {
          "description": "Companion animation playback speed multiplier. Defaults to 1.",
          "type": "number",
          "minimum": 0.25,
          "maximum": 4
        },
        "debug": {
          "description": "Enable verbose native companion debug logs.",
          "type": "boolean"
        }
      }
    },
    "webfetch": {
      "type": "object",
      "properties": {
        "enabled": {
          "default": true,
          "description": "When false, skip registering this enhanced webfetch so OpenCode uses its built-in version.",
          "type": "boolean"
        },
        "model": {
          "description": "Dedicated model(s) for smartfetch secondary-model summarization. Same shape as agent model config (string, array of strings/objects with id+variant). Takes priority over small_model, agents.explorer.model, and agents.librarian.model.",
          "anyOf": [
            {
              "type": "string"
            },
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string"
                      },
                      "variant": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "id"
                    ]
                  }
                ]
              }
            }
          ]
        }
      },
      "additionalProperties": false
    },
    "acpAgents": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "minLength": 1
          },
          "args": {
            "default": [],
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "env": {
            "default": {},
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {
              "type": "string"
            }
          },
          "cwd": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string",
            "minLength": 1
          },
          "prompt": {
            "type": "string",
            "minLength": 1
          },
          "orchestratorPrompt": {
            "type": "string",
            "minLength": 1
          },
          "wrapperModel": {
            "type": "string",
            "pattern": "^[^/\\s]+\\/.+$"
          },
          "timeoutMs": {
            "default": 0,
            "description": "Timeout for a single ACP run in milliseconds. Set to 0 to disable the timeout.",
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483647
          },
          "permissionMode": {
            "default": "ask",
            "type": "string",
            "enum": [
              "ask",
              "allow",
              "reject"
            ]
          }
        },
        "required": [
          "command"
        ],
        "additionalProperties": false
      }
    }
  },
  "title": "oh-my-opencode-slim",
  "description": "Configuration schema for oh-my-opencode-slim plugin for OpenCode"
};

// src/service/omo-config.ts
var OMO_BASENAME_JSON = "oh-my-opencode-slim.json";
var OMO_BASENAME_JSONC = "oh-my-opencode-slim.jsonc";
function omoRemotePaths(homeExpr = "$HOME") {
  return {
    json: `${homeExpr}/.config/opencode/${OMO_BASENAME_JSON}`,
    jsonc: `${homeExpr}/.config/opencode/${OMO_BASENAME_JSONC}`
  };
}
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
function parseOmoConfig(raw, format2) {
  if (format2 === "missing") return { parsed: null };
  const text = raw.replace(/^\uFEFF/, "");
  try {
    const parsed = JSON.parse(format2 === "jsonc" ? stripJsonc(text) : text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { parsed: null, err: "omo config must be a JSON object" };
    }
    return { parsed };
  } catch (e) {
    return { parsed: null, err: e instanceof Error ? e.message : String(e) };
  }
}
function qq(s) {
  return `"${s.replaceAll('"', '\\"')}"`;
}
function buildOmoReadScript(paths) {
  return [
    "set -e",
    `JC=${qq(paths.jsonc)}`,
    `JJ=${qq(paths.json)}`,
    'if [ -f "$JC" ]; then echo "FORMAT:jsonc"; wc -c < "$JC" | tr -d " " | sed "s/^/SIZE:/"',
    'elif [ -f "$JJ" ]; then echo "FORMAT:json"; wc -c < "$JJ" | tr -d " " | sed "s/^/SIZE:/"',
    'else echo "FORMAT:missing"; exit 0; fi',
    'if [ -f "$JC" ]; then base64 < "$JC"; else base64 < "$JJ"; fi'
  ].join("\n");
}
function parseOmoReadOutput(stdout) {
  const lines = stdout.split("\n");
  const fLine = lines.find((l) => l.startsWith("FORMAT:"));
  const sLine = lines.find((l) => l.startsWith("SIZE:"));
  const format2 = fLine?.slice(7) ?? "missing";
  const raw = lines.filter((l) => !l.startsWith("FORMAT:") && !l.startsWith("SIZE:")).join("");
  return {
    format: format2,
    size: sLine ? Number(sLine.slice(5)) : void 0,
    raw: raw ? Buffer.from(raw, "base64").toString("utf-8") : void 0
  };
}
function buildOmoWriteScript(target, b64) {
  const script = [
    "set -e",
    `P=${qq(target)}`,
    'D=$(dirname "$P")',
    'mkdir -p "$D"',
    'T=$(mktemp "$D/.ocrc-omo.XXXXXX")',
    'base64 -d > "$T"',
    'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak"; echo "bak: $P.ocrc-bak"; fi',
    'mv "$T" "$P"',
    'echo "written: $P"'
  ].join("\n");
  return { script, stdin: b64 };
}
function summarizeOmoConfig(format2, size, raw) {
  const base = { exists: format2 !== "missing", format: format2, presetNames: [], schema: OMO_SCHEMA };
  if (format2 === "missing" || raw === void 0) return base;
  const { parsed, err } = parseOmoConfig(raw, format2);
  if (!parsed) return { ...base, parseError: err };
  const presets = parsed.presets;
  return {
    ...base,
    size,
    activePreset: typeof parsed.preset === "string" ? parsed.preset : void 0,
    presetNames: presets && typeof presets === "object" && !Array.isArray(presets) ? Object.keys(presets).sort() : [],
    fallback: parsed.fallback && typeof parsed.fallback === "object" && !Array.isArray(parsed.fallback) ? parsed.fallback : void 0,
    agentChains: presets,
    parsed,
    commentsWillBeLost: format2 === "jsonc"
  };
}
function validateOmoWriteContent(content) {
  const { parsed, err } = parseOmoConfig(content, "json");
  if (!parsed) return { ok: false, err: `omo \u914D\u7F6E\u5FC5\u987B\u662F\u5408\u6CD5 JSON \u5BF9\u8C61\uFF1A${err ?? "parse failed"}` };
  return { ok: true, canonical: JSON.stringify(parsed, null, 2) + "\n", parsed };
}
function applyOmoEdits(parsed, edits) {
  const out = { ...parsed };
  if (edits.preset !== void 0) {
    if (edits.preset === null) delete out.preset;
    else out.preset = edits.preset;
  }
  if (edits.fallback !== void 0) {
    if (edits.fallback === null) delete out.fallback;
    else out.fallback = edits.fallback;
  }
  return out;
}
function sanitizeOmoFallback(input) {
  const out = {};
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") return { ok: false, err: "fallback.enabled \u5FC5\u987B\u662F\u5E03\u5C14\u503C" };
    out.enabled = input.enabled;
  }
  for (const k of ["maxRetries", "initialRetryDelayMs", "retryDelayMs"]) {
    if (k in input) {
      const v = input[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { ok: false, err: `fallback.${k} \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570` };
      out[k] = v;
    }
  }
  if ("continuationPolicy" in input) {
    if (input.continuationPolicy !== "retry-primary" && input.continuationPolicy !== "stick-to-fallback") {
      return { ok: false, err: "fallback.continuationPolicy \u5FC5\u987B\u662F retry-primary | stick-to-fallback" };
    }
    out.continuationPolicy = input.continuationPolicy;
  }
  const known = ["enabled", "maxRetries", "initialRetryDelayMs", "retryDelayMs", "continuationPolicy"];
  for (const k of Object.keys(input)) {
    if (!known.includes(k)) return { ok: false, err: `fallback.${k} \u4E0D\u662F omo-slim \u7684 fallback \u5B57\u6BB5\uFF08schema additionalProperties:false\uFF09` };
  }
  return { ok: true, value: out };
}

// src/service/provision.ts
import { homedir as homedir4 } from "node:os";
import { readFile as readFile2 } from "node:fs/promises";
import { spawn as spawn6 } from "node:child_process";

// src/shared/provision.ts
var MINIMUM_ENGINE_VERSION = "2.0.20";
var ENGINE_MAJOR2 = 2;
var MINIMUM_NODE_MAJOR = 20;
var RUNTIME_ROOT = ".ocrc/runtime";
function isSupportedEngineVersion2(version) {
  const parts = version.split(/[-+]/, 1)[0]?.split(".").map(Number) ?? [];
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n))) return false;
  if (parts[0] !== ENGINE_MAJOR2) return false;
  const floor = MINIMUM_ENGINE_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}
function platformPackage(target, variant) {
  const suffix = target.replace(/^linux-|^darwin-|^win32-/, "");
  const os = target.startsWith("linux") ? "linux" : target.startsWith("darwin") ? "darwin" : "windows";
  return `@opencode/cli-${os}-${suffix}${variant === "baseline" ? "-baseline" : ""}`;
}
function installDirFor(home) {
  return `${home.replace(/\/+$/, "")}/.opencode/bin`;
}
function runtimeDirName(packageName) {
  return packageName.replace(/^@/, "").replace(/\//g, "__");
}
function runtimeDirFor(home, packageName, version) {
  return `${home.replace(/\/+$/, "")}/${RUNTIME_ROOT}/${runtimeDirName(packageName)}/${version}`;
}
function runtimeRootFor(home) {
  return `${home.replace(/\/+$/, "")}/${RUNTIME_ROOT}`;
}
function engineBinaryName(target) {
  return target.startsWith("win32") ? "opencode.exe" : "opencode";
}
function readinessAction(step) {
  switch (step) {
    case "ssh":
      return "\u68C0\u67E5\u6863\u6848\u91CC\u7684\u5730\u5740\u3001\u7AEF\u53E3\u3001\u79C1\u94A5\u8DEF\u5F84\uFF1B\u9762\u677F\u5BBF\u4E3B\u4E0A\u5148\u624B\u5DE5 ssh \u4E00\u6B21\u786E\u8BA4\u80FD\u514D\u5BC6\u767B\u5F55\u3002";
    case "shell":
      return "\u76EE\u6807\u673A\u9700\u8981\u4E00\u4E2A\u53EF\u7528\u7684 POSIX sh\u3001tar \u4E0E\u53EF\u5199\u7684 $HOME\u2014\u2014\u8FD9\u662F\u5B98\u65B9\u5B89\u88C5\u8DEF\u5F84\u7684\u6700\u4F4E\u8981\u6C42\u3002";
    case "engine":
      return "\u70B9\u300C\u90E8\u7F72\u5F15\u64CE\u300D\u628A\u9762\u677F\u5BBF\u4E3B\u7684\u5F15\u64CE\u7248\u672C\u88C5\u5230 ~/.opencode/bin\uFF08\u4E0D\u8986\u76D6\u7528\u6237\u65E2\u6709\u5B89\u88C5\uFF09\u3002";
    case "project":
      return "\u5728\u6863\u6848\u91CC\u7ED1\u5B9A\u4E00\u4E2A\u88AB\u63A7\u673A\u4E0A\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u6216\u5728\u88AB\u63A7\u673A\u4E0A\u521B\u5EFA\u5B83\u3002";
  }
}

// src/service/detect.ts
function buildDetectScript() {
  return [
    `echo "OS=$( (cat /etc/os-release 2>/dev/null | sed -n "s/^PRETTY_NAME=//p" | tr -d '"') || uname -s)"`,
    'echo "ONLY_OS=$(uname -s)"',
    'echo "KERNEL=$(uname -r)"',
    'echo "MACHINE=$(uname -m)"',
    'echo "GLIBC=$( (ldd --version 2>/dev/null | head -1) || echo unknown)"',
    'echo "HOME_DIR=$HOME"',
    'if [ -w "$HOME" ] && [ -d "$HOME" ]; then echo "HOME_WRITABLE=yes"; else echo "HOME_WRITABLE=no"; fi',
    'if command -v sh >/dev/null 2>&1; then echo "HAS_SH=yes"; else echo "HAS_SH=no"; fi',
    'if command -v tar >/dev/null 2>&1; then echo "HAS_TAR=yes"; else echo "HAS_TAR=no"; fi',
    'if [ -f /.dockerenv ]; then echo "CONTAINER=docker"',
    'elif [ -f /run/.containerenv ]; then echo "CONTAINER=docker"',
    'elif grep -qa "docker\\|kubepods" /proc/1/cgroup 2>/dev/null; then echo "CONTAINER=docker"',
    'elif grep -qa "lxc" /proc/1/cgroup 2>/dev/null || [ -n "$container" ]; then echo "CONTAINER=lxc"',
    'else echo "CONTAINER=none"; fi',
    'if [ -r /proc/cpuinfo ] && grep -qw avx2 /proc/cpuinfo; then echo "AVX2=yes"; else echo "AVX2=no"; fi',
    'if command -v node >/dev/null 2>&1; then echo "NODE=$(node --version 2>/dev/null)"; else echo "NODE=none"; fi',
    // npm 是运行时补齐（`~/.ocrc/runtime/<name>/<ver>`）的唯一安装器：没有它就装不了
    // 任何 npm 形态的 MCP，计划里要如实说「装不了」而不是试了才失败。
    'if command -v npm >/dev/null 2>&1; then echo "NPM=$(npm --version 2>/dev/null)"; else echo "NPM=none"; fi',
    'ENG="$HOME/.opencode/bin/opencode"',
    'if [ -x "$ENG" ]; then echo "ENGINE_PATH=$ENG"; echo "ENGINE_VERSION=$("$ENG" --version 2>/dev/null | head -1)"; else echo "ENGINE_PATH=none"; fi',
    'for c in "$HOME/.local/bin/opencode" /usr/local/bin/opencode /usr/bin/opencode; do',
    '  if [ -x "$c" ]; then echo "LEGACY_PATH=$c"; echo "LEGACY_VERSION=$("$c" --version 2>/dev/null | head -1)"; break; fi',
    "done",
    // 出网探测：只关心能不能拿到官方 registry（安装通道），所以打的是 npm 而不是
    // opencode.ai——真正的取件动作只走 registry。
    "if command -v curl >/dev/null 2>&1; then",
    '  if curl -sSf -m 8 -o /dev/null https://registry.npmjs.org/@opencode%2Fcli 2>/dev/null; then echo "OUTBOUND=yes"; else echo "OUTBOUND=no"; fi',
    "elif command -v wget >/dev/null 2>&1; then",
    '  if wget -q -T 8 -O /dev/null https://registry.npmjs.org/@opencode%2Fcli 2>/dev/null; then echo "OUTBOUND=yes"; else echo "OUTBOUND=no"; fi',
    'else echo "OUTBOUND=unknown"; fi',
    'echo "DETECT_DONE=1"'
  ].join("\n");
}
function parseDetectOutput(stdout) {
  const out = {};
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}
function resolveTarget(machine, onlyOs, _baseline) {
  const os = onlyOs.toLowerCase();
  const arch = /aarch64|arm64/.test(machine.toLowerCase()) ? "arm64" : /x86_64|amd64/.test(machine.toLowerCase()) ? "x64" : void 0;
  if (!arch) return void 0;
  if (os === "linux") return `linux-${arch}`;
  if (os === "darwin") return `darwin-${arch}`;
  if (os.startsWith("mingw") || os.startsWith("msys") || os === "windows") return `win32-${arch}`;
  return void 0;
}
function parseGlibc(text) {
  const match = /(\d+\.\d+)(?:-|$|\s)/.exec(text.trim());
  return match?.[1];
}
var MINIMUM_GLIBC = "2.17";
function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
function toDetectReport(stdout, options = {}) {
  const f = parseDetectOutput(stdout);
  if (!f.DETECT_DONE) {
    return { reachable: options.reachable ?? false, error: options.stderr?.trim() || "\u63A2\u6D4B\u811A\u672C\u6CA1\u6709\u8DD1\u5B8C\uFF08\u76EE\u6807\u673A\u53EF\u80FD\u6CA1\u6709\u53EF\u7528\u7684 sh\uFF09" };
  }
  const glibc = parseGlibc(f.GLIBC ?? "");
  const baseline = f.AVX2 !== "yes";
  const platform = resolveTarget(f.MACHINE ?? "", f.ONLY_OS ?? "", baseline);
  const node = f.NODE && f.NODE !== "none" ? f.NODE : void 0;
  const report = {
    reachable: options.reachable ?? true,
    platform,
    baseline,
    os: f.OS || f.ONLY_OS,
    kernel: f.KERNEL,
    glibc,
    container: f.CONTAINER === "docker" || f.CONTAINER === "lxc" ? f.CONTAINER : f.CONTAINER === "none" ? "none" : "unknown",
    home: f.HOME_DIR,
    homeWritable: f.HOME_WRITABLE === "yes",
    hasSh: f.HAS_SH === "yes",
    hasTar: f.HAS_TAR === "yes",
    outbound: f.OUTBOUND === "yes" ? true : f.OUTBOUND === "no" ? false : void 0,
    engine: f.ENGINE_PATH && f.ENGINE_PATH !== "none" ? { path: f.ENGINE_PATH, version: normalizeVersion(f.ENGINE_VERSION ?? "") } : null,
    legacyEngine: f.LEGACY_PATH ? { path: f.LEGACY_PATH, version: normalizeVersion(f.LEGACY_VERSION ?? "") } : null,
    node,
    npm: f.NPM && f.NPM !== "none" ? f.NPM : void 0,
    nodeOk: nodeMajorOk(node)
  };
  if (!platform) {
    report.unsupportedReason = `\u5B98\u65B9 2.x \u6CA1\u6709 ${f.ONLY_OS}/${f.MACHINE} \u7684\u6784\u5EFA`;
  } else if (platform.startsWith("linux") && glibc && compareVersions(glibc, MINIMUM_GLIBC) < 0) {
    report.unsupportedReason = `\u76EE\u6807\u673A glibc ${glibc} \u4F4E\u4E8E\u5B98\u65B9 2.x \u7684\u4E0B\u9650 ${MINIMUM_GLIBC}`;
  }
  return report;
}
function normalizeVersion(raw) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw);
  return match?.[1] ?? raw.trim();
}
function nodeMajorOk(node, minimum = MINIMUM_NODE_MAJOR) {
  if (!node) return false;
  const version = node.replace(/^v/i, "").trim();
  if (!/^\d+/.test(version)) return false;
  return compareVersions(version, String(minimum)) >= 0;
}
function toReadiness(report, options = {}) {
  const steps = [];
  steps.push({
    id: "ssh",
    label: "\u2460 SSH \u53EF\u8FBE",
    ok: report.reachable && !report.error,
    detail: report.error ?? (report.reachable ? `\u5DF2\u8FDE\u4E0A\uFF08${report.os ?? "\u672A\u77E5\u7CFB\u7EDF"}\uFF09` : "\u8FDE\u4E0D\u4E0A")
  });
  const shellOk = Boolean(report.reachable && report.hasSh && report.hasTar && report.homeWritable);
  steps.push({
    id: "shell",
    label: "\u2461 sh + tar + \u53EF\u5199 $HOME",
    ok: shellOk,
    detail: report.reachable ? [report.hasSh ? "sh \u2713" : "sh \u2717", report.hasTar ? "tar \u2713" : "tar \u2717", report.homeWritable ? "$HOME \u53EF\u5199 \u2713" : "$HOME \u4E0D\u53EF\u5199 \u2717"].join(" \xB7 ") : "\u672A\u77E5\uFF08\u5148\u8FDE\u4E0A\uFF09"
  });
  const engineVersion = report.engine?.version;
  const engineOk = Boolean(engineVersion && isSupportedEngineVersion2(engineVersion));
  const anchor = options.anchorVersion;
  const drift = engineOk && anchor && engineVersion !== anchor;
  steps.push({
    id: "engine",
    label: "\u2462 \u5F15\u64CE\u5728\u4F4D\u4E14\u7248\u672C\u5339\u914D",
    ok: engineOk && !drift,
    detail: !engineVersion ? report.legacyEngine ? `~/.opencode/bin \u91CC\u6CA1\u6709\uFF1B\u53E6\u6709\u65E2\u6709\u5B89\u88C5 ${report.legacyEngine.version || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"}@${report.legacyEngine.path}\uFF08\u4E0D\u4F1A\u52A8\u5B83\uFF09` : "\u672A\u5B89\u88C5" : drift ? `\u5728\u4F4D ${engineVersion}\uFF0C\u4E0E\u9762\u677F\u5BBF\u4E3B ${anchor} \u4E0D\u4E00\u81F4` : `\u5728\u4F4D ${engineVersion}`
  });
  const project = options.projectPath;
  steps.push({
    id: "project",
    label: "\u2463 \u8FDC\u7A0B\u5DE5\u4F5C\u76EE\u5F55\u53EF\u5199",
    ok: Boolean(project) && Boolean(report.reachable),
    detail: project ? `${project}` : "\u6863\u6848\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u5DE5\u4F5C\u76EE\u5F55"
  });
  for (const step of steps) {
    if (!step.ok) step.action = readinessAction(step.id);
  }
  return {
    steps,
    ready: steps.every((s) => s.ok)
  };
}

// src/service/artifact.ts
import { createHash as createHash3 } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join as join8 } from "node:path";
var NPM_REGISTRY = "https://registry.npmjs.org";
var TAR_BINARY_PATH = "package/bin/opencode";
var packageMetadataUrl = (registry, name, version) => `${registry}/${name.replace("/", "%2F")}/${version}`;
async function resolveArtifact(target, variant, version, deps = {}) {
  const registry = deps.registry ?? NPM_REGISTRY;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const name = platformPackage(target, variant);
  const response = await fetchImpl(packageMetadataUrl(registry, name, version), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(2e4)
  });
  if (!response.ok) {
    throw new Error(`\u5B98\u65B9\u6CA1\u6709 ${name}@${version}\uFF08HTTP ${response.status}\uFF09\u2014\u2014\u6362\u4E00\u4E2A\u7248\u672C\u6216\u6362 baseline \u53D8\u4F53`);
  }
  const body = await response.json();
  const tarball = body.dist?.tarball;
  const integrity = body.dist?.integrity;
  if (typeof tarball !== "string" || typeof integrity !== "string") {
    throw new Error(`${name}@${version} \u7684\u5143\u6570\u636E\u91CC\u6CA1\u6709 dist.tarball/dist.integrity`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${name}@${version} \u7684 integrity \u4E0D\u662F sha512\uFF1A${integrity.slice(0, 24)}\u2026`);
  }
  if (new URL(tarball).origin !== new URL(registry).origin) {
    throw new Error(`${name}@${version} \u7684 tarball \u4E0D\u5728 npm registry \u4E0A\uFF08${tarball}\uFF09`);
  }
  return {
    package: name,
    version,
    integrity,
    tarballUrl: tarball,
    unpackedBytes: typeof body.dist?.unpackedSize === "number" ? body.dist.unpackedSize : void 0
  };
}
function sha512Of(bytes) {
  return `sha512-${createHash3("sha512").update(bytes).digest("base64")}`;
}
function verifyIntegrity2(bytes, integrity) {
  const actual = sha512Of(bytes);
  if (actual !== integrity) {
    throw new Error(`\u5DE5\u4EF6\u6821\u9A8C\u5931\u8D25\uFF1A\u671F\u671B ${integrity.slice(0, 20)}\u2026\uFF0C\u5B9E\u5F97 ${actual.slice(0, 20)}\u2026`);
  }
}
var cachePathFor = (dir, ref) => join8(dir, `${ref.package.replace("/", "__")}-${ref.version}.tgz`);
async function fetchArtifactToCache(ref, deps) {
  const target = cachePathFor(deps.dir, ref);
  const cached = await readFile(target).catch(() => null);
  if (cached && sha512Of(cached) === ref.integrity) return target;
  if (cached) await rm(target, { force: true });
  await mkdir(deps.dir, { recursive: true });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(ref.tarballUrl, { signal: AbortSignal.timeout(10 * 6e4) });
  if (!response.ok) throw new Error(`\u4E0B\u8F7D ${ref.package}@${ref.version} \u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity2(bytes, ref.integrity);
  const staging = `${target}.tmp-${process.pid}`;
  await writeFile(staging, bytes);
  await rename(staging, target);
  return target;
}
async function cachedArtifactPath(ref, dir) {
  const target = cachePathFor(dir, ref);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return null;
  const bytes = await readFile(target);
  return sha512Of(bytes) === ref.integrity ? target : null;
}
function defaultCacheDir(home) {
  return join8(home, ".ocrc", "artifacts");
}

// src/service/install.ts
var MARKER_NAME = ".ocrc-deploy.json";
var BACKUP_SUFFIX = ".ocrc-bak";
function decideInstall(identity, wanted) {
  if (!identity.version) {
    return { action: "install", reason: "~/.opencode/bin \u91CC\u8FD8\u6CA1\u6709\u5F15\u64CE" };
  }
  if (identity.executable === false) {
    return { action: "reinstall", reason: "\u5728\u4F4D\u6587\u4EF6\u4E0D\u53EF\u6267\u884C\uFF08\u5347\u5230\u4E00\u534A\u6216\u6743\u9650\u88AB\u6539\uFF09" };
  }
  const diff = compareRelease(identity.version, wanted.version);
  if (diff !== 0) {
    const direction = diff < 0 ? "upgrade" : "downgrade";
    const tail = diff < 0 ? "\u955C\u50CF\u9762\u677F\u5BBF\u4E3B" : "\u88AB\u63A7\u7AEF\u65B0\u4E8E\u9762\u677F\u5BBF\u4E3B\uFF0C\u6309\u955C\u50CF\u7B56\u7565\u964D\u56DE";
    if (!identity.marker?.integrity) {
      return { action: direction, reason: `${identity.version} \u2192 ${wanted.version}\uFF08${tail}\uFF1B\u5728\u4F4D\u6587\u4EF6\u4E0D\u662F\u6211\u4EEC\u90E8\u7F72\u7684\uFF0C\u987A\u5E26\u53D6\u5F97\u8EAB\u4EFD\uFF09` };
    }
    return { action: direction, reason: `${identity.version} \u2192 ${wanted.version}\uFF08${tail}\uFF09` };
  }
  if (identity.version !== wanted.version) {
    return { action: "reinstall", reason: `\u7248\u672C\u5B57\u7B26\u4E32\u4E0D\u540C\uFF08${identity.version} vs ${wanted.version}\uFF09\uFF0C\u6309\u5185\u5BB9\u91CD\u88C5` };
  }
  if (!identity.marker?.integrity) {
    return { action: "reinstall", reason: "\u5728\u4F4D\u6587\u4EF6\u4E0D\u662F\u6211\u4EEC\u90E8\u7F72\u7684\uFF08\u6CA1\u6709 marker\uFF09\uFF0C\u6309\u5185\u5BB9\u91CD\u88C5\u4EE5\u53D6\u5F97\u8EAB\u4EFD" };
  }
  if (identity.marker.integrity !== wanted.integrity) {
    return { action: "reinstall", reason: `\u540C\u5728 ${wanted.version} \u4F46\u5DE5\u4EF6 sha \u4E0D\u540C\uFF08\u9762\u677F\u4FA7\u91CD\u65B0\u53D1\u5E03\u8FC7\uFF09\uFF0C\u6309\u5185\u5BB9\u91CD\u88C5` };
  }
  return { action: "none", reason: `\u5DF2\u662F ${wanted.version}\uFF0C\u5DE5\u4EF6\u4E00\u81F4` };
}
function compareRelease(left, right) {
  const a = left.split(/[-+]/)[0].split(".").map(Number);
  const b = right.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
var q2 = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
function buildIdentityScript(home) {
  const dir = installDirFor(home);
  const bin = `${dir}/${engineBinaryName("linux-x64")}`;
  return [
    `D=${q2(dir)}`,
    `B=${q2(bin)}`,
    'M="$D/' + MARKER_NAME + '"',
    'if [ -f "$B" ]; then echo "PRESENT=yes"; else echo "PRESENT=no"; fi',
    'if [ -x "$B" ]; then echo "EXECUTABLE=yes"; else echo "EXECUTABLE=no"; fi',
    'if [ -f "$B" ]; then echo "VERSION=$("$B" --version 2>/dev/null | head -1)"; fi',
    'if [ -f "$M" ]; then echo "MARKER_BEGIN"; cat "$M"; echo; echo "MARKER_END"; fi',
    'echo "IDENTITY_DONE=1"'
  ].join("\n");
}
function parseIdentityOutput(stdout) {
  const identity = { marker: null };
  let present = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("PRESENT=")) present = line.slice("PRESENT=".length).trim() === "yes";
    else if (line.startsWith("EXECUTABLE=")) identity.executable = line.slice("EXECUTABLE=".length).trim() === "yes";
    else if (line.startsWith("VERSION=")) identity.version = line.slice("VERSION=".length).trim() || void 0;
  }
  if (!present) {
    identity.version = void 0;
    identity.marker = null;
    return identity;
  }
  if (identity.executable === void 0) identity.executable = false;
  const block = /MARKER_BEGIN\r?\n([\s\S]*?)\r?\nMARKER_END/.exec(stdout);
  if (block) {
    try {
      const parsed = JSON.parse(block[1]);
      if (parsed && typeof parsed === "object") identity.marker = parsed;
    } catch {
      identity.marker = null;
    }
  }
  return identity;
}
function integrityHex(integrity) {
  const base64 = integrity.replace(/^sha512-/, "");
  return Buffer.from(base64, "base64").toString("hex");
}
function buildInstallScript(options) {
  const dir = installDirFor(options.home);
  const bin = `${dir}/${engineBinaryName(options.platform)}`;
  const marker = `${dir}/${MARKER_NAME}`;
  const expectB64 = options.integrity;
  const expectHex = integrityHex(options.integrity);
  return [
    "set -e",
    `D=${q2(dir)}`,
    'TMP="$D/.ocrc-staging"',
    'mkdir -p "$D"',
    'rm -rf "$TMP" && mkdir -p "$TMP"',
    'cleanup() { rm -rf "$TMP"; }',
    "trap cleanup EXIT",
    // ── 取件：两条路的产物必须过同一套校验（D4）──
    ...options.uploadedTar ? [`mv ${q2(options.uploadedTar)} "$TMP/pkg.tgz"`] : [
      `URL=${q2(options.downloadUrl ?? "")}`,
      "if command -v curl >/dev/null 2>&1; then",
      '  curl -fsSL -o "$TMP/pkg.tgz" "$URL" || { echo "OCRC_ERR=download"; exit 0; }',
      "elif command -v wget >/dev/null 2>&1; then",
      '  wget -q -O "$TMP/pkg.tgz" "$URL" || { echo "OCRC_ERR=download"; exit 0; }',
      'else echo "OCRC_ERR=no-downloader"; exit 0; fi'
    ],
    // ── 校验身份：openssl 给 base64（与 npm 同形），sha512sum 给十六进制 ──
    `EXPECT_B64=${q2(expectB64)}`,
    `EXPECT_HEX=${q2(expectHex)}`,
    'GOT_B64=""',
    'GOT_HEX=""',
    "if command -v openssl >/dev/null 2>&1; then",
    '  GOT_B64="sha512-$(openssl dgst -sha512 -binary "$TMP/pkg.tgz" | openssl base64 -A)"',
    "fi",
    "if command -v sha512sum >/dev/null 2>&1; then",
    '  GOT_HEX="$(sha512sum "$TMP/pkg.tgz" | cut -d" " -f1)"',
    "fi",
    'if [ -n "$GOT_B64" ] && [ "$GOT_B64" != "$EXPECT_B64" ]; then echo "OCRC_ERR=integrity"; echo "OCRC_GOT=$GOT_B64"; exit 0; fi',
    'if [ -z "$GOT_B64" ] && [ -n "$GOT_HEX" ] && [ "$GOT_HEX" != "$EXPECT_HEX" ]; then echo "OCRC_ERR=integrity"; echo "OCRC_GOT=sha512-$GOT_HEX"; exit 0; fi',
    'if [ -z "$GOT_B64" ] && [ -z "$GOT_HEX" ]; then echo "OCRC_ERR=no-checksum-tool"; exit 0; fi',
    // ── 解包 + 验版本（版本不符说明包名/变体选错了）──
    'mkdir -p "$TMP/x" && tar -xzf "$TMP/pkg.tgz" -C "$TMP/x"',
    `NEW="$TMP/x/${TAR_BINARY_PATH}"`,
    'if [ ! -f "$NEW" ]; then echo "OCRC_ERR=layout"; exit 0; fi',
    'chmod 755 "$NEW"',
    'NEWV="$("$NEW" --version 2>/dev/null | head -1)"',
    `if ! printf '%s' "$NEWV" | grep -q ${q2(options.version)}; then echo "OCRC_ERR=version"; echo "OCRC_GOT=$NEWV"; exit 0; fi`,
    // ── 就位：旧件留 .ocrc-bak，marker 记 sha512（不是版本字符串）──
    `B=${q2(bin)}`,
    'if [ -f "$B" ]; then cp -p "$B" "$B' + BACKUP_SUFFIX + '"; fi',
    'mv "$NEW" "$B"',
    'cat > "$TMP/marker.json" <<OCRC_MARKER',
    `{"integrity":${JSON.stringify(expectB64)},"version":${JSON.stringify(options.version)},"package":${JSON.stringify(options.packageName)},"platform":${JSON.stringify(options.platform)},"deployedAt":$(date +%s)}`,
    "OCRC_MARKER",
    `mv "$TMP/marker.json" ${q2(marker)}`,
    'echo "OCRC_OK=1"',
    'echo "OCRC_PATH=$B"',
    'echo "OCRC_VERSION=$("$B" --version 2>/dev/null | head -1)"',
    'if [ -f "$B' + BACKUP_SUFFIX + '" ]; then echo "OCRC_BACKUP=$B' + BACKUP_SUFFIX + '"; fi'
  ].join("\n");
}
var INSTALL_ERRORS = {
  "no-downloader": "\u76EE\u6807\u673A\u4E0A\u65E2\u6CA1\u6709 curl \u4E5F\u6CA1\u6709 wget\u2014\u2014\u8BF7\u6539\u8D70\u300C\u4ECE\u9762\u677F\u63A8\u9001\u300D\u8FD9\u6761\u8DEF",
  download: "\u76EE\u6807\u673A\u4E0B\u8F7D\u5931\u8D25\uFF08\u7F51\u7EDC\u6216 registry \u4E0D\u53EF\u8FBE\uFF09\u2014\u2014\u53EF\u6539\u8D70\u300C\u4ECE\u9762\u677F\u63A8\u9001\u300D",
  integrity: "\u5DE5\u4EF6\u6821\u9A8C\u5931\u8D25\uFF08sha512 \u4E0D\u7B26\uFF09\uFF0C\u5DF2\u653E\u5F03\u5B89\u88C5",
  "no-checksum-tool": "\u76EE\u6807\u673A\u4E0A\u6CA1\u6709 openssl \u4E5F\u6CA1\u6709 sha512sum\uFF0C\u65E0\u6CD5\u6821\u9A8C\u5DE5\u4EF6\u2014\u2014\u62D2\u7EDD\u5B89\u88C5\u672A\u6821\u9A8C\u7684\u4E8C\u8FDB\u5236",
  layout: "tar \u5305\u91CC\u6CA1\u6709 package/bin/opencode\u2014\u2014\u4E0D\u662F\u5B98\u65B9\u5E73\u53F0\u5305",
  version: "\u89E3\u51FA\u6765\u7684\u4E8C\u8FDB\u5236\u7248\u672C\u4E0E\u8BF7\u6C42\u4E0D\u7B26"
};
function parseInstallOutput(stdout, expectedIntegrity) {
  const fields = /* @__PURE__ */ new Map();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const err = fields.get("OCRC_ERR");
  if (err) {
    return {
      ok: false,
      error: INSTALL_ERRORS[err] ?? `\u5B89\u88C5\u5931\u8D25\uFF08${err}\uFF09`,
      ...err === "integrity" ? { expected: expectedIntegrity, got: fields.get("OCRC_GOT") } : {},
      ...err === "version" ? { got: fields.get("OCRC_GOT") } : {}
    };
  }
  if (fields.get("OCRC_OK") !== "1") return { ok: false, error: "\u5B89\u88C5\u811A\u672C\u6CA1\u6709\u7ED9\u51FA\u7ED3\u679C\uFF08\u8FDE\u63A5\u4E2D\u65AD\u6216\u88AB kill\uFF09" };
  return {
    ok: true,
    path: fields.get("OCRC_PATH"),
    version: fields.get("OCRC_VERSION"),
    backup: fields.get("OCRC_BACKUP")
  };
}
function buildRollbackScript(home, platform) {
  const bin = `${installDirFor(home)}/${engineBinaryName(platform)}`;
  return [
    `B=${q2(bin)}`,
    'if [ -f "$B' + BACKUP_SUFFIX + '" ]; then mv "$B' + BACKUP_SUFFIX + '" "$B"; echo "OCRC_ROLLED_BACK=1";',
    'else echo "OCRC_ROLLED_BACK=0"; fi'
  ].join("\n");
}
function buildUninstallScript(home) {
  const dir = installDirFor(home);
  return [
    `D=${q2(dir)}`,
    'rm -f "$D/opencode" "$D/opencode.exe" "$D/opencode2" "$D/opencode2.cmd" "$D/' + BACKUP_SUFFIX + '" "$D/' + MARKER_NAME + '"',
    'rmdir "$D" 2>/dev/null && echo "OCRC_DIR_REMOVED=1" || echo "OCRC_DIR_REMOVED=0"',
    'echo "OCRC_UNINSTALLED=1"'
  ].join("\n");
}

// src/service/runtime.ts
var RUNTIME_MARKER_NAME = ".ocrc-runtime";
var RUNTIME_BACKUP_SUFFIX = ".ocrc-bak";
var LATEST_SLOT = "latest";
var q3 = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
function runtimeSlot(version) {
  const slot = (version ?? LATEST_SLOT).trim();
  const safe = slot.replace(/[^A-Za-z0-9._+-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : LATEST_SLOT;
}
function runtimeSpec(need) {
  return need.version ? `${need.name}@${need.version}` : need.name;
}
function buildRuntimeDiscoverScript(home, needs) {
  const root = runtimeRootFor(home);
  const lines = [`ROOT=${q3(root)}`];
  needs.forEach((need, index) => {
    const p = `R${index}`;
    if (need.kind === "path") {
      lines.push(`if [ -x ${q3(need.name)} ]; then echo "${p}_KIND=path"; echo "${p}_PATH=${need.name}"; fi`);
      return;
    }
    lines.push(`CMD=$(command -v ${q3(need.name)} 2>/dev/null || true)`);
    lines.push(`if [ -n "$CMD" ]; then echo "${p}_KIND=in-path"; echo "${p}_INPATH=$CMD"; fi`);
    const pkgDir = `"$ROOT/${runtimeDirName(need.name)}"`;
    const slot = runtimeSlot(need.version);
    lines.push(`D=${pkgDir}`);
    lines.push(`if [ -d "$D" ]; then`);
    lines.push(need.version ? `  S=${q3(slot)}` : '  S=$(ls -1 "$D" 2>/dev/null | sort -V | tail -1)');
    lines.push('  if [ -n "$S" ] && [ -d "$D/$S" ]; then');
    lines.push(`    if [ -f "$D/$S/${RUNTIME_MARKER_NAME}" ]; then`);
    lines.push(`      echo "${p}_KIND=installed"`);
    lines.push(`      echo "${p}_DIR=$D/$S"`);
    lines.push(`      sed -n "s/^ENTRY=/${p}_ENTRY=/p;s/^VERSION=/${p}_VERSION=/p;s/^SPEC=/${p}_SPEC=/p" "$D/$S/${RUNTIME_MARKER_NAME}"`);
    lines.push("    else");
    lines.push(`      echo "${p}_KIND=unmanaged"`);
    lines.push(`      echo "${p}_DIR=$D/$S"`);
    lines.push("    fi");
    lines.push("  fi");
    lines.push("fi");
  });
  lines.push('echo "RUNTIME_DISCOVER_DONE=1"');
  return lines.join("\n");
}
function parseRuntimeDiscoverOutput(stdout, needs) {
  const table = /* @__PURE__ */ new Map();
  needs.forEach((need) => table.set(need.raw, { raw: need.raw }));
  const fields = /* @__PURE__ */ new Map();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const match = /^R(\d+)_([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const bucket = fields.get(match[1]) ?? /* @__PURE__ */ new Map();
    bucket.set(match[2], match[3]);
    fields.set(match[1], bucket);
  }
  for (const [index, values] of fields) {
    const need = needs[Number(index)];
    if (!need) continue;
    const entry = { raw: need.raw };
    const kind = values.get("KIND");
    if (kind === "path") entry.pathExists = true;
    if (kind === "in-path") entry.inPath = values.get("INPATH");
    if (kind === "unmanaged") entry.unmanagedDir = values.get("DIR");
    if (kind === "installed") {
      entry.installed = {
        dir: values.get("DIR") ?? "",
        entry: values.get("ENTRY") ?? "",
        version: values.get("VERSION")?.trim() || void 0,
        spec: values.get("SPEC")?.trim() || void 0
      };
    }
    table.set(need.raw, entry);
  }
  return table;
}
function factsFromDetect(detect, home) {
  return {
    home,
    node: detect.node,
    npm: detect.npm,
    nodeOk: detect.nodeOk ?? false,
    outbound: detect.outbound
  };
}
function nodeReason(facts) {
  if (!facts.node) return `\u76EE\u6807\u673A\u6CA1\u6709 node\u2014\u2014npm \u5F62\u6001\u7684\u8FD0\u884C\u65F6\u9700\u8981 node \u2265 ${MINIMUM_NODE_MAJOR}\uFF08\u5148\u5728\u88AB\u63A7\u7AEF\u88C5 node\uFF0C\u6216\u7528\u9762\u677F\u4FA7\u80FD\u529B\u7684\u53CD\u5411\u63A5\u5165\uFF09`;
  return `\u76EE\u6807\u673A\u7684 node ${facts.node} \u4F4E\u4E8E npm \u5F62\u6001\u8FD0\u884C\u65F6\u7684\u4E0B\u9650 ${MINIMUM_NODE_MAJOR}`;
}
function decideRuntime(need, facts, discovery, neededBy) {
  const base = { need, neededBy };
  if (need.kind === "path") {
    if (discovery?.pathExists) return { ...base, action: "present", found: { path: need.name } };
    return {
      ...base,
      action: "impossible",
      reason: `${need.name} \u5728\u76EE\u6807\u673A\u4E0A\u4E0D\u5B58\u5728\u2014\u2014ocrc \u53EA\u88C5 npm \u5F62\u6001\u7684\u8FD0\u884C\u65F6\uFF0C\u4E8C\u8FDB\u5236\u5206\u53D1\u5305\u8981\u4F60\u5728\u88AB\u63A7\u7AEF\u81EA\u5DF1\u88C5\u597D`
    };
  }
  if (discovery?.inPath) {
    return {
      ...base,
      action: "present",
      found: { path: discovery.inPath },
      reason: `\u76EE\u6807\u673A PATH \u91CC\u5DF2\u7ECF\u6709 ${need.name}\uFF08${discovery.inPath}\uFF09\u2014\u2014\u7528\u5B83\uFF0C\u4E0D\u53E6\u88C5\u4E00\u4EFD`
    };
  }
  if (discovery?.installed?.entry) {
    return {
      ...base,
      action: "present",
      found: { path: discovery.installed.entry, version: discovery.installed.version }
    };
  }
  if (discovery?.unmanagedDir) {
    return {
      ...base,
      action: "impossible",
      reason: `${discovery.unmanagedDir} \u5DF2\u5B58\u5728\u4F46\u4E0D\u662F ocrc \u88C5\u7684\uFF08\u6CA1\u6709 ${RUNTIME_MARKER_NAME} \u6807\u8BB0\uFF09\u2014\u2014\u4E0D\u5F80\u91CC\u88C5\uFF0C\u907F\u514D\u6405\u4E71\u522B\u4EBA\u7684\u76EE\u5F55`
    };
  }
  if (!facts.nodeOk) return { ...base, action: "impossible", reason: nodeReason(facts) };
  if (!facts.npm) return { ...base, action: "impossible", reason: "\u76EE\u6807\u673A\u6CA1\u6709 npm\u2014\u2014\u8FD0\u884C\u65F6\u8981\u9760\u5B83\u88C5\uFF1B\u88C5\u597D npm \u518D\u56DE\u6765" };
  if (facts.outbound === false) {
    return {
      ...base,
      action: "impossible",
      reason: "\u76EE\u6807\u673A\u4E0D\u51FA\u7F51\uFF0C\u800C\u8FD0\u884C\u65F6\u8981\u7531\u88AB\u63A7\u7AEF\u81EA\u5DF1\u4ECE npm \u53D6\u4EF6\uFF08\u9762\u677F\u63A8\u9001\u8FD0\u884C\u65F6\u7559\u5230\u4E0B\u4E00\u8F6E\uFF09"
    };
  }
  const slot = runtimeSlot(need.version);
  return {
    ...base,
    action: "install",
    package: need.name,
    version: need.version,
    // 入口装完才知道（读包自己的 bin）——预演里不写一个假的路径。
    dir: runtimeDirFor(facts.home, need.name, slot)
  };
}
function buildRuntimePlan(needs, facts, discovery) {
  return {
    items: needs.map(({ need, neededBy }) => decideRuntime(need, facts, discovery.get(need.raw), neededBy)),
    root: runtimeRootFor(facts.home),
    node: facts.node,
    npm: facts.npm,
    nodeOk: facts.nodeOk
  };
}
var ENTRY_RESOLVER_SOURCE = `const fs = require('fs')
const path = require('path')
const [dir, pkg] = process.argv.slice(2)
let meta
try {
  meta = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', pkg, 'package.json'), 'utf8'))
} catch (error) {
  console.log('NO_BIN')
  process.exit(0)
}
const bin = meta.bin
let name
let rel
if (typeof bin === 'string') {
  name = String(meta.name || pkg).split('/').pop()
  rel = bin
} else if (bin && typeof bin === 'object') {
  name = Object.keys(bin)[0]
  rel = bin[name]
}
if (!name || !rel) {
  console.log('NO_BIN')
  process.exit(0)
}
const shim = path.join(dir, 'node_modules', '.bin', name)
console.log(fs.existsSync(shim) ? shim : path.join(dir, 'node_modules', pkg, rel))
console.log('OCRC_VERSION=' + (meta.version || ''))
`;
function buildRuntimeInstallScript(options) {
  const { need } = options;
  const root = runtimeRootFor(options.home);
  const slot = runtimeSlot(need.version);
  const dir = runtimeDirFor(options.home, need.name, slot);
  const spec = runtimeSpec(need);
  const helper = `${root}/.ocrc-entry-resolver.cjs`;
  const helperB64 = Buffer.from(ENTRY_RESOLVER_SOURCE, "utf-8").toString("base64");
  return [
    `ROOT=${q3(root)}`,
    `D=${q3(dir)}`,
    'M="$D/' + RUNTIME_MARKER_NAME + '"',
    `SPEC=${q3(spec)}`,
    `PKG=${q3(need.name)}`,
    `HELPER=${q3(helper)}`,
    // ── 前置条件：npm 与 node 是这条路的全部依赖 ──
    'if ! command -v npm >/dev/null 2>&1; then echo "OCRC_ERR=no-npm"; echo "RUNTIME_DONE=1"; exit 0; fi',
    'if ! command -v node >/dev/null 2>&1; then echo "OCRC_ERR=no-node"; echo "RUNTIME_DONE=1"; exit 0; fi',
    // ── 幂等：同 spec 且入口还在 → 什么都不做（force 时跳过这段）──
    ...options.force ? [] : [
      'if [ -f "$M" ]; then',
      '  PREV_SPEC=$(sed -n "s/^SPEC=//p" "$M" | head -1)',
      '  PREV_ENTRY=$(sed -n "s/^ENTRY=//p" "$M" | head -1)',
      '  if [ "$PREV_SPEC" = "$SPEC" ] && [ -n "$PREV_ENTRY" ] && [ -x "$PREV_ENTRY" ]; then',
      '    echo "OCRC_SKIPPED=1"; echo "OCRC_ENTRY=$PREV_ENTRY"; echo "OCRC_DIR=$D"',
      '    sed -n "s/^VERSION=/OCRC_VERSION=/p" "$M"',
      '    echo "RUNTIME_DONE=1"; exit 0',
      "  fi",
      "fi"
    ],
    'if [ -d "$D" ]; then PRE_EXISTING=1; else PRE_EXISTING=0; fi',
    // 失败收尾：先还原旧 marker，再只删「这次刚建出来且仍无 marker」的槽位。
    "cleanup_failed() {",
    '  if [ -f "$M' + RUNTIME_BACKUP_SUFFIX + '" ] && [ ! -f "$M" ]; then mv "$M' + RUNTIME_BACKUP_SUFFIX + '" "$M"; fi',
    '  if [ "$PRE_EXISTING" = "0" ] && [ ! -f "$M" ]; then rm -rf "$D" && rmdir "$(dirname "$D")" 2>/dev/null; fi',
    "}",
    "fail_runtime() {",
    "  cleanup_failed",
    '  echo "OCRC_ERR=$1"',
    '  if [ -n "$2" ]; then echo "OCRC_GOT=$2"; fi',
    '  echo "RUNTIME_DONE=1"; exit 0',
    "}",
    'mkdir -p "$ROOT" || fail_runtime root',
    'mkdir -p "$D" || fail_runtime dir',
    'if [ -f "$M" ]; then cp -p "$M" "$M' + RUNTIME_BACKUP_SUFFIX + '"; fi',
    // ── 取件：npm 自己下（--prefix 落点、不写 package.json/lock，保持目录干净）──
    // 参数直接写在命令行上，不攒成字符串变量：`$D` 可能带空格，重新分词会把它拆开
    // （而且 `\"$D\"` 展开后引号是字面量，不是引用）。
    'if ! npm install --prefix "$D" --no-save --no-package-lock --no-audit --no-fund --loglevel=error' + (options.registry ? ` --registry ${q3(options.registry)}` : "") + ' "$SPEC" >"$D/.ocrc-npm.log" 2>&1; then',
    '  fail_runtime install "$(tail -3 "$D/.ocrc-npm.log" 2>/dev/null | tr "\\n" " " | head -c 300)"',
    "fi",
    // ── 入口：读已装包自己的 bin（npm 元数据），优先 .bin 垫片 ──
    `printf '%s' ${q3(helperB64)} | (base64 -d 2>/dev/null || openssl base64 -d 2>/dev/null) > "$HELPER"`,
    '[ -s "$HELPER" ] || fail_runtime helper',
    'RESOLVED=$(node "$HELPER" "$D" "$PKG" 2>/dev/null)',
    'if [ -z "$RESOLVED" ] || [ "$RESOLVED" = "NO_BIN" ]; then fail_runtime no-bin; fi',
    'ENTRY=$(printf "%s\\n" "$RESOLVED" | head -1)',
    'VERSION=$(printf "%s\\n" "$RESOLVED" | sed -n "s/^OCRC_VERSION=//p" | head -1)',
    'if [ ! -e "$ENTRY" ]; then fail_runtime entry-missing "$ENTRY"; fi',
    // ── marker：key=value（ssh 面越笨越好，解析复用同一套）──
    'cat > "$D/.ocrc-marker.tmp" <<OCRC_RUNTIME_MARKER',
    "SPEC=$SPEC",
    "PACKAGE=$PKG",
    "VERSION=$VERSION",
    "ENTRY=$ENTRY",
    "SLOT=" + slot,
    `INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    "OCRC_RUNTIME_MARKER",
    'mv "$D/.ocrc-marker.tmp" "$M" || fail_runtime marker',
    'echo "OCRC_OK=1"',
    'echo "OCRC_ENTRY=$ENTRY"',
    'echo "OCRC_VERSION=$VERSION"',
    'echo "OCRC_DIR=$D"',
    'if [ -f "$M' + RUNTIME_BACKUP_SUFFIX + '" ]; then echo "OCRC_BACKUP=$M' + RUNTIME_BACKUP_SUFFIX + '"; fi',
    'echo "RUNTIME_DONE=1"'
  ].join("\n");
}
var RUNTIME_ERRORS = {
  "no-npm": "\u76EE\u6807\u673A\u6CA1\u6709 npm\u2014\u2014\u8FD0\u884C\u65F6\u8981\u9760\u5B83\u88C5",
  "no-node": "\u76EE\u6807\u673A\u6CA1\u6709 node\u2014\u2014npm \u5F62\u6001\u7684\u8FD0\u884C\u65F6\u9700\u8981\u5B83",
  root: "\u5728\u76EE\u6807\u673A\u4E0A\u521B\u5EFA ~/.ocrc/runtime \u5931\u8D25\uFF08$HOME \u4E0D\u53EF\u5199\uFF1F\uFF09",
  dir: "\u5728\u76EE\u6807\u673A\u4E0A\u521B\u5EFA\u8FD0\u884C\u76EE\u5F55\u5931\u8D25",
  install: "npm \u5B89\u88C5\u5931\u8D25",
  helper: "\u628A\u5165\u53E3\u89E3\u6790\u5668\u5199\u5230\u76EE\u6807\u673A\u5931\u8D25\uFF08base64/openssl \u90FD\u4E0D\u53EF\u7528\uFF1F\uFF09",
  "no-bin": "\u8FD9\u4E2A\u5305\u6CA1\u6709\u53EF\u6267\u884C\u5165\u53E3\uFF08package.json \u91CC\u6CA1\u6709 bin\uFF09\u2014\u2014\u5B83\u662F\u5E93\u800C\u4E0D\u662F\u670D\u52A1",
  "entry-missing": "\u89E3\u6790\u51FA\u6765\u7684\u5165\u53E3\u5728\u76EE\u6807\u673A\u4E0A\u4E0D\u5B58\u5728",
  marker: "\u5199 marker \u5931\u8D25"
};
function parseRuntimeInstallOutput(stdout, expectedSpec) {
  const fields = /* @__PURE__ */ new Map();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const err = fields.get("OCRC_ERR");
  if (err) {
    const got = fields.get("OCRC_GOT");
    return { ok: false, error: `${RUNTIME_ERRORS[err] ?? `\u5B89\u88C5\u5931\u8D25\uFF08${err}\uFF09`}${got ? `\uFF1A${got.trim()}` : ""}` };
  }
  if (fields.get("OCRC_OK") !== "1" && fields.get("OCRC_SKIPPED") !== "1") {
    return { ok: false, error: `\u5B89\u88C5\u811A\u672C\u6CA1\u6709\u7ED9\u51FA\u7ED3\u679C\uFF08${expectedSpec}\uFF1B\u8FDE\u63A5\u4E2D\u65AD\u6216\u88AB kill\uFF09` };
  }
  return {
    ok: true,
    skipped: fields.get("OCRC_SKIPPED") === "1",
    entry: fields.get("OCRC_ENTRY")?.trim(),
    version: fields.get("OCRC_VERSION")?.trim(),
    dir: fields.get("OCRC_DIR")?.trim(),
    backup: fields.get("OCRC_BACKUP")?.trim()
  };
}
function buildRuntimeRemoveScript(dir) {
  return [
    `D=${q3(dir)}`,
    `if [ -f "$D/${RUNTIME_MARKER_NAME}" ]; then rm -rf "$D" && echo "OCRC_REMOVED=1"; else echo "OCRC_REMOVED=0"; fi`
  ].join("\n");
}

// src/service/provision.ts
var SSH_TIMEOUT_MS = 6e4;
var INSTALL_TIMEOUT_MS = 15 * 6e4;
function createProvisioner(deps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const home = deps.home ?? homedir4();
  const cacheDir = deps.cacheDir ?? process.env.OCRC_CACHE_DIR?.trim() ?? defaultCacheDir(home);
  const execLocal = deps.execLocal ?? defaultExecLocal;
  async function anchorVersion(override) {
    if (override) return { version: override, source: "\u6863\u6848\uFF08\u9762\u677F\u5BBF\u4E3B\u672A\u63D0\u4F9B\u5F15\u64CE\uFF09" };
    const fromEnv = process.env.OCRC_ENGINE_VERSION?.trim();
    if (fromEnv) return { version: normalizeVersion(fromEnv), source: "OCRC_ENGINE_VERSION" };
    const binary = installDirFor(home) + "/opencode";
    const stdout = await execLocal(binary, ["--version"]).catch(() => "");
    const version = stdout ? normalizeVersion(stdout) : "";
    if (version && isSupportedEngineVersion2(version)) return { version, source: `\u9762\u677F\u5BBF\u4E3B ${binary}` };
    return { source: "\u9762\u677F\u5BBF\u4E3B\u6CA1\u6709\u53EF\u7528\u7684 opencode v2" };
  }
  async function inspect(profile, options = {}) {
    const { code, stdout, stderr } = await deps.exec(profile, buildDetectScript(), { timeoutMs: SSH_TIMEOUT_MS });
    const detect = toDetectReport(stdout, { reachable: code === 0, stderr });
    const anchor = await anchorVersion(options.anchor ?? profile.engineVersion);
    return {
      detect,
      readiness: toReadiness(detect, { projectPath: profile.projects?.[0]?.path, anchorVersion: anchor.version }),
      anchor: anchor.version,
      anchorSource: anchor.source
    };
  }
  async function plan(profile, report, options = {}) {
    if (!report.reachable || !report.platform) {
      return { error: report.unsupportedReason ?? report.error ?? "\u76EE\u6807\u673A\u4E0D\u53EF\u8FBE\uFF0C\u65E0\u6CD5\u89C4\u5212\u90E8\u7F72" };
    }
    const anchor = await anchorVersion(options.anchor ?? profile.engineVersion);
    if (!anchor.version) {
      return { error: `${anchor.source}\u2014\u2014\u9762\u677F\u5BBF\u4E3B\u5FC5\u987B\u6709\u4E00\u4EFD\u53EF\u7528\u7684 opencode v2 \u4F5C\u4E3A\u7248\u672C\u6E90\uFF08D6\uFF1A\u955C\u50CF\u9762\u677F\u5BBF\u4E3B\uFF0C\u4E0D follow latest\uFF09` };
    }
    if (report.unsupportedReason) return { error: report.unsupportedReason };
    const variant = report.baseline && report.platform.endsWith("x64") ? "baseline" : "default";
    let artifact;
    try {
      artifact = await resolveArtifact(report.platform, variant, anchor.version, { fetchImpl, registry: deps.registry });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const identity = parseIdentityOutput(
      (await deps.exec(profile, buildIdentityScript(report.home ?? ""), { timeoutMs: SSH_TIMEOUT_MS })).stdout
    );
    const decision = decideInstall(identity, { version: anchor.version, integrity: artifact.integrity });
    const source = report.outbound ? "remote" : "push";
    const remoteHome = report.home ?? "/home/unknown";
    return {
      plan: {
        action: decision.action === "none" ? "none" : decision.action === "install" ? "install" : decision.action,
        target: report.platform,
        variant,
        package: platformPackage(report.platform, variant),
        version: anchor.version,
        integrity: artifact.integrity,
        source,
        installDir: installDirFor(remoteHome),
        home: remoteHome,
        currentVersion: identity.version,
        reason: `${decision.reason}\uFF1B\u53D6\u4EF6\u65B9\u5F0F\uFF1A${source === "remote" ? `\u88AB\u63A7\u7AEF\u81EA\u5DF1\u4E0B\u8F7D\uFF08\u51FA\u7F51\u53EF\u8FBE\uFF0C${anchor.source}\uFF09` : "\u4ECE\u9762\u677F\u63A8\u9001\u7F13\u5B58\u5DE5\u4EF6\uFF08\u88AB\u63A7\u7AEF\u4E0D\u51FA\u7F51\uFF09"}`,
        anchorVersion: anchor.version
      },
      artifact
    };
  }
  async function apply(profile, plan2, artifact) {
    if (plan2.action === "none") return { ok: true, version: plan2.currentVersion };
    let uploadedTar;
    if (plan2.source === "push") {
      const cached = await cachedArtifactPath(artifact, cacheDir);
      if (!cached) {
        return { ok: false, error: "\u672C\u5730\u7F13\u5B58\u91CC\u6CA1\u6709\u8FD9\u4EFD\u5DE5\u4EF6\u2014\u2014\u5148\u5728\u9762\u677F\u4FA7\u8054\u7F51\u6267\u884C\u4E00\u6B21\u300C\u4E0B\u8F7D\u5DE5\u4EF6\u300D\uFF0C\u518D\u63A8\u7ED9\u4E0D\u51FA\u7F51\u7684\u88AB\u63A7\u673A" };
      }
      const remoteTar = `$HOME/.ocrc-upload-${artifact.version}.tgz`;
      const bytes = await readFile2(cached);
      const upload = await deps.exec(
        profile,
        `mkdir -p "$HOME/.ocrc" && base64 -d > ${remoteTar} && echo OCRC_UPLOADED=1`,
        { timeoutMs: INSTALL_TIMEOUT_MS, stdin: bytes.toString("base64") }
      ).catch((error) => ({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      if (upload.code !== 0 || !upload.stdout.includes("OCRC_UPLOADED=1")) {
        return { ok: false, error: `\u63A8\u9001\u5DE5\u4EF6\u5931\u8D25\uFF1A${upload.stderr.trim().split("\n")[0] || "ssh \u4E2D\u65AD"}` };
      }
      uploadedTar = remoteTar;
    }
    const script = buildInstallScript({
      home: plan2.home,
      version: plan2.version,
      integrity: plan2.integrity,
      packageName: plan2.package,
      platform: plan2.target,
      uploadedTar,
      downloadUrl: plan2.source === "remote" ? artifact.tarballUrl : void 0
    });
    const { stdout, stderr } = await deps.exec(profile, script, { timeoutMs: INSTALL_TIMEOUT_MS });
    const outcome = parseInstallOutput(stdout, plan2.integrity);
    if (!outcome.ok) {
      const sshSaid = stderr.trim().split("\n")[0];
      const silent = !stdout.includes("OCRC_ERR=") && !stdout.includes("OCRC_OK=");
      return {
        ...outcome,
        error: silent && sshSaid ? `\u5B89\u88C5\u6CA1\u6709\u843D\u76D8\uFF1A${sshSaid}` : outcome.error
      };
    }
    return outcome;
  }
  async function rollback(profile, platform, homeDir) {
    const { stdout } = await deps.exec(profile, buildRollbackScript(homeDir, platform), { timeoutMs: SSH_TIMEOUT_MS });
    return stdout.includes("OCRC_ROLLED_BACK=1");
  }
  async function uninstall(profile, homeDir) {
    const { stdout } = await deps.exec(profile, buildUninstallScript(homeDir), { timeoutMs: SSH_TIMEOUT_MS });
    return stdout.includes("OCRC_UNINSTALLED=1");
  }
  async function prefetch(artifact) {
    return { path: await fetchArtifactToCache(artifact, { dir: cacheDir, fetchImpl }) };
  }
  async function planRuntime(profile, needs, options = {}) {
    const detect = options.detect ?? (await inspect(profile, { anchor: options.anchor })).detect;
    const home2 = detect.home ?? "";
    if (needs.length === 0) return buildRuntimePlan([], factsFromDetect(detect, home2), /* @__PURE__ */ new Map());
    const discovery = await deps.exec(profile, buildRuntimeDiscoverScript(home2, needs.map((n) => n.need)), { timeoutMs: SSH_TIMEOUT_MS });
    return buildRuntimePlan(needs, factsFromDetect(detect, home2), parseRuntimeDiscoverOutput(discovery.stdout, needs.map((n) => n.need)));
  }
  async function applyRuntime(profile, item, options) {
    if (item.action !== "install") {
      return {
        ok: false,
        error: item.action === "present" ? "\u8FD9\u4E00\u9879\u5728\u76EE\u6807\u673A\u4E0A\u5DF2\u7ECF\u5C31\u4F4D\uFF0C\u65E0\u9700\u5B89\u88C5" : `\u8FD9\u4E00\u9879\u88C5\u4E0D\u4E86\uFF1A${item.reason ?? "\u539F\u56E0\u672A\u77E5"}`
      };
    }
    const script = buildRuntimeInstallScript({
      home: options.home,
      need: item.need,
      // 验收用本地 fixture registry；产品路径固定是官方 registry。
      registry: options.registry ?? deps.registry,
      force: options.force
    });
    const { code, stdout, stderr } = await deps.exec(profile, script, { timeoutMs: INSTALL_TIMEOUT_MS });
    const outcome = parseRuntimeInstallOutput(stdout, item.need.raw);
    if (!outcome.ok) {
      const said = stderr.trim().split("\n")[0];
      const silent = !stdout.includes("OCRC_ERR=") && !stdout.includes("RUNTIME_DONE=1");
      return { ...outcome, error: silent && said ? `\u5B89\u88C5\u6CA1\u6709\u843D\u76D8\uFF1A${said}` : outcome.error ?? `ssh exit ${code}` };
    }
    return outcome;
  }
  async function removeRuntime(profile, dir) {
    const { stdout } = await deps.exec(profile, buildRuntimeRemoveScript(dir), { timeoutMs: SSH_TIMEOUT_MS });
    return stdout.includes("OCRC_REMOVED=1");
  }
  return {
    inspect,
    plan,
    apply,
    rollback,
    uninstall,
    prefetch,
    planRuntime,
    applyRuntime,
    removeRuntime,
    anchorVersion,
    cacheDir
  };
}
function defaultExecLocal(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn6(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}`)));
  });
}

// src/service/capabilities.ts
function capabilitiesFromConfig(config) {
  const out = [];
  const mcp = config.mcp;
  if (mcp && typeof mcp === "object") {
    const servers = mcp.servers;
    if (servers && typeof servers === "object") {
      for (const [name, raw] of Object.entries(servers)) {
        if (!raw || typeof raw !== "object") continue;
        const declaration = raw;
        out.push(capabilityFromMcp(name, declaration));
      }
    }
  }
  return out;
}
function splitCommand(command) {
  if (Array.isArray(command)) return command.map((part) => String(part));
  if (typeof command === "string") return command.split(/\s+/).filter(Boolean);
  return [];
}
function packageNameOf(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}
function splitNpxCommand(command) {
  const argv = splitCommand(command);
  const index = argv.findIndex((part) => part === "npx" || part === "bunx");
  if (index < 0) return null;
  const tail = argv.slice(index + 1);
  const specIndex = tail.findIndex((part) => !part.startsWith("-"));
  if (specIndex < 0) return null;
  return { prefix: argv[index], spec: tail[specIndex], rest: tail.slice(specIndex + 1) };
}
function capabilityFromMcp(name, declaration) {
  const parser = splitNpxCommand(declaration.command);
  const argv = splitCommand(declaration.command);
  const runtime = [];
  const network = [];
  const secrets = [];
  if (parser) runtime.push(parser.spec);
  else if (argv.length > 0) runtime.push(argv[0]);
  const urls = /* @__PURE__ */ new Set();
  if (typeof declaration.url === "string") urls.add(declaration.url);
  for (const value of Object.values(declaration.environment ?? {})) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) urls.add(value);
  }
  network.push(...urls);
  for (const [key, value] of Object.entries(declaration.environment ?? {})) {
    const literal = typeof value === "string" && !/^\{.*\}$/.test(value) && !/^https?:\/\//.test(value) && looksSecret(key);
    if (literal) secrets.push(key);
  }
  return {
    id: `mcp:${name}`,
    label: `MCP ${name}`,
    where: "remote",
    needs: {
      ...secrets.length > 0 ? { secrets } : {},
      ...network.length > 0 ? { network } : {},
      ...runtime.length > 0 ? { runtime } : {}
    },
    ...typeof declaration.url === "string" && /^https?:/.test(declaration.url) ? { note: `\u8FDC\u7A0B MCP\uFF08${declaration.url}\uFF09\u2014\u2014\u51ED\u636E\u5185\u5D4C\u5728 URL \u91CC\u65F6\u8981\u6309\u80FD\u529B\u642C\u8FD0` } : {}
  };
}
function looksSecret(key) {
  return /(key|token|secret|password|passwd|credential|apikey)/i.test(key);
}
function packageVersionOf(spec) {
  const at = spec.lastIndexOf("@");
  const version = at > 0 ? spec.slice(at + 1).trim() : "";
  return version || void 0;
}
function classifyRuntimeNeed(raw) {
  const text = String(raw ?? "").trim();
  if (text.startsWith("/") || text.startsWith("~/")) return { raw: text, kind: "path", name: text };
  return { raw: text, kind: "npm", name: packageNameOf(text), version: packageVersionOf(text) };
}
function runtimeNeedsOf(packages) {
  const table = /* @__PURE__ */ new Map();
  for (const pkg of packages) {
    for (const raw of pkg.needs.runtime ?? []) {
      const text = String(raw).trim();
      if (!text) continue;
      const existing = table.get(text);
      if (existing) {
        if (!existing.neededBy.includes(pkg.id)) existing.neededBy.push(pkg.id);
        continue;
      }
      table.set(text, { need: classifyRuntimeNeed(text), neededBy: [pkg.id] });
    }
  }
  return [...table.values()];
}
function rewriteNpxCommand(command, installedPath) {
  const parsed = splitNpxCommand(command);
  if (!parsed) return null;
  return [installedPath, ...parsed.rest].join(" ");
}
function applyNpxRewrites(config, installed) {
  const next = structuredClone(config);
  const rewritten = [];
  const mcp = next.mcp;
  if (!mcp?.servers) return { config: next, rewritten };
  for (const [name, raw] of Object.entries(mcp.servers)) {
    if (!raw || typeof raw !== "object") continue;
    const declaration = raw;
    const parsed = splitNpxCommand(declaration.command);
    if (!parsed) continue;
    const replacement = installed[parsed.spec] ?? installed[packageNameOf(parsed.spec)];
    if (!replacement) continue;
    const before = splitCommand(declaration.command).join(" ");
    const command = rewriteNpxCommand(declaration.command, replacement);
    if (!command) continue;
    declaration.command = Array.isArray(declaration.command) ? command.split(" ") : command;
    rewritten.push({ capability: `mcp:${name}`, from: before, to: command });
  }
  return { config: next, rewritten };
}

// src/service/tunnels.ts
import { createServer } from "node:net";
var systemPortAllocator = () => new Promise((resolve, reject) => {
  const server2 = createServer();
  server2.unref();
  server2.on("error", reject);
  server2.listen(0, "127.0.0.1", () => {
    const address = server2.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server2.close(() => port > 0 ? resolve(port) : reject(new Error("\u6CA1\u6709\u5206\u914D\u5230\u53EF\u7528\u7AEF\u53E3")));
  });
});
function parseAddress(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!url.hostname) return null;
  return { host: url.hostname, port, url };
}
function isPanelLocal(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
function rewriteAddress(address, host, peerPort, localPort) {
  const explicit = `${host}:${peerPort}`;
  if (address.includes(explicit)) return address.replace(explicit, `127.0.0.1:${localPort}`);
  return address.replace(host, `127.0.0.1:${localPort}`);
}
function isPortFree(port) {
  return new Promise((resolve) => {
    const server2 = createServer();
    server2.unref();
    server2.once("error", () => resolve(false));
    server2.listen(port, "127.0.0.1", () => server2.close(() => resolve(true)));
  });
}
async function settleForwardPorts(forwards, deps = {}) {
  const isFree = deps.isFree ?? isPortFree;
  const allocate = deps.allocate ?? systemPortAllocator;
  const settled = [];
  const changed = [];
  const taken = /* @__PURE__ */ new Set();
  for (const forward of forwards) {
    if (forward.port && !taken.has(forward.port) && await isFree(forward.port)) {
      taken.add(forward.port);
      settled.push(forward);
      continue;
    }
    let next = 0;
    for (let attempt = 0; attempt < 8 && !next; attempt += 1) {
      const candidate = await allocate();
      if (!taken.has(candidate) && await isFree(candidate)) next = candidate;
    }
    if (!next) throw new Error(`\u6CA1\u6709\u53EF\u7528\u7684\u672C\u5730\u7AEF\u53E3\uFF08${forward.reason}\uFF09`);
    taken.add(next);
    if (forward.port) changed.push({ reason: forward.reason, from: forward.port, to: next });
    settled.push({ ...forward, port: next });
  }
  return { settled, changed };
}
async function planForwards(packages, options) {
  const allocate = options.allocatePort ?? systemPortAllocator;
  const specs = [];
  const rewrites = [];
  const notes = [];
  for (const pkg of packages) {
    for (const address of pkg.needs.network ?? []) {
      const parsed = parseAddress(address);
      if (!parsed) {
        notes.push(`${pkg.label}\uFF1A${address} \u4E0D\u662F\u53EF\u89E3\u6790\u7684 http(s) \u5730\u5740\uFF0C\u65E0\u6CD5\u4E3A\u5B83\u8865\u96A7\u9053`);
        continue;
      }
      if (isPanelLocal(parsed.host)) continue;
      if (pkg.where === "remote") {
        notes.push(`${pkg.label}\uFF1A\u8DD1\u5728\u88AB\u63A7\u7AEF\uFF0C${parsed.host}:${parsed.port} \u7531\u88AB\u63A7\u7AEF\u81EA\u5DF1\u7684\u8DEF\u7531\u8D1F\u8D23\uFF0C\u4E0D\u52A0\u96A7\u9053`);
        continue;
      }
      if (await options.panelReachable(parsed.host, parsed.port)) {
        notes.push(`${pkg.label}\uFF1A\u9762\u677F\u5DF2\u8FBE ${parsed.host}:${parsed.port}\uFF0C\u4E0D\u52A0\u96A7\u9053`);
        continue;
      }
      const port = await allocate();
      specs.push({
        direction: "local",
        peerHost: parsed.host,
        peerPort: parsed.port,
        port,
        reason: `${pkg.label}\uFF08\u9762\u677F\u4FA7\u80FD\u529B\uFF09\u9700\u8981 ${parsed.host}:${parsed.port}`
      });
      rewrites.push({ from: address, to: rewriteAddress(address, parsed.host, parsed.port, port) });
    }
  }
  return { specs, rewrites, notes };
}

// src/service/config-project.ts
var PROJECT_CONFIG_BASENAMES = ["opencode.jsonc", "opencode.json"];
var q4 = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
function buildProjectConfigReadScript(projectPath) {
  const dir = projectPath.replace(/\/+$/, "");
  return [
    `D=${q4(dir)}`,
    "for name in opencode.jsonc opencode.json; do",
    '  f="$D/$name"',
    '  if [ -f "$f" ]; then',
    '    echo "FOUND=$name"',
    '    echo "SIZE=$(wc -c < "$f" | tr -d " ")"',
    '    echo "B64_BEGIN"',
    '    base64 < "$f"',
    '    echo "B64_END"',
    "    break",
    "  fi",
    "done",
    'echo "READ_DONE=1"'
  ].join("\n");
}
function parseProjectConfigRead(stdout, projectPath) {
  const target = `${projectPath.replace(/\/+$/, "")}`;
  const found = /^FOUND=(\S+)$/m.exec(stdout)?.[1];
  const block = /B64_BEGIN\r?\n([\s\S]*?)\r?\nB64_END/.exec(stdout);
  if (!found || !block) {
    return {
      projectPath,
      targetPath: `${target}/${PROJECT_CONFIG_BASENAMES[0]}`,
      format: "missing",
      exists: false
    };
  }
  const raw = Buffer.from(block[1].replace(/[\r\n]/g, ""), "base64").toString("utf-8");
  const format2 = found.endsWith(".jsonc") ? "jsonc" : "json";
  const result = {
    projectPath,
    targetPath: `${target}/${found}`,
    format: format2,
    exists: true,
    raw
  };
  if (format2 === "jsonc" && /(^|\n)\s*(\/\/|\/\*)/.test(raw)) result.commentsWillBeLost = true;
  try {
    const parsed = JSON.parse(format2 === "jsonc" ? stripJsonc(raw) : raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      result.parseError = "\u9876\u5C42\u4E0D\u662F\u5BF9\u8C61";
    } else {
      result.parsed = parsed;
    }
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
  }
  return result;
}
function mergeSticky(remote, panel) {
  const out = { ...remote };
  for (const [key, value] of Object.entries(panel)) {
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
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasChanges(remote, merged) {
  return JSON.stringify(sortKeys(remote)) !== JSON.stringify(sortKeys(merged));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}
function buildProjectConfigWriteScript(targetPath, base64) {
  const script = [
    "set -e",
    `P=${q4(targetPath)}`,
    'D=$(dirname "$P")',
    'mkdir -p "$D"',
    'T=$(mktemp "$D/.ocrc-cfg.XXXXXX")',
    'base64 -d > "$T"',
    'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak" && echo "OCRC_BAK=$P.ocrc-bak"; fi',
    'mv "$T" "$P"',
    'echo "OCRC_WRITTEN=$P"'
  ].join("\n");
  return { script, stdin: base64 };
}
var PROJECT_WRITE_SECTIONS = ["agent", "mcp", "provider", "agents", "model", "small_model", "permission", "instructions"];
function extractProjectSections(panelConfig) {
  const out = {};
  for (const section of PROJECT_WRITE_SECTIONS) {
    const value = panelConfig[section];
    if (value !== void 0) out[section] = value;
  }
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

// src/service/auth-sync.ts
var AUTH_RELATIVE_PATH = ".local/share/opencode/auth.json";
function authPathFor(home) {
  return `${home.replace(/\/+$/, "")}/${AUTH_RELATIVE_PATH}`;
}
function buildAuthReadScript(home) {
  const path = authPathFor(home);
  const q5 = `'${path.replaceAll("'", `'\\''`)}'`;
  return [
    `P=${q5}`,
    'if [ -f "$P" ]; then echo "AUTH_EXISTS=yes"; echo "AUTH_BEGIN"; base64 < "$P"; echo; echo "AUTH_END";',
    'else echo "AUTH_EXISTS=no"; fi',
    'echo "AUTH_READ_DONE=1"'
  ].join("\n");
}
function parseAuthRead(stdout) {
  const exists = /AUTH_EXISTS=yes/.test(stdout);
  if (!exists) return {};
  const block = /AUTH_BEGIN\r?\n([\s\S]*?)\r?\nAUTH_END/.exec(stdout);
  if (!block) return {};
  try {
    const text = Buffer.from(block[1].replace(/[\r\n]/g, ""), "base64").toString("utf-8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function compareAuth(panel, remote) {
  const panelProviders = Object.keys(panel).sort();
  const remoteProviders = Object.keys(remote).sort();
  const remoteSet = new Set(remoteProviders);
  const panelSet = new Set(panelProviders);
  return {
    panelProviders,
    remoteProviders,
    missing: panelProviders.filter((p) => !remoteSet.has(p)),
    overlapping: panelProviders.filter((p) => remoteSet.has(p)),
    remoteOnly: remoteProviders.filter((p) => !panelSet.has(p))
  };
}
function mergeAuth(panel, remote) {
  const out = { ...remote };
  for (const [provider, entry] of Object.entries(panel)) {
    if (entry === void 0) continue;
    out[provider] = entry;
  }
  return out;
}
function authHasChanges(panel, remote) {
  return JSON.stringify(mergeAuth(panel, remote)) !== JSON.stringify(remote);
}
function buildAuthWriteScript(home, base64) {
  const path = authPathFor(home);
  const q5 = `'${path.replaceAll("'", `'\\''`)}'`;
  const script = [
    "set -e",
    `P=${q5}`,
    'D=$(dirname "$P")',
    'mkdir -p "$D"',
    'chmod 700 "$D" 2>/dev/null || true',
    'T=$(mktemp "$D/.ocrc-auth.XXXXXX")',
    "umask 077",
    'base64 -d > "$T"',
    'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak" && echo "OCRC_BAK=$P.ocrc-bak"; fi',
    'mv "$T" "$P"',
    'chmod 600 "$P"',
    'echo "OCRC_AUTH_WRITTEN=$P"'
  ].join("\n");
  return { script, stdin: base64 };
}
function panelAuthPath(env = process.env) {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return `${xdg.replace(/[\\/]+$/, "")}/opencode/auth.json`;
  if (env.APPDATA && process.platform === "win32" && !env.HOME) return `${env.APPDATA}\\opencode\\auth.json`;
  const home = (env.HOME ?? env.USERPROFILE ?? "").replace(/[\\/]+$/, "");
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}.local${sep}share${sep}opencode${sep}auth.json`;
}

// src/service/main.ts
import { connect as netConnect } from "node:net";
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var PROFILES_FILE = process.env.OCRC_CONNECT_PROFILES ?? join9(process.env.OPENCHAMBER_DATA_DIR ?? join9(homedir5(), ".config", "openchamber"), "ocrc-connect-profiles.json");
function loadProfiles() {
  try {
    const raw = JSON.parse(readFileSync5(PROFILES_FILE, "utf-8"));
    return (raw.profiles ?? []).map((p) => normalizeProfile(p));
  } catch {
    return [];
  }
}
function saveProfiles(profiles) {
  mkdirSync5(join9(PROFILES_FILE, ".."), { recursive: true });
  writeFileSync4(PROFILES_FILE, JSON.stringify({ profiles }, null, 2));
}
var supervisor = createTunnelSupervisor();
var provisioner = createProvisioner({
  exec: (profile, script, options) => sshExec(profile, script, options),
  // 验收脚本用本地 fixture registry 跑完整装链（含 sha512 校验），产品路径不带这个环境变量。
  registry: process.env.OCRC_REGISTRY?.trim() || void 0,
  cacheDir: process.env.OCRC_CACHE_DIR?.trim() || void 0
});
var remoteInstances = createRemoteInstancesStore(remoteInstancesPath(ocrcHome()), { flushOnExit: false });
var remoteManager = createRemoteInstanceManager({ store: remoteInstances, tunnelOwner: "external" });
var remoteOps = createRemoteInstanceOps({ store: remoteInstances, manager: remoteManager });
function requireProfile(res) {
  const profile = supervisor.activeProfile();
  if (!profile) {
    json(res, 409, { error: "no active profile \u2014 connect first" });
    return null;
  }
  return profile;
}
function requireTargetHome(res, raw) {
  const home = String(raw ?? "").trim();
  if (!home.startsWith("/") || home === "/" || home.includes("..")) {
    json(res, 400, { error: "home \u5FC5\u987B\u662F\u88AB\u63A7\u673A\u7684 $HOME \u7EDD\u5BF9\u8DEF\u5F84\uFF08\u5F15\u64CE\u843D\u70B9 <home>/.opencode/bin\uFF09" });
    return null;
  }
  return home.replace(/\/+$/, "");
}
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function readProjectConfig(profile, projectPath) {
  const { stdout } = await sshExec(profile, buildProjectConfigReadScript(projectPath), { timeoutMs: 3e4 });
  return parseProjectConfigRead(stdout, projectPath);
}
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
var server = http3.createServer(async (req, res) => {
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
    if (req.method === "GET" && url.pathname === "/status") {
      json(res, 200, { status: await supervisor.statusProbed(), profiles: loadProfiles() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/profiles") {
      const body = await readBody(req);
      const profiles = loadProfiles();
      const p = normalizeProfile(body.profile);
      const next = [...profiles.filter((x) => x.id !== p.id), p];
      saveProfiles(next);
      json(res, 200, { profiles: next });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/profiles/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const next = loadProfiles().filter((p) => p.id !== id);
      saveProfiles(next);
      json(res, 200, { profiles: next });
      return;
    }
    if (req.method === "POST" && url.pathname === "/connect") {
      const body = await readBody(req);
      const profiles = loadProfiles();
      const p = profiles.find((x) => x.id === body.profileId);
      if (!p) {
        json(res, 404, { error: "profile not found" });
        return;
      }
      if (!existsSync5("/usr/bin/ssh") && !existsSync5("/bin/ssh") && process.platform !== "win32") {
      }
      supervisor.start(p);
      json(res, 200, { status: await supervisor.statusProbed() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/disconnect") {
      supervisor.stop();
      json(res, 200, { status: supervisor.status() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/git-branch") {
      const profile = supervisor.activeProfile();
      const root = profile?.allowedRoots?.[0];
      if (!profile || !root) {
        json(res, 200, { branch: null });
        return;
      }
      const { code, stdout } = await sshExec(profile, buildGitScript(root, "status"), { timeoutMs: 8e3 });
      if (code !== 0) {
        json(res, 200, { branch: null });
        return;
      }
      json(res, 200, { branch: parseGitStatus(stdout).branch ?? null });
      return;
    }
    if (url.pathname.startsWith("/fs/") || url.pathname.startsWith("/git/")) {
      const profile = supervisor.activeProfile();
      if (!profile) {
        json(res, 409, { error: "no active profile \u2014 connect first" });
        return;
      }
      const roots = profile.allowedRoots ?? [];
      const body = req.method === "POST" ? await readBody(req) : {};
      const vpath = normalizeVirtualPath(String(body.path ?? url.searchParams.get("path") ?? ""));
      if (!vpath) {
        json(res, 400, { error: "path must be absolute without .. segments" });
        return;
      }
      if (roots.length === 0 || !isInsideRoots(vpath, roots)) {
        json(res, 403, { error: `path outside allowedRoots (${roots.join(", ") || "none declared"})` });
        return;
      }
      const R = profile;
      if (req.method === "POST" && url.pathname === "/fs/list") {
        const { code, stdout, stderr } = await sshExec(R, buildListScript(vpath), { timeoutMs: 2e4 });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        const { entries, error } = parseListOutput(stdout);
        if (error) {
          json(res, 404, { error });
          return;
        }
        json(res, 200, { path: vpath, entries });
        return;
      }
      if (req.method === "POST" && url.pathname === "/fs/read") {
        const max = Math.min(Number(body.maxBytes) || 512 * 1024, 2 * 1024 * 1024);
        const { code, stdout, stderr } = await sshExec(R, buildReadScript(vpath, max), { timeoutMs: 3e4 });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        if (stdout.startsWith("ERR: not-a-file")) {
          json(res, 404, { error: "not a file" });
          return;
        }
        if (stdout.startsWith("ERR: too-large:")) {
          json(res, 413, { error: `file larger than ${max} bytes (${stdout.split(":")[2]} total)` });
          return;
        }
        const sizeLine = stdout.split("\n").find((l) => l.startsWith("SIZE:"));
        const b64 = stdout.split("\n").filter((l) => !l.startsWith("SIZE:")).join("");
        json(res, 200, { path: vpath, size: sizeLine ? Number(sizeLine.slice(5)) : void 0, encoding: "base64", content: b64.trim() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/fs/write") {
        const content = typeof body.content === "string" ? body.content : "";
        const b64 = Buffer.from(content, "utf-8").toString("base64");
        const { script, stdin } = buildWriteScript(vpath, b64);
        const { code, stdout, stderr } = await sshExec(R, script, { timeoutMs: 3e4, stdin });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        json(res, 200, { path: vpath, backup: stdout.includes("bak:") ? `${vpath}.bak` : null });
        return;
      }
      if (req.method === "POST" && url.pathname === "/fs/stat") {
        const { code, stdout, stderr } = await sshExec(R, buildStatScript(vpath), { timeoutMs: 15e3 });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        const kv = new Map(stdout.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]));
        json(res, 200, { path: vpath, type: kv.get("type") ?? "missing", size: kv.get("size") ? Number(kv.get("size")) : void 0, mtime: kv.get("mtime") ? Number(kv.get("mtime")) : void 0 });
        return;
      }
      if (req.method === "POST" && url.pathname === "/fs/mkdir") {
        const { code, stderr } = await sshExec(R, buildMkdirScript(vpath), { timeoutMs: 15e3 });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        json(res, 200, { path: vpath });
        return;
      }
      const root = vpath;
      if (req.method === "POST" && url.pathname === "/git/status") {
        const { code, stdout } = await sshExec(R, buildGitScript(root, "status"), { timeoutMs: 2e4 });
        if (code !== 0) {
          json(res, 502, { error: `ssh exit ${code}` });
          return;
        }
        json(res, 200, { root, ...parseGitStatus(stdout) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/git/diff") {
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : void 0;
        const { code, stdout } = await sshExec(R, buildGitScript(root, "diff", { paths }), { timeoutMs: 3e4, maxStdout: 3e5 });
        if (code !== 0) {
          json(res, 502, { error: `ssh exit ${code}` });
          return;
        }
        json(res, 200, { root, diff: stdout });
        return;
      }
      if (req.method === "POST" && url.pathname === "/git/log") {
        const { code, stdout } = await sshExec(R, buildGitScript(root, "log"), { timeoutMs: 2e4 });
        if (code !== 0) {
          json(res, 502, { error: `ssh exit ${code}` });
          return;
        }
        json(res, 200, { root, log: stdout.split("\n").filter((l) => l.trim()).slice(0, 30) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/git/stage") {
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : void 0;
        const { code, stdout, stderr } = await sshExec(R, buildGitScript(root, "stage", { paths }), { timeoutMs: 3e4 });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        json(res, 200, { root, ok: stdout.includes("staged") });
        return;
      }
      if (req.method === "POST" && url.pathname === "/git/commit") {
        const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : void 0;
        if (!message) {
          json(res, 400, { error: "message required" });
          return;
        }
        const { code, stdout } = await sshExec(R, buildGitScript(root, "commit", { message }), { timeoutMs: 3e4 });
        if (code !== 0) {
          json(res, 502, { error: `ssh exit ${code}` });
          return;
        }
        const nothing = stdout.includes("nothing-to-commit");
        json(res, nothing ? 409 : 200, { root, committed: !nothing, output: stdout.trim().split("\n")[0] });
        return;
      }
    }
    if (url.pathname === "/omo/config") {
      const profile = supervisor.activeProfile();
      if (!profile) {
        json(res, 409, { error: "no active profile \u2014 connect first" });
        return;
      }
      const R = profile;
      const scope = url.searchParams.get("scope") ?? "user";
      if (scope !== "user") {
        json(res, 400, { error: `scope '${scope}' \u4E0D\u652F\u6301\u2014\u2014\u9879\u76EE\u5C42\u5199\u5165\u8D70\u5DE5\u4F5C\u533A\u540C\u6B65\u901A\u9053` });
        return;
      }
      if (req.method === "GET") {
        const { code, stdout, stderr } = await sshExec(R, buildOmoReadScript(omoRemotePaths()), { timeoutMs: 2e4 });
        if (code !== 0) {
          json(res, 502, { error: stderr.trim().split("\n")[0] || `ssh exit ${code}` });
          return;
        }
        const { format: format2, size, raw } = parseOmoReadOutput(stdout);
        json(res, 200, summarizeOmoConfig(format2, size, raw));
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const hasStructured = body.preset !== void 0 || body.fallback !== void 0;
        const hasRaw = typeof body.content === "string";
        if (hasStructured === hasRaw) {
          json(res, 400, { error: "\u8BF7\u6C42\u4F53\u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B content\uFF08\u539F\u59CB JSON\uFF09\u6216 preset/fallback\uFF08\u7ED3\u6784\u5316\u7F16\u8F91\uFF09\u4E4B\u4E00" });
          return;
        }
        const rd = await sshExec(R, buildOmoReadScript(omoRemotePaths()), { timeoutMs: 2e4 });
        if (rd.code !== 0) {
          json(res, 502, { error: rd.stderr.trim().split("\n")[0] || `ssh exit ${rd.code}` });
          return;
        }
        const cur = parseOmoReadOutput(rd.stdout);
        if (cur.format === "missing" && hasStructured) {
          json(res, 409, { error: "\u8FDC\u7AEF\u5C1A\u65E0 omo \u914D\u7F6E\u2014\u2014\u5148\u5728\u88AB\u63A7\u7AEF\u8DD1\u4E00\u6B21 oh-my-opencode-slim install \u751F\u6210\u57FA\u51C6\u914D\u7F6E" });
          return;
        }
        let next;
        if (hasRaw) {
          const v = validateOmoWriteContent(body.content);
          if (!v.ok) {
            json(res, 422, { error: v.err });
            return;
          }
          next = v.parsed;
        } else {
          const curParsed = summarizeOmoConfig(cur.format, cur.size, cur.raw);
          if (curParsed.parseError || !curParsed.parsed) {
            json(res, 409, { error: `\u8FDC\u7AEF\u914D\u7F6E\u5F53\u524D\u4E0D\u53EF\u89E3\u6790\uFF0C\u62D2\u7EDD\u76F2\u5199\u8986\u76D6\uFF08\u8BF7\u7528\u539F\u59CB JSON \u7F16\u8F91\u4FEE\u590D\uFF09\uFF1A${curParsed.parseError ?? "unknown"}` });
            return;
          }
          const fallback = body.fallback === void 0 ? void 0 : body.fallback === null ? null : typeof body.fallback === "object" && !Array.isArray(body.fallback) ? sanitizeOmoFallback(body.fallback) : { ok: false, err: "fallback \u5FC5\u987B\u662F\u5BF9\u8C61\u6216 null" };
          if (fallback && "err" in fallback && fallback.ok === false) {
            json(res, 422, { error: fallback.err });
            return;
          }
          const presetOk = body.preset === void 0 || body.preset === null || typeof body.preset === "string" && body.preset.trim() !== "";
          if (!presetOk) {
            json(res, 422, { error: "preset \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\u6216 null\uFF08\u6E05\u9664\uFF09" });
            return;
          }
          if (typeof body.preset === "string" && curParsed.parsed.presets && typeof curParsed.parsed.presets === "object" && !Array.isArray(curParsed.parsed.presets)) {
            const names = Object.keys(curParsed.parsed.presets);
            if (!names.includes(body.preset)) {
              json(res, 422, { error: `\u9884\u8BBE '${body.preset}' \u4E0D\u5B58\u5728\u2014\u2014\u73B0\u6709\uFF1A${names.join(", ")}` });
              return;
            }
          }
          next = applyOmoEdits(curParsed.parsed, {
            preset: body.preset,
            fallback: body.fallback === void 0 ? void 0 : body.fallback === null ? null : fallback.value
          });
        }
        const converted = cur.format === "jsonc";
        const target = converted ? omoRemotePaths().jsonc : omoRemotePaths().json;
        const { script, stdin } = buildOmoWriteScript(target, Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf-8").toString("base64"));
        const wr = await sshExec(R, script, { timeoutMs: 3e4, stdin });
        if (wr.code !== 0) {
          json(res, 502, { error: wr.stderr.trim().split("\n")[0] || `ssh exit ${wr.code}` });
          return;
        }
        const backupLine = wr.stdout.split("\n").find((l) => l.startsWith("bak:"));
        json(res, 200, {
          ok: true,
          target,
          backup: backupLine ? backupLine.slice(5).trim() : null,
          commentsWillBeLost: converted || void 0,
          note: "\u5DF2\u5199\u5165\u2014\u2014v2 \u5BBF\u4E3B\u7EA6 300ms \u5185\u70ED\u91CD\u8F7D\uFF08\u5BF9\u65B0\u7684\u7F16\u6392\u5B50\u4F1A\u8BDD\u751F\u6548\uFF0Cocrc \u4E0D\u91CD\u542F\u5F15\u64CE\uFF09"
        });
        return;
      }
    }
    if (url.pathname.startsWith("/config/")) {
      const profile = supervisor.activeProfile();
      if (!profile) {
        json(res, 409, { error: "no active profile \u2014 connect first" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/config/source") {
        const report = inspectConfigSource();
        json(res, 200, report);
        return;
      }
      if (req.method === "POST" && (url.pathname === "/config/preview" || url.pathname === "/config/apply")) {
        json(res, 410, {
          error: "\u5199\u5165\u5168\u5C40 ~/.config/opencode/opencode.json \u7684\u884C\u4E3A\u5DF2\u79FB\u9664\uFF08\u6539\u5224\uFF1A\u9879\u76EE\u7EA7\u914D\u7F6E\u624D\u5141\u8BB8\u5199\uFF09\u3002\u6539\u7528 POST /project-config { projectPath, config, apply } \u2014\u2014\u76EE\u6807\u662F\u88AB\u63A7\u673A\u9879\u76EE\u76EE\u5F55\u4E0B\u7684 opencode.jsonc\u3002"
        });
        return;
      }
    }
    if (req.method === "POST" && (url.pathname === "/detect" || url.pathname === "/inspect")) {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await provisioner.inspect(profile, { anchor: body.anchor });
      json(res, 200, {
        detect: result.detect,
        readiness: result.readiness,
        anchor: result.anchor,
        anchorSource: result.anchorSource
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/provision/plan") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      const report = body.detect ?? (await provisioner.inspect(profile, { anchor: body.anchor })).detect;
      const planned = await provisioner.plan(profile, report, { anchor: body.anchor });
      if ("error" in planned) {
        json(res, 409, { error: planned.error });
        return;
      }
      json(res, 200, { plan: planned.plan, artifact: planned.artifact });
      return;
    }
    if (req.method === "POST" && url.pathname === "/provision/apply") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      if (body.confirm !== true) {
        json(res, 400, { error: "\u5B89\u88C5\u9700\u8981\u4E00\u6B21\u663E\u5F0F\u786E\u8BA4\uFF08confirm: true\uFF09" });
        return;
      }
      if (!body.plan || !body.artifact) {
        json(res, 400, { error: "plan \u4E0E artifact \u7531 /provision/plan \u7ED9\u51FA" });
        return;
      }
      const outcome = await provisioner.apply(profile, body.plan, body.artifact);
      json(res, outcome.ok ? 200 : 502, outcome);
      return;
    }
    if (req.method === "POST" && url.pathname === "/provision/prefetch") {
      const body = await readBody(req);
      if (!body.artifact) {
        json(res, 400, { error: "artifact \u7531 /provision/plan \u7ED9\u51FA" });
        return;
      }
      try {
        const { path } = await provisioner.prefetch(body.artifact);
        json(res, 200, { ok: true, path });
      } catch (e) {
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/provision/rollback") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      const home = requireTargetHome(res, body.home);
      if (!home) return;
      if (!body.platform) {
        json(res, 400, { error: "platform \u5FC5\u586B" });
        return;
      }
      json(res, 200, { rolledBack: await provisioner.rollback(profile, body.platform, home) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/provision/uninstall") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      if (body.confirm !== true) {
        json(res, 400, { error: "\u5378\u8F7D\u9700\u8981\u4E00\u6B21\u663E\u5F0F\u786E\u8BA4\uFF08confirm: true\uFF09" });
        return;
      }
      const home = requireTargetHome(res, body.home);
      if (!home) return;
      json(res, 200, { uninstalled: await provisioner.uninstall(profile, home) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/capabilities") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      const projectPath = body.projectPath ?? profile.projects?.[0]?.path;
      if (!projectPath) {
        json(res, 400, { error: "\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u5DE5\u4F5C\u76EE\u5F55\uFF08\u6863\u6848\u7684 projects[0]\uFF09" });
        return;
      }
      const config = await readProjectConfig(profile, projectPath);
      const packages = capabilitiesFromConfig(config.parsed ?? {});
      const plan = await planForwards(packages, {
        // 面板能不能直接到达？由面板宿主自己试（服务就在面板宿主上）。
        panelReachable: (host, port) => probeTcp(host, port)
      });
      const runtime = await provisioner.planRuntime(profile, runtimeNeedsOf(packages), { detect: body.detect });
      json(res, 200, {
        capabilities: packages,
        forwards: plan.specs,
        rewrites: plan.rewrites,
        notes: plan.notes,
        config,
        runtime
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/runtime/plan") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      const projectPath = body.projectPath ?? profile.projects?.[0]?.path;
      if (!projectPath) {
        json(res, 400, { error: "\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u5DE5\u4F5C\u76EE\u5F55\uFF08\u6863\u6848\u7684 projects[0]\uFF09" });
        return;
      }
      const config = await readProjectConfig(profile, projectPath);
      const packages = capabilitiesFromConfig(config.parsed ?? {});
      const runtime = await provisioner.planRuntime(profile, runtimeNeedsOf(packages), { detect: body.detect });
      json(res, 200, { projectPath, runtime });
      return;
    }
    if (req.method === "POST" && url.pathname === "/runtime/apply") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      if (body.confirm !== true) {
        json(res, 400, { error: "\u5B89\u88C5\u8FD0\u884C\u65F6\u9700\u8981\u4E00\u6B21\u663E\u5F0F\u786E\u8BA4\uFF08confirm: true\uFF09" });
        return;
      }
      if (!body.item) {
        json(res, 400, { error: "item \u7531 /runtime/plan \u7ED9\u51FA" });
        return;
      }
      const item = body.item;
      const detected = (await provisioner.inspect(profile, {})).detect;
      const home = detected.home ?? "";
      const root = runtimeRootFor(home);
      if (!home || !item.dir || !item.dir.startsWith(`${root}/`)) {
        json(res, 400, { error: `\u5B89\u88C5\u843D\u70B9\u5FC5\u987B\u843D\u5728\u76EE\u6807\u673A\u7684 ${root || "~/.ocrc/runtime"} \u4E4B\u5185` });
        return;
      }
      const outcome = await provisioner.applyRuntime(profile, item, { home, force: body.force });
      json(res, outcome.ok ? 200 : 502, outcome);
      return;
    }
    if (req.method === "POST" && url.pathname === "/runtime/remove") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = await readBody(req);
      if (body.confirm !== true) {
        json(res, 400, { error: "\u79FB\u9664\u8FD0\u884C\u65F6\u9700\u8981\u4E00\u6B21\u663E\u5F0F\u786E\u8BA4\uFF08confirm: true\uFF09" });
        return;
      }
      const detected = (await provisioner.inspect(profile, {})).detect;
      const root = runtimeRootFor(detected.home ?? "");
      if (!detected.home || !body.dir || !body.dir.startsWith(`${root}/`)) {
        json(res, 400, { error: `\u53EA\u80FD\u79FB\u9664 ${root || "~/.ocrc/runtime"} \u4E4B\u5185\u7684\u76EE\u5F55` });
        return;
      }
      json(res, 200, { removed: await provisioner.removeRuntime(profile, body.dir) });
      return;
    }
    if (url.pathname === "/project-config") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = req.method === "POST" ? await readBody(req) : {};
      const projectPath = String(body.projectPath ?? profile.projects?.[0]?.path ?? "");
      if (!projectPath.startsWith("/")) {
        json(res, 400, { error: "projectPath \u5FC5\u987B\u662F\u88AB\u63A7\u673A\u4E0A\u7684\u7EDD\u5BF9\u8DEF\u5F84" });
        return;
      }
      const current = await readProjectConfig(profile, projectPath);
      if (req.method === "GET") {
        const { parsed, raw, ...report } = current;
        json(res, 200, { ...report, sections: parsed });
        return;
      }
      let panelConfig = body.config ?? {};
      if (body.fromPanel === true) {
        const report = inspectConfigSource();
        if (report.parseError) {
          json(res, 422, { error: `\u9762\u677F\u5BBF\u4E3B\u7684\u914D\u7F6E\u89E3\u6790\u5931\u8D25\uFF1A${report.parseError}` });
          return;
        }
        if (!report.exists) {
          json(res, 404, { error: `\u9762\u677F\u5BBF\u4E3B\u4E0A\u6CA1\u6709\u914D\u7F6E\uFF1A${report.configPath}` });
          return;
        }
        const raw = readFileSync5(report.configPath, "utf-8").replace(/^\uFEFF/, "");
        try {
          panelConfig = JSON.parse(raw);
        } catch (e) {
          json(res, 422, { error: `\u9762\u677F\u5BBF\u4E3B\u7684\u914D\u7F6E\u89E3\u6790\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}` });
          return;
        }
      }
      const withSections = extractProjectSections(panelConfig);
      if (Object.keys(withSections).length === 0) {
        json(res, 400, { error: "\u6CA1\u6709\u53EF\u5199\u5165\u7684\u6BB5\uFF08agent / mcp / provider / model \u2026\uFF09" });
        return;
      }
      const { config: clean, replaced } = stripLiteralSecrets(withSections);
      const merged = mergeSticky(current.parsed ?? {}, clean);
      const packages = capabilitiesFromConfig(merged);
      const runtime = await provisioner.planRuntime(profile, runtimeNeedsOf(packages));
      const installedEntries = {};
      for (const item of runtime.items) {
        if (item.action !== "present" || !item.found?.path) continue;
        if (item.need.kind !== "npm") continue;
        installedEntries[item.need.raw] = item.found.path;
        installedEntries[item.need.name] = item.found.path;
      }
      const { config: finalConfig, rewritten } = applyNpxRewrites(merged, installedEntries);
      const finalJson = JSON.stringify(finalConfig, null, 2);
      const changed = hasChanges(current.parsed ?? {}, finalConfig);
      if (body.apply !== true) {
        json(res, 200, {
          targetPath: current.targetPath,
          format: current.format,
          exists: current.exists,
          changed,
          commentsWillBeLost: current.commentsWillBeLost ?? false,
          parseError: current.parseError,
          secretsRewritten: replaced,
          npxRewrites: rewritten,
          mergedPreview: finalJson.slice(0, 16e3)
        });
        return;
      }
      if (!changed) {
        json(res, 200, { targetPath: current.targetPath, changed: false, applied: true, note: "\u8FDC\u7AEF\u5DF2\u7ECF\u662F\u8FD9\u4E2A\u72B6\u6001\uFF0C\u6CA1\u6709\u5199\u4EFB\u4F55\u4E1C\u897F\uFF08\u4E0D\u4EA7\u751F .ocrc-bak\uFF09" });
        return;
      }
      const { script, stdin } = buildProjectConfigWriteScript(
        current.targetPath,
        Buffer.from(`${finalJson}
`, "utf-8").toString("base64")
      );
      const written = await sshExec(profile, script, { timeoutMs: 3e4, stdin });
      if (written.code !== 0) {
        json(res, 502, { error: written.stderr.trim().split("\n")[0] || `ssh exit ${written.code}` });
        return;
      }
      json(res, 200, {
        targetPath: current.targetPath,
        changed: true,
        applied: true,
        backup: written.stdout.includes("OCRC_BAK=") ? `${current.targetPath}.ocrc-bak` : null,
        commentsWillBeLost: current.commentsWillBeLost ?? false,
        secretsRewritten: replaced,
        npxRewrites: rewritten,
        note: "\u5DF2\u5199\u5165\u88AB\u63A7\u7AEF\u7684\u9879\u76EE\u7EA7\u914D\u7F6E\u2014\u2014\u5F15\u64CE\u91CD\u542F\u6216\u91CD\u8F7D\u540E\u751F\u6548\uFF08ocrc \u4E0D\u81EA\u52A8\u91CD\u542F\u88AB\u63A7\u5F15\u64CE\uFF09"
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/forwards") {
      const body = await readBody(req);
      const profiles = loadProfiles();
      const active = supervisor.activeProfile();
      const wanted = body.profileId ?? active?.id;
      const target = profiles.find((p) => p.id === wanted);
      if (!target) {
        json(res, 400, { error: wanted ? `\u6863\u6848 ${wanted} \u4E0D\u5B58\u5728` : "\u9700\u8981 profileId\uFF08\u6216\u5148\u8FDE\u4E0A\u4E00\u4E2A\u6863\u6848\uFF09" });
        return;
      }
      const requested = Array.isArray(body.forwards) ? body.forwards : [];
      let settled = requested;
      let portChanges = [];
      try {
        const result = await settleForwardPorts(requested);
        settled = result.settled.map((f) => ({ ...f, activePort: f.port }));
        portChanges = result.changed;
      } catch (e) {
        json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      const forwards = settled;
      const next = profiles.map((p) => p.id === target.id ? { ...p, forwards } : p);
      saveProfiles(next);
      const restarted = active?.id === target.id;
      if (restarted) supervisor.start(next.find((p) => p.id === target.id));
      json(res, 200, {
        profileId: target.id,
        forwards,
        portChanges,
        restarted,
        status: restarted ? await supervisor.statusProbed() : supervisor.status()
      });
      return;
    }
    if (url.pathname === "/auth-sync") {
      const profile = requireProfile(res);
      if (!profile) return;
      const body = req.method === "POST" ? await readBody(req) : {};
      const home = String(body.home ?? profile.projects?.[0]?.path ?? "");
      if (!home.startsWith("/")) {
        json(res, 400, { error: "home \u5FC5\u987B\u662F\u88AB\u63A7\u673A\u4E0A\u7684\u7EDD\u5BF9\u8DEF\u5F84" });
        return;
      }
      const authFile = panelAuthPath();
      let panelAuth = {};
      try {
        const parsed = JSON.parse(readFileSync5(authFile, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) panelAuth = parsed;
      } catch {
      }
      const remoteAuth = parseAuthRead((await sshExec(profile, buildAuthReadScript(home), { timeoutMs: 3e4 })).stdout);
      const inventory = compareAuth(panelAuth, remoteAuth);
      if (req.method === "GET") {
        json(res, 200, { ...inventory, authFile });
        return;
      }
      if (body.confirm !== true) {
        json(res, 400, { error: "\u642C\u8FD0 provider \u51ED\u636E\u9700\u8981\u4E00\u6B21\u663E\u5F0F\u786E\u8BA4\uFF08confirm: true\uFF09" });
        return;
      }
      const merged = mergeAuth(panelAuth, remoteAuth);
      if (!authHasChanges(panelAuth, remoteAuth)) {
        json(res, 200, { ...inventory, changed: false, written: false, note: "\u4E24\u7AEF\u51ED\u636E\u5DF2\u7ECF\u4E00\u81F4\uFF0C\u6CA1\u6709\u5199\u4EFB\u4F55\u4E1C\u897F" });
        return;
      }
      const { script, stdin } = buildAuthWriteScript(home, Buffer.from(JSON.stringify(merged, null, 2), "utf-8").toString("base64"));
      const written = await sshExec(profile, script, { timeoutMs: 3e4, stdin });
      if (written.code !== 0) {
        json(res, 502, { error: written.stderr.trim().split("\n")[0] || `ssh exit ${written.code}` });
        return;
      }
      json(res, 200, {
        ...compareAuth(panelAuth, remoteAuth),
        changed: true,
        written: true,
        backup: written.stdout.includes("OCRC_BAK=") ? `${authPathFor(home)}.ocrc-bak` : null,
        note: "\u51ED\u636E\u5DF2\u5199\u5165\u88AB\u63A7\u7AEF\u5F15\u64CE\u7684 auth.json\uFF080600\uFF0C\u65E7\u4EF6\u5907\u4EFD .ocrc-bak\uFF09\u2014\u2014\u5F15\u64CE\u91CD\u542F\u540E\u751F\u6548"
      });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});
if (process.env.OPENCHAMBER_SERVICE_PORT === void 0 || process.env.OPENCHAMBER_SERVICE_PORT === "") {
  console.error("[ocrc-remote] OPENCHAMBER_SERVICE_PORT missing \u2014 not launched by openchamber?");
  process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const bound = addr && typeof addr !== "string" ? addr.port : PORT;
  console.log(`[ocrc-remote] service listening on 127.0.0.1:${bound}`);
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
var saved = loadProfiles();
if (saved.length === 1) supervisor.start(saved[0]);
