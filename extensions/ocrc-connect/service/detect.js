import { isSupportedEngineVersion, MINIMUM_NODE_MAJOR, readinessAction } from '../shared/provision.js';
/** 一个脚本探完所有档位。`sh` 而非 bash：EL7 的 /bin/sh 是 bash，但更老的
 *  被控机可能是 dash/busybox，探测本身不该依赖 bash 特性。每条探测都 `|| true`,
 *  单点失败不能吃掉整份报告。 */
export function buildDetectScript() {
    return [
        'echo "OS=$( (cat /etc/os-release 2>/dev/null | sed -n "s/^PRETTY_NAME=//p" | tr -d \'"\') || uname -s)"',
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
        'done',
        // 出网探测：只关心能不能拿到官方 registry（安装通道），所以打的是 npm 而不是
        // opencode.ai——真正的取件动作只走 registry。
        'if command -v curl >/dev/null 2>&1; then',
        '  if curl -sSf -m 8 -o /dev/null https://registry.npmjs.org/@opencode%2Fcli 2>/dev/null; then echo "OUTBOUND=yes"; else echo "OUTBOUND=no"; fi',
        'elif command -v wget >/dev/null 2>&1; then',
        '  if wget -q -T 8 -O /dev/null https://registry.npmjs.org/@opencode%2Fcli 2>/dev/null; then echo "OUTBOUND=yes"; else echo "OUTBOUND=no"; fi',
        'else echo "OUTBOUND=unknown"; fi',
        'echo "DETECT_DONE=1"',
    ].join('\n');
}
/** 把 key=value 行读成表。值里可能带空格（PRETTY_NAME），所以只按第一个 `=` 切。
 *  键允许数字——`AVX2` 是这条探测里最要紧的一项，早期版本的正则把它整行丢了。 */
export function parseDetectOutput(stdout) {
    const out = {};
    for (const rawLine of stdout.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Z][A-Z0-9_]*$/.test(key))
            continue;
        out[key] = line.slice(eq + 1).trim();
    }
    return out;
}
/** uname -m + 系统 → 官方包的目标三元组。绝不返回 musl 变体（D4）。 */
export function resolveTarget(machine, onlyOs, _baseline) {
    const os = onlyOs.toLowerCase();
    const arch = /aarch64|arm64/.test(machine.toLowerCase()) ? 'arm64' : /x86_64|amd64/.test(machine.toLowerCase()) ? 'x64' : undefined;
    if (!arch)
        return undefined;
    if (os === 'linux')
        return `linux-${arch}`;
    if (os === 'darwin')
        return `darwin-${arch}`;
    if (os.startsWith('mingw') || os.startsWith('msys') || os === 'windows')
        return `win32-${arch}`;
    return undefined;
}
/** glibc 版本号（`ldd (GNU libc) 2.17` → `2.17`）。musl/未知返回 undefined。 */
export function parseGlibc(text) {
    const match = /(\d+\.\d+)(?:-|$|\s)/.exec(text.trim());
    return match?.[1];
}
/** 官方 2.x 二进制要求 glibc ≥ 2.17（EL7 是实测下限，见 PRODUCT 第四条）。 */
export const MINIMUM_GLIBC = '2.17';
export function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
export function toDetectReport(stdout, options = {}) {
    const f = parseDetectOutput(stdout);
    if (!f.DETECT_DONE) {
        return { reachable: options.reachable ?? false, error: options.stderr?.trim() || '探测脚本没有跑完（目标机可能没有可用的 sh）' };
    }
    const glibc = parseGlibc(f.GLIBC ?? '');
    const baseline = f.AVX2 !== 'yes';
    const platform = resolveTarget(f.MACHINE ?? '', f.ONLY_OS ?? '', baseline);
    const node = f.NODE && f.NODE !== 'none' ? f.NODE : undefined;
    const report = {
        reachable: options.reachable ?? true,
        platform,
        baseline,
        os: f.OS || f.ONLY_OS,
        kernel: f.KERNEL,
        glibc,
        container: f.CONTAINER === 'docker' || f.CONTAINER === 'lxc' ? f.CONTAINER : f.CONTAINER === 'none' ? 'none' : 'unknown',
        home: f.HOME_DIR,
        homeWritable: f.HOME_WRITABLE === 'yes',
        hasSh: f.HAS_SH === 'yes',
        hasTar: f.HAS_TAR === 'yes',
        outbound: f.OUTBOUND === 'yes' ? true : f.OUTBOUND === 'no' ? false : undefined,
        engine: f.ENGINE_PATH && f.ENGINE_PATH !== 'none'
            ? { path: f.ENGINE_PATH, version: normalizeVersion(f.ENGINE_VERSION ?? '') }
            : null,
        legacyEngine: f.LEGACY_PATH ? { path: f.LEGACY_PATH, version: normalizeVersion(f.LEGACY_VERSION ?? '') } : null,
        node,
        npm: f.NPM && f.NPM !== 'none' ? f.NPM : undefined,
        nodeOk: nodeMajorOk(node),
    };
    if (!platform) {
        report.unsupportedReason = `官方 2.x 没有 ${f.ONLY_OS}/${f.MACHINE} 的构建`;
    }
    else if (platform.startsWith('linux') && glibc && compareVersions(glibc, MINIMUM_GLIBC) < 0) {
        report.unsupportedReason = `目标机 glibc ${glibc} 低于官方 2.x 的下限 ${MINIMUM_GLIBC}`;
    }
    return report;
}
/** `opencode --version` 的几种写法（`opencode v2.0.27` / `2.0.27`）。 */
export function normalizeVersion(raw) {
    const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw);
    return match?.[1] ?? raw.trim();
}
/** 目标机的 node 够不够装运行时/跑 npx 形态的 MCP（D12 的 runtime 一类）。
 *  没有 node 与 node 太老都算不够，但理由不同——调用方按 `detect.node` 分辨。 */
