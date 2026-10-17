/** 面板侧 provisioning 的数据模型。
 *
 * 正文与逐条裁决见 PRODUCT 第零点九条与 docs/research/panel-provisioning-verdict.md
 *  （D1–D19）。两个约束贯穿本文件：
 *    · 档案是**主机级**（D16）——隧道、引擎、运行时、版本都绑主机；项目目录是它下面的子项。
 *    · 同步单位是**能力**（D11）——每项能力声明自己要什么（密钥/网络/运行时），
 *      provisioning 负责在目标侧凑齐，而不是按凭据类别搬运。
 *
 * 纯类型 + 纯函数：面板（浏览器沙箱）与服务都 import 它，所以这里不许出现
 * node 内建或 SDK 依赖。
 */
/** 端口换了之后，URL 改写也得跟着换——面板上「改写前后」必须是实际生效的那一对，
 *  否则用户照着一个不存在的端口去配客户端。只替换「正好是那个端口」的位置。 */
export function applyPortChanges(rewrites, changes) {
    if (changes.length === 0)
        return rewrites;
    return rewrites.map((rewrite) => {
        const change = changes.find((c) => hasPort(rewrite.to, c.from));
        return change ? { ...rewrite, to: swapPort(rewrite.to, change.from, change.to) } : rewrite;
    });
}
function hasPort(url, port) {
    return url.includes(`:${port}/`) || url.endsWith(`:${port}`);
}
function swapPort(url, from, to) {
    const marker = `:${from}`;
    const at = url.indexOf(marker);
    if (at < 0)
        return url;
    const after = url.slice(at + marker.length);
    if (after !== '' && !after.startsWith('/'))
        return url;
    return `${url.slice(0, at)}:${to}${after}`;
}
export const MINIMUM_ENGINE_VERSION = '2.0.20';
export const ENGINE_MAJOR = 2;
/** npm 形态的运行时要求的最低 node 大版本——EL7 上的老 node 装不了现代包。 */
export const MINIMUM_NODE_MAJOR = 20;
/** 运行时落点：`<home>/.ocrc/runtime/<name>/<version>`（D12）。名字里的 `/` 与 `@`
 *  在这里被换成 `__`，避免 scoped 包在目标机上造出意外的目录层级。 */
export const RUNTIME_ROOT = '.ocrc/runtime';
/** openchamber 的门禁是 `major === 2 && >= 2.0.20`（其 compatibility.js）；
 *  这里复述同一判据，因为面板宿主是我们唯一的版本源，推之前必须复核（D6）。 */
export function isSupportedEngineVersion(version) {
    const parts = version.split(/[-+]/, 1)[0]?.split('.').map(Number) ?? [];
    if (parts.length < 3 || parts.some((n) => !Number.isInteger(n)))
        return false;
    if (parts[0] !== ENGINE_MAJOR)
        return false;
    const floor = MINIMUM_ENGINE_VERSION.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (parts[i] !== floor[i])
            return parts[i] > floor[i];
    }
    return true;
}
/** `@opencode/cli-<target>` / `-baseline`。musl 永不选（D4）。 */
export function platformPackage(target, variant) {
    const suffix = target.replace(/^linux-|^darwin-|^win32-/, '');
    const os = target.startsWith('linux') ? 'linux' : target.startsWith('darwin') ? 'darwin' : 'windows';
    return `@opencode/cli-${os}-${suffix}${variant === 'baseline' ? '-baseline' : ''}`;
}
/** 官方安装脚本的落点与文件名（照抄其约定，不发明自己的布局）。 */
export function installDirFor(home) {
    return `${home.replace(/\/+$/, '')}/.opencode/bin`;
}
/** 包名 → 目录名：`@scope/pkg` → `scope__pkg`，`pkg` → `pkg`。
 *  只用来造目录，不改写进任何配置——配置里引用的永远是真实入口路径。 */
export function runtimeDirName(packageName) {
    return packageName.replace(/^@/, '').replace(/\//g, '__');
}
/** `~/.ocrc/runtime/<name>/<version>`（D12 的落点约定）。 */
export function runtimeDirFor(home, packageName, version) {
    return `${home.replace(/\/+$/, '')}/${RUNTIME_ROOT}/${runtimeDirName(packageName)}/${version}`;
}
/** 运行时根目录。 */
export function runtimeRootFor(home) {
    return `${home.replace(/\/+$/, '')}/${RUNTIME_ROOT}`;
}
export function engineBinaryName(target) {
    return target.startsWith('win32') ? 'opencode.exe' : 'opencode';
}
/** 缺失的档位在 UI 上怎么讲——一句话必须是能做的事，不能是「部分可用」。 */
export function readinessAction(step) {
    switch (step) {
        case 'ssh': return '检查档案里的地址、端口、私钥路径；面板宿主上先手工 ssh 一次确认能免密登录。';
        case 'shell': return '目标机需要一个可用的 POSIX sh、tar 与可写的 $HOME——这是官方安装路径的最低要求。';
        case 'engine': return '点「部署引擎」把面板宿主的引擎版本装到 ~/.opencode/bin（不覆盖用户既有安装）。';
        case 'project': return '在档案里绑定一个被控机上的工作目录，或在被控机上创建它。';
    }
}
