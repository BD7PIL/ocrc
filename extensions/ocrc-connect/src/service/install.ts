/** 目标侧安装——落点、身份、回滚（D4/D17）。
 *
 * 三条不许破的规则：
 *   · 落点只碰 `~/.opencode/bin`（官方默认路径），**绝不覆盖用户既有安装**
 *     （实测被控机上 `~/.local/bin/opencode` 1.18.x 是用户自己的）。
 *   · 身份是**工件的 sha512**，不是版本字符串——它区分「同版本重发」与
 *     「升到一半」两种脏态。同版本但 sha 不同 = 必须重装。
 *   · 推送前旧二进制备份 `.ocrc-bak`，失败自动还原。
 *
 * 这里只生成脚本 + 解析输出；执行走 remote-fs 的 sshExec，于是测试可以直接
 * 断言脚本内容与解析结果。
 */
import type { TargetPlatform } from '../shared/provision.js'
import { engineBinaryName, installDirFor } from '../shared/provision.js'
import { TAR_BINARY_PATH } from './artifact.js'

/** 我们的 marker：与官方安装脚本的目录约定并存，不冲突。 */
export const MARKER_NAME = '.ocrc-deploy.json'
export const BACKUP_SUFFIX = '.ocrc-bak'

export interface MarkerState {
  /** 我们部署的那份工件的 sha512（`sha512-…`）。 */
  integrity?: string
  version?: string
  package?: string
  platform?: TargetPlatform
  deployedAt?: number
}

export interface InstallIdentity {
  /** 目标机上现状：在位版本 + 我们的 marker。 */
  version?: string
  marker?: MarkerState | null
  /** 二进制是否可执行（在位但不可执行 = 脏态）。 */
  executable?: boolean
}

export type InstallDecision =
  | { action: 'install'; reason: string }
  | { action: 'upgrade'; reason: string }
  | { action: 'downgrade'; reason: string }
  | { action: 'reinstall'; reason: string }
  | { action: 'none'; reason: string }

/** 该不该动、动哪个——纯函数，因为「同版本重发」的判据最容易写错。
 *
 * 版本先判、工件后判：版本变了就是升级/降级（面板要这么说），版本没变才轮到
 * 「同版本重发」的判据——那时才需要比 sha512，因为版本号看不出真假。 */
export function decideInstall(
  identity: InstallIdentity,
  wanted: { version: string; integrity: string },
): InstallDecision {
  if (!identity.version) {
    return { action: 'install', reason: '~/.opencode/bin 里还没有引擎' }
  }
  if (identity.executable === false) {
    return { action: 'reinstall', reason: '在位文件不可执行（升到一半或权限被改）' }
  }

  const diff = compareRelease(identity.version, wanted.version)
  if (diff !== 0) {
    const direction = diff < 0 ? 'upgrade' : 'downgrade'
    const tail = diff < 0 ? '镜像面板宿主' : '被控端新于面板宿主，按镜像策略降回'
    if (!identity.marker?.integrity) {
      return { action: direction, reason: `${identity.version} → ${wanted.version}（${tail}；在位文件不是我们部署的，顺带取得身份）` }
    }
    return { action: direction, reason: `${identity.version} → ${wanted.version}（${tail}）` }
  }

  // 版本字符串一致（或只有后缀不同）：这一刻 sha512 才是身份。
  if (identity.version !== wanted.version) {
    return { action: 'reinstall', reason: `版本字符串不同（${identity.version} vs ${wanted.version}），按内容重装` }
  }
  if (!identity.marker?.integrity) {
    return { action: 'reinstall', reason: '在位文件不是我们部署的（没有 marker），按内容重装以取得身份' }
  }
  if (identity.marker.integrity !== wanted.integrity) {
    return { action: 'reinstall', reason: `同在 ${wanted.version} 但工件 sha 不同（面板侧重新发布过），按内容重装` }
  }
  return { action: 'none', reason: `已是 ${wanted.version}，工件一致` }
}

