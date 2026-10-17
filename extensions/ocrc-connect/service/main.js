/** ocrc-connect service entry — openchamber spawns this on the PANEL HOST
 *  (Win/Mac) with OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN env.
 *  Contract (packages/sdk/GUEST_SERVICES.md): loopback only, /health must
 *  return 200 within 15 s, every request carries
 *  Authorization: Bearer <token>. */
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createTunnelSupervisor } from './tunnel.js';
import { normalizeProfile } from '../shared/protocol.js';
import { sshExec, normalizeVirtualPath, isInsideRoots, buildListScript, parseListOutput, buildReadScript, buildWriteScript, buildStatScript, buildMkdirScript, buildGitScript, parseGitStatus, } from './remote-fs.js';
import { inspectConfigSource } from './config-bridge.js';
import { callOcrcHost } from './ocrc-host.js';
import { omoRemotePaths, buildOmoReadScript, parseOmoReadOutput, buildOmoWriteScript, summarizeOmoConfig, validateOmoWriteContent, applyOmoEdits, sanitizeOmoFallback, } from './omo-config.js';
import { createProvisioner } from './provision.js';
import { capabilitiesFromConfig, applyNpxRewrites, runtimeNeedsOf } from './capabilities.js';
import { planForwards, settleForwardPorts } from './tunnels.js';
import { sshExec as provisionExec } from './remote-fs.js';
import { buildProjectConfigReadScript, buildProjectConfigWriteScript, extractProjectSections, hasChanges, mergeSticky, parseProjectConfigRead, stripLiteralSecrets, } from './config-project.js';
import { authHasChanges, authPathFor, buildAuthReadScript, buildAuthWriteScript, compareAuth, mergeAuth, panelAuthPath, parseAuthRead, } from './auth-sync.js';
import { runtimeRootFor } from '../shared/provision.js';
import { connect as netConnect } from 'node:net';
const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const PROFILES_FILE = process.env.OCRC_CONNECT_PROFILES
    ?? join(process.env.OPENCHAMBER_DATA_DIR ?? join(homedir(), '.config', 'openchamber'), 'ocrc-connect-profiles.json');
// Profiles mirror to disk so the service can auto-reconnect the last tunnel
// after a panel-host restart without any panel interaction.
function loadProfiles() {
    try {
        const raw = JSON.parse(readFileSync(PROFILES_FILE, 'utf-8'));
        return (raw.profiles ?? []).map((p) => normalizeProfile(p));
    }
    catch {
        return [];
    }
}
function saveProfiles(profiles) {
    mkdirSync(join(PROFILES_FILE, '..'), { recursive: true });
    writeFileSync(PROFILES_FILE, JSON.stringify({ profiles }, null, 2));
}
const supervisor = createTunnelSupervisor();
/** 面板侧 provisioning：探测/取件/安装/回滚都在这里，ssh 复用 remote-fs 的通道。 */
const provisioner = createProvisioner({
    exec: (profile, script, options) => provisionExec(profile, script, options),
    // 验收脚本用本地 fixture registry 跑完整装链（含 sha512 校验），产品路径不带这个环境变量。
    registry: process.env.OCRC_REGISTRY?.trim() || undefined,
    cacheDir: process.env.OCRC_CACHE_DIR?.trim() || undefined,
});
/** 需要活动档案的端点共用这一段，错误码保持一致。 */
function requireProfile(res) {
    const profile = supervisor.activeProfile();
    if (!profile) {
        json(res, 409, { error: 'no active profile — connect first' });
        return null;
    }
    return profile;
}
/** 回滚与卸载都要**被控机的 $HOME**（引擎落点是 `<home>/.opencode/bin`），
 *  不是项目目录。这两步会在目标机上删文件，所以先卡住路径形状——`/` 或相对路径
 *  一律拒绝，绝不让它在一个猜出来的位置上动手。 */
function requireTargetHome(res, raw) {
    const home = String(raw ?? '').trim();
    if (!home.startsWith('/') || home === '/' || home.includes('..')) {
        json(res, 400, { error: 'home 必须是被控机的 $HOME 绝对路径（引擎落点 <home>/.opencode/bin）' });
        return null;
    }
    return home.replace(/\/+$/, '');
}
/** 面板自己能不能到达 host:port——决定该不该为能力补一条隧道（D12）。 */
function probeTcp(host, port, timeoutMs = 1_500) {
    return new Promise((resolve) => {
        const socket = netConnect({ host, port, timeout: timeoutMs });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
    });
}
/** 读被控端项目级配置（引擎实际会读的那一份）。 */
async function readProjectConfig(profile, projectPath) {
    const { stdout } = await provisionExec(profile, buildProjectConfigReadScript(projectPath), { timeoutMs: 30_000 });
    return parseProjectConfigRead(stdout, projectPath);
}
function json(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
}
async function readBody(req) {
    const chunks = [];
    for await (const c of req)
        chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}
