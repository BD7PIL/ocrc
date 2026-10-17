/** 我们在被控端读写的凭据文件。opencode 自己的 `auth login` 写的就是它。 */
export const AUTH_RELATIVE_PATH = '.local/share/opencode/auth.json';
export function authPathFor(home) {
    return `${home.replace(/\/+$/, '')}/${AUTH_RELATIVE_PATH}`;
}
export function buildAuthReadScript(home) {
    const path = authPathFor(home);
    const q = `'${path.replaceAll("'", `'\\''`)}'`;
    return [
        `P=${q}`,
        'if [ -f "$P" ]; then echo "AUTH_EXISTS=yes"; echo "AUTH_BEGIN"; base64 < "$P"; echo; echo "AUTH_END";',
        'else echo "AUTH_EXISTS=no"; fi',
        'echo "AUTH_READ_DONE=1"',
    ].join('\n');
}
export function parseAuthRead(stdout) {
    const exists = /AUTH_EXISTS=yes/.test(stdout);
    if (!exists)
        return {};
    const block = /AUTH_BEGIN\r?\n([\s\S]*?)\r?\nAUTH_END/.exec(stdout);
    if (!block)
        return {};
    try {
        const text = Buffer.from(block[1].replace(/[\r\n]/g, ''), 'base64').toString('utf-8');
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        // 坏文件当作空：合并会把它整份替换，而 `.ocrc-bak` 会留着原样。
        return {};
    }
}
/** 两端 provider 的名字账。**只回名字**——这个函数是面板能看到凭据的唯一一面。 */
export function compareAuth(panel, remote) {
    const panelProviders = Object.keys(panel).sort();
    const remoteProviders = Object.keys(remote).sort();
    const remoteSet = new Set(remoteProviders);
    const panelSet = new Set(panelProviders);
    return {
        panelProviders,
        remoteProviders,
        missing: panelProviders.filter((p) => !remoteSet.has(p)),
        overlapping: panelProviders.filter((p) => remoteSet.has(p)),
        remoteOnly: remoteProviders.filter((p) => !panelSet.has(p)),
    };
}
/** 粘性合并：同名条目面板覆盖，被控端独有的原样保留。
 *  `undefined` 面板值 = 不动（与项目级配置同一条规则）。 */
export function mergeAuth(panel, remote) {
    const out = { ...remote };
    for (const [provider, entry] of Object.entries(panel)) {
        if (entry === undefined)
            continue;
        out[provider] = entry;
    }
    return out;
}
export function authHasChanges(panel, remote) {
    return JSON.stringify(mergeAuth(panel, remote)) !== JSON.stringify(remote);
}
/** 原子写 + `.ocrc-bak`：与项目级配置同一套写法，且权限收紧到 0600——
 *  这是凭据文件，不管是新建还是覆盖都要是私有。 */
export function buildAuthWriteScript(home, base64) {
    const path = authPathFor(home);
    const q = `'${path.replaceAll("'", `'\\''`)}'`;
    const script = [
        'set -e',
        `P=${q}`,
        'D=$(dirname "$P")',
        'mkdir -p "$D"',
        'chmod 700 "$D" 2>/dev/null || true',
        'T=$(mktemp "$D/.ocrc-auth.XXXXXX")',
        'umask 077',
        'base64 -d > "$T"',
        'if [ -f "$P" ]; then cp -p "$P" "$P.ocrc-bak" && echo "OCRC_BAK=$P.ocrc-bak"; fi',
        'mv "$T" "$P"',
        'chmod 600 "$P"',
        'echo "OCRC_AUTH_WRITTEN=$P"',
    ].join('\n');
    return { script, stdin: base64 };
}
/** 面板宿主上的凭据文件。openchamber 与引擎共用同一份（XDG 布局）。
 *
 * 分隔符看的是**home 这个字符串自己**，不是宿主的 process.platform：Windows 上
 * 也可能配 XDG 风格的路径（Git Bash、WSL 互通目录），那时用反斜杠会拼出一个不
 * 存在的文件。 */
export function panelAuthPath(env = process.env) {
    const xdg = env.XDG_DATA_HOME?.trim();
    if (xdg)
        return `${xdg.replace(/[\\/]+$/, '')}/opencode/auth.json`;
    if (env.APPDATA && process.platform === 'win32' && !env.HOME)
        return `${env.APPDATA}\\opencode\\auth.json`;
    const home = (env.HOME ?? env.USERPROFILE ?? '').replace(/[\\/]+$/, '');
    const sep = home.includes('\\') ? '\\' : '/';
    return `${home}${sep}.local${sep}share${sep}opencode${sep}auth.json`;
}
/** 一条 ssh 用不到的目标机字段——留给调用方核对档案（凭据永远不跟着档案走）。 */
export function assertSameProviderShape(profile, entries) {
    if (!profile.host)
        throw new Error('档案没有主机');
    if (Object.keys(entries).length === 0)
        throw new Error('没有可搬运的 provider 凭据');
}