export function nodeMajorOk(node, minimum = MINIMUM_NODE_MAJOR) {
    if (!node)
        return false;
    const version = node.replace(/^v/i, '').trim();
    if (!/^\d+/.test(version))
        return false;
    return compareVersions(version, String(minimum)) >= 0;
}
/** 四档阶梯（D8）。projectPath 由档案给出；没绑项目时第④档如实报缺。 */
export function toReadiness(report, options = {}) {
    const steps = [];
    steps.push({
        id: 'ssh',
        label: '① SSH 可达',
        ok: report.reachable && !report.error,
        detail: report.error ?? (report.reachable ? `已连上（${report.os ?? '未知系统'}）` : '连不上'),
    });
    const shellOk = Boolean(report.reachable && report.hasSh && report.hasTar && report.homeWritable);
    steps.push({
        id: 'shell',
        label: '② sh + tar + 可写 $HOME',
        ok: shellOk,
        detail: report.reachable
            ? [report.hasSh ? 'sh ✓' : 'sh ✗', report.hasTar ? 'tar ✓' : 'tar ✗', report.homeWritable ? '$HOME 可写 ✓' : '$HOME 不可写 ✗'].join(' · ')
            : '未知（先连上）',
    });
    const engineVersion = report.engine?.version;
    const engineOk = Boolean(engineVersion && isSupportedEngineVersion(engineVersion));
    const anchor = options.anchorVersion;
    const drift = engineOk && anchor && engineVersion !== anchor;
    steps.push({
        id: 'engine',
        label: '③ 引擎在位且版本匹配',
        ok: engineOk && !drift,
        detail: !engineVersion
            ? report.legacyEngine
                ? `~/.opencode/bin 里没有；另有既有安装 ${report.legacyEngine.version || '（版本未知）'}@${report.legacyEngine.path}（不会动它）`
                : '未安装'
            : drift
                ? `在位 ${engineVersion}，与面板宿主 ${anchor} 不一致`
                : `在位 ${engineVersion}`,
    });
    const project = options.projectPath;
    steps.push({
        id: 'project',
        label: '④ 远程工作目录可写',
        ok: Boolean(project) && Boolean(report.reachable),
        detail: project ? `${project}` : '档案还没有绑定工作目录',
    });
    for (const step of steps) {
        if (!step.ok)
            step.action = readinessAction(step.id);
    }
    return {
        steps,
        ready: steps.every((s) => s.ok),
    };
}