const server = http.createServer(async (req, res) => {
    // Guest-service contract: bearer token on everything (including /health).
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
        json(res, 401, { error: 'unauthorized' });
        return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
        if (req.method === 'GET' && url.pathname === '/health') {
            json(res, 200, { ok: true });
            return;
        }
        // ── 2.0.0-alpha.8 对端能力：面板 → ocrc host 的窄口（只放行 /api/remote-instance*）
        if (req.method === 'POST' && url.pathname === '/remote-instance') {
            const body = (await readBody(req));
            if (!body.op) {
                json(res, 400, { error: 'op required' });
                return;
            }
            try {
                const reply = await callOcrcHost(body);
                res.writeHead(reply.status, { 'content-type': 'application/json' });
                res.end(reply.body);
            }
            catch (err) {
                // ocrc host 没跑/超时：如实说「连不上控制端主机 API」，别让面板看到哑巴 500
                json(res, 502, { error: `ocrc host 不可达：${err.message}` });
            }
            return;
        }
        if (req.method === 'GET' && url.pathname === '/status') {
            json(res, 200, { status: await supervisor.statusProbed(), profiles: loadProfiles() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/profiles') {
            const body = (await readBody(req));
            const profiles = loadProfiles();
            const p = normalizeProfile(body.profile);
            const next = [...profiles.filter((x) => x.id !== p.id), p];
            saveProfiles(next);
            json(res, 200, { profiles: next });
            return;
        }
        if (req.method === 'DELETE' && url.pathname.startsWith('/profiles/')) {
            const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
            const next = loadProfiles().filter((p) => p.id !== id);
            saveProfiles(next);
            json(res, 200, { profiles: next });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/connect') {
            const body = (await readBody(req));
            const profiles = loadProfiles();
            const p = profiles.find((x) => x.id === body.profileId);
            if (!p) {
                json(res, 404, { error: 'profile not found' });
                return;
            }
            if (!existsSync('/usr/bin/ssh') && !existsSync('/bin/ssh') && process.platform !== 'win32') {
                // Best-effort guard; ssh may live elsewhere on PATH — the spawn error
                // path reports it properly if truly missing.
            }
            supervisor.start(p);
            json(res, 200, { status: await supervisor.statusProbed() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/disconnect') {
            supervisor.stop();
            json(res, 200, { status: supervisor.status() });
            return;
        }
        // ── batch 4: fs/git-over-ssh (remote workspace face) ────────────────────
        // Every endpoint resolves the ACTIVE profile (last connected), requires the
        // path to be absolute and inside that profile's allowedRoots, then spawns
        // one `ssh <profile> <script>` round-trip. The active profile is the one
        // the supervisor last started — the workspace browser edits what the
        // tunnel points at, never an arbitrary machine.
        if (req.method === 'GET' && url.pathname === '/git-branch') {
            // Badge helper: the FIRST allowed root's branch (best-effort, fast fail).
            const profile = supervisor.activeProfile();
            const root = profile?.allowedRoots?.[0];
            if (!profile || !root) {
                json(res, 200, { branch: null });
                return;
            }
            const { code, stdout } = await sshExec(profile, buildGitScript(root, 'status'), { timeoutMs: 8_000 });
            if (code !== 0) {
                json(res, 200, { branch: null });
                return;
            }
            json(res, 200, { branch: parseGitStatus(stdout).branch ?? null });
            return;
        }
        if (url.pathname.startsWith('/fs/') || url.pathname.startsWith('/git/')) {
            const profile = supervisor.activeProfile();
            if (!profile) {
                json(res, 409, { error: 'no active profile — connect first' });
                return;
            }
            const roots = profile.allowedRoots ?? [];
            const body = (req.method === 'POST' ? await readBody(req) : {});
            const vpath = normalizeVirtualPath(String(body.path ?? url.searchParams.get('path') ?? ''));
            if (!vpath) {
                json(res, 400, { error: 'path must be absolute without .. segments' });
                return;
            }
            if (roots.length === 0 || !isInsideRoots(vpath, roots)) {
                json(res, 403, { error: `path outside allowedRoots (${roots.join(', ') || 'none declared'})` });
                return;
            }
            const R = profile;
            if (req.method === 'POST' && url.pathname === '/fs/list') {
                const { code, stdout, stderr } = await sshExec(R, buildListScript(vpath), { timeoutMs: 20_000 });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
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
            if (req.method === 'POST' && url.pathname === '/fs/read') {
                const max = Math.min(Number(body.maxBytes) || 512 * 1024, 2 * 1024 * 1024);
                const { code, stdout, stderr } = await sshExec(R, buildReadScript(vpath, max), { timeoutMs: 30_000 });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
                    return;
                }
                if (stdout.startsWith('ERR: not-a-file')) {
                    json(res, 404, { error: 'not a file' });
                    return;
                }
                if (stdout.startsWith('ERR: too-large:')) {
                    json(res, 413, { error: `file larger than ${max} bytes (${stdout.split(':')[2]} total)` });
                    return;
                }
                const sizeLine = stdout.split('\n').find((l) => l.startsWith('SIZE:'));
                const b64 = stdout.split('\n').filter((l) => !l.startsWith('SIZE:')).join('');
                json(res, 200, { path: vpath, size: sizeLine ? Number(sizeLine.slice(5)) : undefined, encoding: 'base64', content: b64.trim() });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/fs/write') {
                const content = typeof body.content === 'string' ? body.content : '';
                const b64 = Buffer.from(content, 'utf-8').toString('base64');
                const { script, stdin } = buildWriteScript(vpath, b64);
                const { code, stdout, stderr } = await sshExec(R, script, { timeoutMs: 30_000, stdin });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
                    return;
                }
                json(res, 200, { path: vpath, backup: stdout.includes('bak:') ? `${vpath}.bak` : null });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/fs/stat') {
                const { code, stdout, stderr } = await sshExec(R, buildStatScript(vpath), { timeoutMs: 15_000 });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
                    return;
                }
                const kv = new Map(stdout.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
                json(res, 200, { path: vpath, type: kv.get('type') ?? 'missing', size: kv.get('size') ? Number(kv.get('size')) : undefined, mtime: kv.get('mtime') ? Number(kv.get('mtime')) : undefined });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/fs/mkdir') {
                const { code, stderr } = await sshExec(R, buildMkdirScript(vpath), { timeoutMs: 15_000 });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
                    return;
                }
                json(res, 200, { path: vpath });
                return;
            }
            // git/*: the ROOT is the allowed root itself (or body.root — still
            // allowlist-checked above via vpath).
            const root = vpath;
            if (req.method === 'POST' && url.pathname === '/git/status') {
                const { code, stdout } = await sshExec(R, buildGitScript(root, 'status'), { timeoutMs: 20_000 });
                if (code !== 0) {
                    json(res, 502, { error: `ssh exit ${code}` });
                    return;
                }
                json(res, 200, { root, ...parseGitStatus(stdout) });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/git/diff') {
                const paths = Array.isArray(body.paths) ? body.paths.map(String) : undefined;
                const { code, stdout } = await sshExec(R, buildGitScript(root, 'diff', { paths }), { timeoutMs: 30_000, maxStdout: 300_000 });
                if (code !== 0) {
                    json(res, 502, { error: `ssh exit ${code}` });
                    return;
                }
                json(res, 200, { root, diff: stdout });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/git/log') {
                const { code, stdout } = await sshExec(R, buildGitScript(root, 'log'), { timeoutMs: 20_000 });
                if (code !== 0) {
                    json(res, 502, { error: `ssh exit ${code}` });
                    return;
                }
                json(res, 200, { root, log: stdout.split('\n').filter((l) => l.trim()).slice(0, 30) });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/git/stage') {
                const paths = Array.isArray(body.paths) ? body.paths.map(String) : undefined;
                const { code, stdout, stderr } = await sshExec(R, buildGitScript(root, 'stage', { paths }), { timeoutMs: 30_000 });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
                    return;
                }
                json(res, 200, { root, ok: stdout.includes('staged') });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/git/commit') {
                const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
                if (!message) {
                    json(res, 400, { error: 'message required' });
                    return;
                }
                const { code, stdout } = await sshExec(R, buildGitScript(root, 'commit', { message }), { timeoutMs: 30_000 });
                if (code !== 0) {
                    json(res, 502, { error: `ssh exit ${code}` });
                    return;
                }
                const nothing = stdout.includes('nothing-to-commit');
                json(res, nothing ? 409 : 200, { root, committed: !nothing, output: stdout.trim().split('\n')[0] });
                return;
            }
        }
        // ── batch 5.1: omo-slim config (user layer, read + structured/raw write) ─
        // The remote path is assembled here — never taken from the request — so
        // these endpoints can only touch oh-my-opencode-slim.json[c] under the
        // remote $HOME. Writes are validated server-side (422 before any ssh),
        // atomic, and back the prior file up to *.ocrc-bak. The engine hot-reloads
        // this file (~300ms, inference fields only — E4 evidence).
        if (url.pathname === '/omo/config') {
            const profile = supervisor.activeProfile();
            if (!profile) {
                json(res, 409, { error: 'no active profile — connect first' });
                return;
            }
            const R = profile;
            const scope = url.searchParams.get('scope') ?? 'user';
            if (scope !== 'user') {
                json(res, 400, { error: `scope '${scope}' 不支持——项目层写入走工作区同步通道` });
                return;
            }
            if (req.method === 'GET') {
                const { code, stdout, stderr } = await sshExec(R, buildOmoReadScript(omoRemotePaths()), { timeoutMs: 20_000 });
                if (code !== 0) {
                    json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` });
                    return;
                }
                const { format, size, raw } = parseOmoReadOutput(stdout);
                json(res, 200, summarizeOmoConfig(format, size, raw));
                return;
            }
            if (req.method === 'POST') {
                const body = (await readBody(req));
                const hasStructured = body.preset !== undefined || body.fallback !== undefined;
                const hasRaw = typeof body.content === 'string';
                if (hasStructured === hasRaw) {
                    json(res, 400, { error: '请求体必须且只能包含 content（原始 JSON）或 preset/fallback（结构化编辑）之一' });
                    return;
                }
                // 1. read current remote doc (structured edits need the untouched rest)
                const rd = await sshExec(R, buildOmoReadScript(omoRemotePaths()), { timeoutMs: 20_000 });
                if (rd.code !== 0) {
                    json(res, 502, { error: rd.stderr.trim().split('\n')[0] || `ssh exit ${rd.code}` });
                    return;
                }
                const cur = parseOmoReadOutput(rd.stdout);
                if (cur.format === 'missing' && hasStructured) {
                    json(res, 409, { error: '远端尚无 omo 配置——先在被控端跑一次 oh-my-opencode-slim install 生成基准配置' });
                    return;
                }
                // 2. compute the next document
                let next;
                if (hasRaw) {
                    const v = validateOmoWriteContent(body.content);
                    if (!v.ok) {
                        json(res, 422, { error: v.err });
                        return;
                    }
                    next = v.parsed;
                }
                else {
                    const curParsed = summarizeOmoConfig(cur.format, cur.size, cur.raw);
                    if (curParsed.parseError || !curParsed.parsed) {
                        json(res, 409, { error: `远端配置当前不可解析，拒绝盲写覆盖（请用原始 JSON 编辑修复）：${curParsed.parseError ?? 'unknown'}` });
                        return;
                    }
                    const fallback = body.fallback === undefined ? undefined : body.fallback === null
                        ? null
                        : typeof body.fallback === 'object' && !Array.isArray(body.fallback)
                            ? sanitizeOmoFallback(body.fallback)
                            : { ok: false, err: 'fallback 必须是对象或 null' };
                    if (fallback && 'err' in fallback && fallback.ok === false) {
                        json(res, 422, { error: fallback.err });
                        return;
                    }
                    const presetOk = body.preset === undefined || body.preset === null
                        || (typeof body.preset === 'string' && body.preset.trim() !== '');
                    if (!presetOk) {
                        json(res, 422, { error: 'preset 必须是非空字符串或 null（清除）' });
                        return;
                    }
                    if (typeof body.preset === 'string' && curParsed.parsed.presets
                        && typeof curParsed.parsed.presets === 'object' && !Array.isArray(curParsed.parsed.presets)) {
                        const names = Object.keys(curParsed.parsed.presets);
                        if (!names.includes(body.preset)) {
                            json(res, 422, { error: `预设 '${body.preset}' 不存在——现有：${names.join(', ')}` });
                            return;
                        }
                    }
                    next = applyOmoEdits(curParsed.parsed, {
                        preset: body.preset,
                        fallback: body.fallback === undefined ? undefined : body.fallback === null ? null : fallback.value,
                    });
                }
                // 3. write target: keep .jsonc if that is what the remote has (its
                //    comments are already lost — flagged via willConvertToJson), else .json
                const converted = cur.format === 'jsonc';
                const target = converted ? omoRemotePaths().jsonc : omoRemotePaths().json;
                const { script, stdin } = buildOmoWriteScript(target, Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf-8').toString('base64'));
                const wr = await sshExec(R, script, { timeoutMs: 30_000, stdin });
                if (wr.code !== 0) {
                    json(res, 502, { error: wr.stderr.trim().split('\n')[0] || `ssh exit ${wr.code}` });
                    return;
                }
                const backupLine = wr.stdout.split('\n').find((l) => l.startsWith('bak:'));
                json(res, 200, {
                    ok: true,
                    target,
                    backup: backupLine ? backupLine.slice(5).trim() : null,
                    commentsWillBeLost: converted || undefined,
                    note: '已写入——v2 宿主约 300ms 内热重载（对新的编排子会话生效，ocrc 不重启引擎）',
                });
                return;
            }
        }
        // ── batch 5 + 2026-10-16 改判: panel-host 配置 → 被控端**项目级**配置 ────
        // 面板宿主写的 agents/MCP/providers 改动要走 ssh 送到被控端，但只送到项目级
        // 配置（项目目录下的 opencode.jsonc）：项目级优先级高于全局，而全局层是**用户级
        // 配置**——0.3.0 那版写 ~/.config/opencode/opencode.json 是设计错误（D10，见
        // panel-provisioning-verdict）。这里只留「读面板宿主源清单」；预览与应用走
        // /project-config。密钥不搬运——它们留在引擎自己的凭据体系里。
        if (url.pathname.startsWith('/config/')) {
            const profile = supervisor.activeProfile();
            if (!profile) {
                json(res, 409, { error: 'no active profile — connect first' });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/config/source') {
                const report = inspectConfigSource();
                json(res, 200, report);
                return;
            }
            // 旧面板的写入入口：**拒绝**，并把新落点告诉它。留一个明确的 410 比
            // 静默改语义安全——老面板至少知道自己的动作没生效、该改用哪个端点。
            if (req.method === 'POST' && (url.pathname === '/config/preview' || url.pathname === '/config/apply')) {
                json(res, 410, {
                    error: '写入全局 ~/.config/opencode/opencode.json 的行为已移除（改判：项目级配置才允许写）。' +
                        '改用 POST /project-config { projectPath, config, apply } ——目标是被控机项目目录下的 opencode.jsonc。',
                });
                return;
            }
        }
        // ── 面板侧 provisioning（PRODUCT 第零点九条 / 裁决 D1–D19）────────────
        // 探测全自动，安装与写配置需要一次显式确认（D3）：所以先 GET/POST 预演，
        // 再由面板带 `confirm: true` 调 /provision/apply。两者之间的窗口无害——
        // apply 会重新算一遍身份（marker 的 sha512），不会照着过期的计划动手。
        if (req.method === 'POST' && (url.pathname === '/detect' || url.pathname === '/inspect')) {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = req.method === 'POST' ? (await readBody(req)) : {};
            const result = await provisioner.inspect(profile, { anchor: body.anchor });
            json(res, 200, {
                detect: result.detect,
                readiness: result.readiness,
                anchor: result.anchor,
                anchorSource: result.anchorSource,
            });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/provision/plan') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            const report = body.detect ?? (await provisioner.inspect(profile, { anchor: body.anchor })).detect;
            const planned = await provisioner.plan(profile, report, { anchor: body.anchor });
            if ('error' in planned) {
                json(res, 409, { error: planned.error });
                return;
            }
            json(res, 200, { plan: planned.plan, artifact: planned.artifact });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/provision/apply') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            if (body.confirm !== true) {
                json(res, 400, { error: '安装需要一次显式确认（confirm: true）' });
                return;
            }
            if (!body.plan || !body.artifact) {
                json(res, 400, { error: 'plan 与 artifact 由 /provision/plan 给出' });
                return;
            }
            const outcome = await provisioner.apply(profile, body.plan, body.artifact);
            json(res, outcome.ok ? 200 : 502, outcome);
            return;
        }
        if (req.method === 'POST' && url.pathname === '/provision/prefetch') {
            const body = (await readBody(req));
            if (!body.artifact) {
                json(res, 400, { error: 'artifact 由 /provision/plan 给出' });
                return;
            }
            try {
                const { path } = await provisioner.prefetch(body.artifact);
                json(res, 200, { ok: true, path });
            }
            catch (e) {
                json(res, 502, { error: e instanceof Error ? e.message : String(e) });
            }
            return;
        }
        if (req.method === 'POST' && url.pathname === '/provision/rollback') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            const home = requireTargetHome(res, body.home);
            if (!home)
                return;
            if (!body.platform) {
                json(res, 400, { error: 'platform 必填' });
                return;
            }
            json(res, 200, { rolledBack: await provisioner.rollback(profile, body.platform, home) });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/provision/uninstall') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            if (body.confirm !== true) {
                json(res, 400, { error: '卸载需要一次显式确认（confirm: true）' });
                return;
            }
            const home = requireTargetHome(res, body.home);
            if (!home)
                return;
            json(res, 200, { uninstalled: await provisioner.uninstall(profile, home) });
            return;
        }
        // 能力清单与补齐计划：读被控端的项目配置算出每项能力差什么（D11/D12）。
        // `runtime` 一并算好（同一次探测），面板据此显示 install/present/impossible。
        if (req.method === 'POST' && url.pathname === '/capabilities') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            const projectPath = body.projectPath ?? profile.projects?.[0]?.path;
            if (!projectPath) {
                json(res, 400, { error: '还没有绑定工作目录（档案的 projects[0]）' });
                return;
            }
            const config = await readProjectConfig(profile, projectPath);
            const packages = capabilitiesFromConfig(config.parsed ?? {});
            const plan = await planForwards(packages, {
                // 面板能不能直接到达？由面板宿主自己试（服务就在面板宿主上）。
                panelReachable: (host, port) => probeTcp(host, port),
            });
            const runtime = await provisioner.planRuntime(profile, runtimeNeedsOf(packages), { detect: body.detect });
            json(res, 200, {
                capabilities: packages, forwards: plan.specs, rewrites: plan.rewrites, notes: plan.notes, config, runtime,
            });
            return;
        }
        // ── 运行时补齐（D12/D13）────────────────────────────────────────────────
        // 与引擎部署同一套纪律：预演（/runtime/plan）→ 一次显式确认（confirm: true）
        // → 才在被控端跑 npm。要求项目路径是因为「要装什么」来自那份项目配置。
        if (req.method === 'POST' && url.pathname === '/runtime/plan') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            const projectPath = body.projectPath ?? profile.projects?.[0]?.path;
            if (!projectPath) {
                json(res, 400, { error: '还没有绑定工作目录（档案的 projects[0]）' });
                return;
            }
            const config = await readProjectConfig(profile, projectPath);
            const packages = capabilitiesFromConfig(config.parsed ?? {});
            const runtime = await provisioner.planRuntime(profile, runtimeNeedsOf(packages), { detect: body.detect });
            json(res, 200, { projectPath, runtime });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/runtime/apply') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            if (body.confirm !== true) {
                json(res, 400, { error: '安装运行时需要一次显式确认（confirm: true）' });
                return;
            }
            if (!body.item) {
                json(res, 400, { error: 'item 由 /runtime/plan 给出' });
                return;
            }
            const item = body.item;
            // 落点复核：必须落在**这台目标机**的运行时根目录里（home 由服务自己探，
            // 不信请求体里的路径）。
            const detected = (await provisioner.inspect(profile, {})).detect;
            const home = detected.home ?? '';
            const root = runtimeRootFor(home);
            if (!home || !item.dir || !item.dir.startsWith(`${root}/`)) {
                json(res, 400, { error: `安装落点必须落在目标机的 ${root || '~/.ocrc/runtime'} 之内` });
                return;
            }
            const outcome = await provisioner.applyRuntime(profile, item, { home, force: body.force });
            json(res, outcome.ok ? 200 : 502, outcome);
            return;
        }
        if (req.method === 'POST' && url.pathname === '/runtime/remove') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = (await readBody(req));
            if (body.confirm !== true) {
                json(res, 400, { error: '移除运行时需要一次显式确认（confirm: true）' });
                return;
            }
            const detected = (await provisioner.inspect(profile, {})).detect;
            const root = runtimeRootFor(detected.home ?? '');
            if (!detected.home || !body.dir || !body.dir.startsWith(`${root}/`)) {
                json(res, 400, { error: `只能移除 ${root || '~/.ocrc/runtime'} 之内的目录` });
                return;
            }
            json(res, 200, { removed: await provisioner.removeRuntime(profile, body.dir) });
            return;
        }
        // ── 项目级配置（D9/D10/D11）────────────────────────────────────────────
        // 写 `<项目目录>/opencode.jsonc`：优先级高于全局、存在 .jsonc 就写 .jsonc、
        // 全局层只读不写。写入前先读现状做**粘性合并**，只写差异，`.ocrc-bak` 兜底。
        if (url.pathname === '/project-config') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = req.method === 'POST' ? (await readBody(req)) : {};
            const projectPath = String(body.projectPath ?? profile.projects?.[0]?.path ?? '');
            if (!projectPath.startsWith('/')) {
                json(res, 400, { error: 'projectPath 必须是被控机上的绝对路径' });
                return;
            }
            const current = await readProjectConfig(profile, projectPath);
            if (req.method === 'GET') {
                const { parsed, raw, ...report } = current;
                json(res, 200, { ...report, sections: parsed });
                return;
            }
            // POST：面板产物 → 项目级配置。
            // `fromPanel: true` 时由**服务自己**读面板宿主的配置（服务就跑在面板宿主上），
            // 面板不需要把配置内容过一遍桥——少一次搬运，也少一个可被伪造的输入。
            let panelConfig = (body.config ?? {});
            if (body.fromPanel === true) {
                const report = inspectConfigSource();
                if (report.parseError) {
                    json(res, 422, { error: `面板宿主的配置解析失败：${report.parseError}` });
                    return;
                }
                if (!report.exists) {
                    json(res, 404, { error: `面板宿主上没有配置：${report.configPath}` });
                    return;
                }
                const raw = readFileSync(report.configPath, 'utf-8').replace(/^\uFEFF/, '');
                try {
                    panelConfig = JSON.parse(raw);
                }
                catch (e) {
                    json(res, 422, { error: `面板宿主的配置解析失败：${e instanceof Error ? e.message : String(e)}` });
                    return;
                }
            }
            const withSections = extractProjectSections(panelConfig);
            if (Object.keys(withSections).length === 0) {
                json(res, 400, { error: '没有可写入的段（agent / mcp / provider / model …）' });
                return;
            }
            // 密钥绝不落文件：字面量换成 {env:…} 引用。
            const { config: clean, replaced } = stripLiteralSecrets(withSections);
            const merged = mergeSticky(current.parsed ?? {}, clean);
            // npx 形态的 MCP 在写入前改写成**目标机上已经装好**的本地入口（D13）：运行期
            // 不再依赖 npx 联网取件。只认已就位的运行时——没装的不改写，也不替用户装
            // （装运行时是 /runtime/apply，需要一次单独确认）。
            const packages = capabilitiesFromConfig(merged);
            const runtime = await provisioner.planRuntime(profile, runtimeNeedsOf(packages));
            const installedEntries = {};
            for (const item of runtime.items) {
                if (item.action !== 'present' || !item.found?.path)
                    continue;
                if (item.need.kind !== 'npm')
                    continue;
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
                    mergedPreview: finalJson.slice(0, 16_000),
                });
                return;
            }
            if (!changed) {
                json(res, 200, { targetPath: current.targetPath, changed: false, applied: true, note: '远端已经是这个状态，没有写任何东西（不产生 .ocrc-bak）' });
                return;
            }
            const { script, stdin } = buildProjectConfigWriteScript(current.targetPath, Buffer.from(`${finalJson}\n`, 'utf-8').toString('base64'));
            const written = await provisionExec(profile, script, { timeoutMs: 30_000, stdin });
            if (written.code !== 0) {
                json(res, 502, { error: written.stderr.trim().split('\n')[0] || `ssh exit ${written.code}` });
                return;
            }
            json(res, 200, {
                targetPath: current.targetPath,
                changed: true,
                applied: true,
                backup: written.stdout.includes('OCRC_BAK=') ? `${current.targetPath}.ocrc-bak` : null,
                commentsWillBeLost: current.commentsWillBeLost ?? false,
                secretsRewritten: replaced,
                npxRewrites: rewritten,
                note: '已写入被控端的项目级配置——引擎重启或重载后生效（ocrc 不自动重启被控引擎）',
            });
            return;
        }
        // 多路转发：算好的 specs 落到档案上（D15）。
        // **不要求先连上**：转发的用途就是「连之前先配好」。给了 profileId 就改那份档案，
        // 没给则用当前活动档案；改的若是正在跑的那一份，重启隧道让新转发立刻生效——
        // 否则下次连接自然带上。
        if (req.method === 'POST' && url.pathname === '/forwards') {
            const body = (await readBody(req));
            const profiles = loadProfiles();
            const active = supervisor.activeProfile();
            const wanted = body.profileId ?? active?.id;
            const target = profiles.find((p) => p.id === wanted);
            if (!target) {
                json(res, 400, { error: wanted ? `档案 ${wanted} 不存在` : '需要 profileId（或先连上一个档案）' });
                return;
            }
            const requested = Array.isArray(body.forwards) ? body.forwards : [];
            // 能力转发的端口是实现细节（URL 改写跟着实际端口走），被占用就换一个空闲的；
            // 主隧道端口不在此列——4096 是面板宿主用 OPENCODE_PORT 指给 openchamber 的地址
            // （上游不盲探 4096），静默换掉等于弄坏接入（spike 第 6 步实测：主端口冲突时
            // ssh 会如实报 cannot listen）。
            let settled = requested;
            let portChanges = [];
            try {
                const result = await settleForwardPorts(requested);
                // 回写成运行时视图：实际端口落进 activePort，面板按它改写 URL。
                settled = result.settled.map((f) => ({ ...f, activePort: f.port }));
                portChanges = result.changed;
            }
            catch (e) {
                json(res, 409, { error: e instanceof Error ? e.message : String(e) });
                return;
            }
            const forwards = settled;
            const next = profiles.map((p) => (p.id === target.id ? { ...p, forwards } : p));
            saveProfiles(next);
            const restarted = active?.id === target.id;
            if (restarted)
                supervisor.start(next.find((p) => p.id === target.id));
            json(res, 200, {
                profileId: target.id,
                forwards,
                portChanges,
                restarted,
                status: restarted ? await supervisor.statusProbed() : supervisor.status(),
            });
            return;
        }
        // ── 凭据通道（D11 的例外：只搬 provider 凭据，且只回名字）───────────────
        // 传输凭据（SSH 私钥/密码、TG bot token）不在此列——它们永远不离开面板宿主。
        if (url.pathname === '/auth-sync') {
            const profile = requireProfile(res);
            if (!profile)
                return;
            const body = req.method === 'POST' ? (await readBody(req)) : {};
            const home = String(body.home ?? profile.projects?.[0]?.path ?? '');
            if (!home.startsWith('/')) {
                json(res, 400, { error: 'home 必须是被控机上的绝对路径' });
                return;
            }
            const authFile = panelAuthPath();
            let panelAuth = {};
            try {
                const parsed = JSON.parse(readFileSync(authFile, 'utf-8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    panelAuth = parsed;
            }
            catch { /* 面板侧没有凭据文件：账就是两边都空 */ }
            const remoteAuth = parseAuthRead((await provisionExec(profile, buildAuthReadScript(home), { timeoutMs: 30_000 })).stdout);
            const inventory = compareAuth(panelAuth, remoteAuth);
            if (req.method === 'GET') {
                json(res, 200, { ...inventory, authFile });
                return;
            }
            if (body.confirm !== true) {
                json(res, 400, { error: '搬运 provider 凭据需要一次显式确认（confirm: true）' });
                return;
            }
            const merged = mergeAuth(panelAuth, remoteAuth);
            if (!authHasChanges(panelAuth, remoteAuth)) {
                json(res, 200, { ...inventory, changed: false, written: false, note: '两端凭据已经一致，没有写任何东西' });
                return;
            }
            const { script, stdin } = buildAuthWriteScript(home, Buffer.from(JSON.stringify(merged, null, 2), 'utf-8').toString('base64'));
            const written = await provisionExec(profile, script, { timeoutMs: 30_000, stdin });
            if (written.code !== 0) {
                json(res, 502, { error: written.stderr.trim().split('\n')[0] || `ssh exit ${written.code}` });
                return;
            }
            json(res, 200, {
                ...compareAuth(panelAuth, remoteAuth),
                changed: true,
                written: true,
                backup: written.stdout.includes('OCRC_BAK=') ? `${authPathFor(home)}.ocrc-bak` : null,
                note: '凭据已写入被控端引擎的 auth.json（0600，旧件备份 .ocrc-bak）——引擎重启后生效',
            });
            return;
        }
        json(res, 404, { error: 'not found' });
    }
    catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
});
// `0` 是合法请求（让内核挑一个空闲端口）：测试用它消除端口碰撞。缺变量才是错。
if (process.env.OPENCHAMBER_SERVICE_PORT === undefined || process.env.OPENCHAMBER_SERVICE_PORT === '') {
    console.error('[ocrc-connect] OPENCHAMBER_SERVICE_PORT missing — not launched by openchamber?');
    process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => {
    // 报**实际**绑定端口（PORT=0 时就是内核给的那个）：调用方/测试据此决定打哪里。
    const addr = server.address();
    const bound = addr && typeof addr !== 'string' ? addr.port : PORT;
    console.log(`[ocrc-connect] service listening on 127.0.0.1:${bound}`);
});
// Auto-reconnect the last-used profile (lowest-friction resume after a panel
// host reboot): the panel persists "lastProfileId" in host.storage and passes
// it on /connect; here we only restore if exactly one profile exists —
// ambiguity stays a manual choice.
const saved = loadProfiles();
if (saved.length === 1)
    supervisor.start(saved[0]);
