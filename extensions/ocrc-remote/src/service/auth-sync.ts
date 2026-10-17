/** 引擎凭据通道——唯一被允许搬运密钥的一条路（D11 的例外）。
 *
 * 为什么它是例外：**能力需要密钥**。面板侧配好的 provider 换到被控端，如果不把凭据
 * 送过去，那边的 agent 就是残废的（这正是用户 grill 时指出的「两边能力不一致」）。
 * 但例外只开在这一条上，而且有四道限制：
 *   · 只搬 **provider 凭据**（引擎自己的 `auth.json`，两端的 schema 相同）；
 *   · **传输凭据永不离开面板宿主**——SSH 私钥/密码、TG bot token 完全不在此模块的视野内；
 *   · **粘性合并**：被控端已有的同名条目被面板覆盖，被控端独有的条目一律保留；
 *   · 返回值里**只有 provider 名字**，密钥的值既不进日志也不回面板。
 *
 * 落点是引擎的凭据文件（`~/.local/share/opencode/auth.json`），不是配置文件——
 * 「密钥不写进任何配置文件」这条没有被破坏。
 */
import type { SshProfile } from '../shared/protocol.js'

/** 我们在被控端读写的凭据文件。opencode 自己的 `auth login` 写的就是它。 */
export const AUTH_RELATIVE_PATH = '.local/share/opencode/auth.json'

export interface AuthInventory {
  /** 两端各有那些 provider（名字而已）。 */
  panelProviders: string[]
  remoteProviders: string[]
  /** 面板有、被控端没有 → 会被追加。 */
  missing: string[]
  /** 两端都有 → 面板覆盖被控端的同名条目（粘性合并的另一半）。 */
  overlapping: string[]
  /** 被控端独有 → 一律保留。 */
  remoteOnly: string[]
}

export function authPathFor(home: string): string {
  return `${home.replace(/\/+$/, '')}/${AUTH_RELATIVE_PATH}`
}

export function buildAuthReadScript(home: string): string {
  const path = authPathFor(home)
  const q = `'${path.replaceAll("'", `'\\''`)}'`
  return [
    `P=${q}`,
    'if [ -f "$P" ]; then echo "AUTH_EXISTS=yes"; echo "AUTH_BEGIN"; base64 < "$P"; echo; echo "AUTH_END";',
    'else echo "AUTH_EXISTS=no"; fi',
    'echo "AUTH_READ_DONE=1"',
  ].join('\n')
}

export function parseAuthRead(stdout: string): Record<string, unknown> {
  const exists = /AUTH_EXISTS=yes/.test(stdout)
  if (!exists) return {}
  const block = /AUTH_BEGIN\r?\n([\s\S]*?)\r?\nAUTH_END/.exec(stdout)
  if (!block) return {}
  try {
    const text = Buffer.from(block[1].replace(/[\r\n]/g, ''), 'base64').toString('utf-8')
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    // 坏文件当作空：合并会把它整份替换，而 `.ocrc-bak` 会留着原样。
    return {}
  }
}

/** 两端 provider 的名字账。**只回名字**——这个函数是面板能看到凭据的唯一一面。 */
export function compareAuth(panel: Record<string, unknown>, remote: Record<string, unknown>): AuthInventory {
  const panelProviders = Object.keys(panel).sort()
  const remoteProviders = Object.keys(remote).sort()
  const remoteSet = new Set(remoteProviders)
  const panelSet = new Set(panelProviders)
  return {
    panelProviders,
    remoteProviders,
    missing: panelProviders.filter((p) => !remoteSet.has(p)),
    overlapping: panelProviders.filter((p) => remoteSet.has(p)),
    remoteOnly: remoteProviders.filter((p) => !panelSet.has(p)),
  }
}

/** 粘性合并：同名条目面板覆盖，被控端独有的原样保留。
 *  `undefined` 面板值 = 不动（与项目级配置同一条规则）。 */
export function mergeAuth(panel: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...remote }
  for (const [provider, entry] of Object.entries(panel)) {
    if (entry === undefined) continue
    out[provider] = entry
  }
  return out
}

export function authHasChanges(panel: Record<string, unknown>, remote: Record<string, unknown>): boolean {
  return JSON.stringify(mergeAuth(panel, remote)) !== JSON.stringify(remote)
}

/** 原子写 + `.ocrc-bak`：与项目级配置同一套写法，且权限收紧到 0600——
 *  这是凭据文件，不管是新建还是覆盖都要是私有。 */
export function buildAuthWriteScript(home: string, base64: string): { script: string; stdin: string } {
  const path = authPathFor(home)
  const q = `'${path.replaceAll("'", `'\\''`)}'`
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
  ].join('\n')
  return { script, stdin: base64 }
}

/** 面板宿主上的凭据文件。openchamber 与引擎共用同一份（XDG 布局）。
 *
 * 分隔符看的是**home 这个字符串自己**，不是宿主的 process.platform：Windows 上
 * 也可能配 XDG 风格的路径（Git Bash、WSL 互通目录），那时用反斜杠会拼出一个不
 * 存在的文件。 */
export function panelAuthPath(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg) return `${xdg.replace(/[\\/]+$/, '')}/opencode/auth.json`
  if (env.APPDATA && process.platform === 'win32' && !env.HOME) return `${env.APPDATA}\\opencode\\auth.json`
  const home = (env.HOME ?? env.USERPROFILE ?? '').replace(/[\\/]+$/, '')
  const sep = home.includes('\\') ? '\\' : '/'
  return `${home}${sep}.local${sep}share${sep}opencode${sep}auth.json`
}

/** 一条 ssh 用不到的目标机字段——留给调用方核对档案（凭据永远不跟着档案走）。 */
export function assertSameProviderShape(profile: SshProfile, entries: Record<string, unknown>): void {
  if (!profile.host) throw new Error('档案没有主机')
  if (Object.keys(entries).length === 0) throw new Error('没有可搬运的 provider 凭据')
}