/** 比到第三位就够：官方只发 x.y.z，预发布后缀不参与排序。 */
function compareRelease(left: string, right: string): number {
  const a = left.split(/[-+]/)[0].split('.').map(Number)
  const b = right.split(/[-+]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** 单引号包裹（POSIX sh 唯一可靠的引用方式）。 */
const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** 读现状：版本 + marker + 可执行位，一条 ssh 说完。 */
export function buildIdentityScript(home: string): string {
  const dir = installDirFor(home)
  const bin = `${dir}/${engineBinaryName('linux-x64')}`
  return [
    `D=${q(dir)}`,
    `B=${q(bin)}`,
    'M="$D/' + MARKER_NAME + '"',
    'if [ -f "$B" ]; then echo "PRESENT=yes"; else echo "PRESENT=no"; fi',
    'if [ -x "$B" ]; then echo "EXECUTABLE=yes"; else echo "EXECUTABLE=no"; fi',
    'if [ -f "$B" ]; then echo "VERSION=$("$B" --version 2>/dev/null | head -1)"; fi',
    'if [ -f "$M" ]; then echo "MARKER_BEGIN"; cat "$M"; echo; echo "MARKER_END"; fi',
    'echo "IDENTITY_DONE=1"',
  ].join('\n')
}

export function parseIdentityOutput(stdout: string): InstallIdentity {
  const identity: InstallIdentity = { marker: null }
  let present = false
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('PRESENT=')) present = line.slice('PRESENT='.length).trim() === 'yes'
    else if (line.startsWith('EXECUTABLE=')) identity.executable = line.slice('EXECUTABLE='.length).trim() === 'yes'
    else if (line.startsWith('VERSION=')) identity.version = line.slice('VERSION='.length).trim() || undefined
  }
  if (!present) {
    identity.version = undefined
    identity.marker = null
    return identity
  }
  if (identity.executable === undefined) identity.executable = false
  const block = /MARKER_BEGIN\r?\n([\s\S]*?)\r?\nMARKER_END/.exec(stdout)
  if (block) {
    try {
      const parsed = JSON.parse(block[1]) as MarkerState
      if (parsed && typeof parsed === 'object') identity.marker = parsed
    } catch {
      // 坏 marker 当作没有：按内容重装会重写它，比猜它更安全。
      identity.marker = null
    }
  }
  return identity
}

export interface InstallScriptOptions {
  home: string
  version: string
  integrity: string
  packageName: string
  platform: TargetPlatform
  /** 「从面板推送」时：已经上传到目标机的 tar 路径。 */
  uploadedTar?: string
  /** 「远端直取」时：目标机自己下载的 URL。 */
  downloadUrl?: string
}

/** npm 的 integrity 是 base64；coreutils 的 sha512sum 给的是十六进制。
 *  两条都要能比，所以期望值的两种写法都由 JS 侧算好带进去。 */
export function integrityHex(integrity: string): string {
  const base64 = integrity.replace(/^sha512-/, '')
  return Buffer.from(base64, 'base64').toString('hex')
}

/** 原子安装：取件 → 校验 → 解包 → 验版本 → 备份旧件 → 就位 → 写 marker。
 *  任何一步失败都停在原地并如实报错（`OCRC_ERR=`），不留半截文件。 */
export function buildInstallScript(options: InstallScriptOptions): string {
  const dir = installDirFor(options.home)
  const bin = `${dir}/${engineBinaryName(options.platform)}`
  const marker = `${dir}/${MARKER_NAME}`
  const expectB64 = options.integrity
  const expectHex = integrityHex(options.integrity)

  return [
    'set -e',
    `D=${q(dir)}`,
    'TMP="$D/.ocrc-staging"',
    'mkdir -p "$D"',
    'rm -rf "$TMP" && mkdir -p "$TMP"',
    'cleanup() { rm -rf "$TMP"; }',
    'trap cleanup EXIT',
    // ── 取件：两条路的产物必须过同一套校验（D4）──
    ...(options.uploadedTar
      ? [`mv ${q(options.uploadedTar)} "$TMP/pkg.tgz"`]
      : [
          `URL=${q(options.downloadUrl ?? '')}`,
          'if command -v curl >/dev/null 2>&1; then',
          '  curl -fsSL -o "$TMP/pkg.tgz" "$URL" || { echo "OCRC_ERR=download"; exit 0; }',
          'elif command -v wget >/dev/null 2>&1; then',
          '  wget -q -O "$TMP/pkg.tgz" "$URL" || { echo "OCRC_ERR=download"; exit 0; }',
          'else echo "OCRC_ERR=no-downloader"; exit 0; fi',
        ]),
    // ── 校验身份：openssl 给 base64（与 npm 同形），sha512sum 给十六进制 ──
    `EXPECT_B64=${q(expectB64)}`,
    `EXPECT_HEX=${q(expectHex)}`,
    'GOT_B64=""',
    'GOT_HEX=""',
    'if command -v openssl >/dev/null 2>&1; then',
    '  GOT_B64="sha512-$(openssl dgst -sha512 -binary "$TMP/pkg.tgz" | openssl base64 -A)"',
    'fi',
    'if command -v sha512sum >/dev/null 2>&1; then',
    '  GOT_HEX="$(sha512sum "$TMP/pkg.tgz" | cut -d" " -f1)"',
    'fi',
    'if [ -n "$GOT_B64" ] && [ "$GOT_B64" != "$EXPECT_B64" ]; then echo "OCRC_ERR=integrity"; echo "OCRC_GOT=$GOT_B64"; exit 0; fi',
    'if [ -z "$GOT_B64" ] && [ -n "$GOT_HEX" ] && [ "$GOT_HEX" != "$EXPECT_HEX" ]; then echo "OCRC_ERR=integrity"; echo "OCRC_GOT=sha512-$GOT_HEX"; exit 0; fi',
    'if [ -z "$GOT_B64" ] && [ -z "$GOT_HEX" ]; then echo "OCRC_ERR=no-checksum-tool"; exit 0; fi',
    // ── 解包 + 验版本（版本不符说明包名/变体选错了）──
    'mkdir -p "$TMP/x" && tar -xzf "$TMP/pkg.tgz" -C "$TMP/x"',
    `NEW="$TMP/x/${TAR_BINARY_PATH}"`,
    'if [ ! -f "$NEW" ]; then echo "OCRC_ERR=layout"; exit 0; fi',
    'chmod 755 "$NEW"',
    'NEWV="$("$NEW" --version 2>/dev/null | head -1)"',
    `if ! printf '%s' "$NEWV" | grep -q ${q(options.version)}; then echo "OCRC_ERR=version"; echo "OCRC_GOT=$NEWV"; exit 0; fi`,
    // ── 就位：旧件留 .ocrc-bak，marker 记 sha512（不是版本字符串）──
    `B=${q(bin)}`,
    'if [ -f "$B" ]; then cp -p "$B" "$B' + BACKUP_SUFFIX + '"; fi',
    'mv "$NEW" "$B"',
    'cat > "$TMP/marker.json" <<OCRC_MARKER',
    `{"integrity":${JSON.stringify(expectB64)},"version":${JSON.stringify(options.version)},"package":${JSON.stringify(options.packageName)},"platform":${JSON.stringify(options.platform)},"deployedAt":$(date +%s)}`,
    'OCRC_MARKER',
    `mv "$TMP/marker.json" ${q(marker)}`,
    'echo "OCRC_OK=1"',
    'echo "OCRC_PATH=$B"',
    'echo "OCRC_VERSION=$("$B" --version 2>/dev/null | head -1)"',
    'if [ -f "$B' + BACKUP_SUFFIX + '" ]; then echo "OCRC_BACKUP=$B' + BACKUP_SUFFIX + '"; fi',
  ].join('\n')
}

export interface InstallOutcome {
  ok: boolean
  path?: string
  version?: string
  backup?: string
  error?: string
  /** 校验失败时把期望/实得都带回来——面板要如实显示，不猜。 */
  expected?: string
  got?: string
}

/** 错误码 → 人话。必须能区分「下载失败」与「校验失败」：用户要做的事不同。 */
const INSTALL_ERRORS: Record<string, string> = {
  'no-downloader': '目标机上既没有 curl 也没有 wget——请改走「从面板推送」这条路',
  download: '目标机下载失败（网络或 registry 不可达）——可改走「从面板推送」',
  integrity: '工件校验失败（sha512 不符），已放弃安装',
  'no-checksum-tool': '目标机上没有 openssl 也没有 sha512sum，无法校验工件——拒绝安装未校验的二进制',
  layout: 'tar 包里没有 package/bin/opencode——不是官方平台包',
  version: '解出来的二进制版本与请求不符',
}

export function parseInstallOutput(stdout: string, expectedIntegrity: string): InstallOutcome {
  const fields = new Map<string, string>()
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields.set(line.slice(0, eq), line.slice(eq + 1).trim())
  }
  const err = fields.get('OCRC_ERR')
  if (err) {
    return {
      ok: false,
      error: INSTALL_ERRORS[err] ?? `安装失败（${err}）`,
      ...(err === 'integrity' ? { expected: expectedIntegrity, got: fields.get('OCRC_GOT') } : {}),
      ...(err === 'version' ? { got: fields.get('OCRC_GOT') } : {}),
    }
  }
  if (fields.get('OCRC_OK') !== '1') return { ok: false, error: '安装脚本没有给出结果（连接中断或被 kill）' }
  return {
    ok: true,
    path: fields.get('OCRC_PATH'),
    version: fields.get('OCRC_VERSION'),
    backup: fields.get('OCRC_BACKUP'),
  }
}

/** 失败还原：把 `.ocrc-bak` 挪回去。 */
export function buildRollbackScript(home: string, platform: TargetPlatform): string {
  const bin = `${installDirFor(home)}/${engineBinaryName(platform)}`
  return [
    `B=${q(bin)}`,
    'if [ -f "$B' + BACKUP_SUFFIX + '" ]; then mv "$B' + BACKUP_SUFFIX + '" "$B"; echo "OCRC_ROLLED_BACK=1";',
    'else echo "OCRC_ROLLED_BACK=0"; fi',
  ].join('\n')
}

/** 卸载：只删我们自己的命名空间与 marker（D17）。用户的既有安装不在此列。 */
export function buildUninstallScript(home: string): string {
  const dir = installDirFor(home)
  return [
    `D=${q(dir)}`,
    'rm -f "$D/opencode" "$D/opencode.exe" "$D/opencode2" "$D/opencode2.cmd" "$D/' + BACKUP_SUFFIX + '" "$D/' + MARKER_NAME + '"',
    'rmdir "$D" 2>/dev/null && echo "OCRC_DIR_REMOVED=1" || echo "OCRC_DIR_REMOVED=0"',
    'echo "OCRC_UNINSTALLED=1"',
  ].join('\n')
}
