/** 运行时补齐——npm 形态的 MCP 在目标机上真正落地（D12/D13）。
 *
 * 「能力要什么 → 目标侧凑齐什么」的最后一段：`npx -y mcp-searxng` 这类声明过去
 * 只能靠被控端运行期联网 npx 取件（每次启动都赌一次网络），这里把它换成一个稳定
 * 落点：
 *
 *   <home>/.ocrc/runtime/<pkg>/<slot>/        slot = 声明的版本/dist-tag，缺省 latest
 *   <home>/.ocrc/runtime/<pkg>/<slot>/node_modules/…
 *   <home>/.ocrc/runtime/<pkg>/<slot>/.ocrc-runtime   ← marker（key=value）
 *
 * 三条不许破的规则：
 *   · **不覆盖别人的目录**：`<slot>` 已存在但没有我们的 marker → 报 impossible，
 *     绝不往里 npm install（那会把用户自己装的东西搅成一锅）。
 *   · **入口来自 npm 自己的元数据**：读已装包的 `package.json` 的 `bin`，优先用
 *     `node_modules/.bin/<name>` 垫片（它带正确的解释器与相对路径），而不是我们
 *     猜一个 index.js。
 *   · **装不了就说装不了**：没有 node / node 太老 / 没有 npm / 目标机不出网——四种
 *     理由各不相同，逐项如实报，绝不退化成「部分可用」。
 *
 * 纯函数（脚本生成 + 输出解析 + 决策）在这里；执行由 provision 编排层注入 ssh。
 */
import type { DetectReport, RuntimeNeed, RuntimePlan, RuntimePlanItem } from '../shared/provision.js'
import { MINIMUM_NODE_MAJOR, runtimeDirFor, runtimeRootFor, runtimeDirName } from '../shared/provision.js'

export const RUNTIME_MARKER_NAME = '.ocrc-runtime'
export const RUNTIME_BACKUP_SUFFIX = '.ocrc-bak'
/** 没有钉版本的需求落在哪个槽位（`npm install pkg` 装到的就是「当下的 latest」）。 */
export const LATEST_SLOT = 'latest'

/** 单引号包裹（POSIX sh 唯一可靠的引用方式）——与 install.ts 同一套。 */
const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** 槽位名会进路径，所以只留安全的字符：`^1.2.3` 这种范围写法会被折成 `_1.2.3`。 */
export function runtimeSlot(version: string | undefined): string {
  const slot = (version ?? LATEST_SLOT).trim()
  const safe = slot.replace(/[^A-Za-z0-9._+-]/g, '_')
  return safe && safe !== '.' && safe !== '..' ? safe : LATEST_SLOT
}

/** npm 要装的规格：`pkg` 或 `pkg@version`。 */
export function runtimeSpec(need: RuntimeNeed): string {
  return need.version ? `${need.name}@${need.version}` : need.name
}

export interface NeedDiscovery {
  raw: string
  /** 目标机上已经有什么（互相独立，按下列顺序优先）。 */
  inPath?: string
  /** 我们的落点目录（marker 在才有值）。 */
  installed?: { dir: string; entry: string; version?: string; spec?: string }
  /** 目录在、但不是 ocrc 装的（没有 marker）——不覆盖。 */
  unmanagedDir?: string
  /** path 形态：绝对路径存不存在（`[ -x ]`）。 */
  pathExists?: boolean
}

function markerFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return out
}

/** 一条 ssh 问完所有需求：PATH 里有没有 / 我们的槽位在不在 / marker 说了什么。
 *  逐条 `R<idx>_*` 前缀，于是解析只认前缀，不依赖输出顺序。 */
export function buildRuntimeDiscoverScript(home: string, needs: RuntimeNeed[]): string {
  const root = runtimeRootFor(home)
  const lines: string[] = [`ROOT=${q(root)}`]
  needs.forEach((need, index) => {
    const p = `R${index}`
    if (need.kind === 'path') {
      lines.push(`if [ -x ${q(need.name)} ]; then echo "${p}_KIND=path"; echo "${p}_PATH=${need.name}"; fi`)
      return
    }
    lines.push(`CMD=$(command -v ${q(need.name)} 2>/dev/null || true)`)
    lines.push(`if [ -n "$CMD" ]; then echo "${p}_KIND=in-path"; echo "${p}_INPATH=$CMD"; fi`)
    const pkgDir = `"$ROOT/${runtimeDirName(need.name)}"`
    const slot = runtimeSlot(need.version)
    lines.push(`D=${pkgDir}`)
    // 钉了版本就用那个槽位；没钉就在已有槽位里挑最新的（sort -V）。
    lines.push(`if [ -d "$D" ]; then`)
    lines.push(need.version
      ? `  S=${q(slot)}`
      : '  S=$(ls -1 "$D" 2>/dev/null | sort -V | tail -1)')
    lines.push('  if [ -n "$S" ] && [ -d "$D/$S" ]; then')
    lines.push(`    if [ -f "$D/$S/${RUNTIME_MARKER_NAME}" ]; then`)
    lines.push(`      echo "${p}_KIND=installed"`)
    lines.push(`      echo "${p}_DIR=$D/$S"`)
    lines.push(`      sed -n "s/^ENTRY=/${p}_ENTRY=/p;s/^VERSION=/${p}_VERSION=/p;s/^SPEC=/${p}_SPEC=/p" "$D/$S/${RUNTIME_MARKER_NAME}"`)
    lines.push('    else')
    lines.push(`      echo "${p}_KIND=unmanaged"`)
    lines.push(`      echo "${p}_DIR=$D/$S"`)
    lines.push('    fi')
    lines.push('  fi')
    lines.push('fi')
  })
  lines.push('echo "RUNTIME_DISCOVER_DONE=1"')
  return lines.join('\n')
}

export function parseRuntimeDiscoverOutput(stdout: string, needs: RuntimeNeed[]): Map<string, NeedDiscovery> {
  const table = new Map<string, NeedDiscovery>()
  needs.forEach((need) => table.set(need.raw, { raw: need.raw }))
  const fields = new Map<string, Map<string, string>>()
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const match = /^R(\d+)_([A-Z_]+)=(.*)$/.exec(line)
    if (!match) continue
    const bucket = fields.get(match[1]) ?? new Map<string, string>()
    bucket.set(match[2], match[3])
    fields.set(match[1], bucket)
  }
  for (const [index, values] of fields) {
    const need = needs[Number(index)]
    if (!need) continue
    const entry: NeedDiscovery = { raw: need.raw }
    const kind = values.get('KIND')
    if (kind === 'path') entry.pathExists = true
    if (kind === 'in-path') entry.inPath = values.get('INPATH')
    if (kind === 'unmanaged') entry.unmanagedDir = values.get('DIR')
    if (kind === 'installed') {
      entry.installed = {
        dir: values.get('DIR') ?? '',
        entry: values.get('ENTRY') ?? '',
        version: values.get('VERSION')?.trim() || undefined,
        spec: values.get('SPEC')?.trim() || undefined,
      }
    }
    table.set(need.raw, entry)
  }
  return table
}

export interface RuntimeFacts {
  home: string
  node?: string
  npm?: string
  nodeOk: boolean
  /** 目标机自己能不能出网——现在的 npm 取件依赖它（面板推送留到下一轮）。 */
  outbound?: boolean
}

export function factsFromDetect(detect: DetectReport, home: string): RuntimeFacts {
  return {
    home,
    node: detect.node,
    npm: detect.npm,
    nodeOk: detect.nodeOk ?? false,
    outbound: detect.outbound,
  }
}

/** node 不够用时的理由：没有 node 与 node 太老是两件事（用户要做的事不同）。 */
function nodeReason(facts: RuntimeFacts): string {
  if (!facts.node) return `目标机没有 node——npm 形态的运行时需要 node ≥ ${MINIMUM_NODE_MAJOR}（先在被控端装 node，或用面板侧能力的反向接入）`
  return `目标机的 node ${facts.node} 低于 npm 形态运行时的下限 ${MINIMUM_NODE_MAJOR}`
}

/** 一项运行时该怎么处理——纯函数，每一种「装不了」都有各自的理由。 */
export function decideRuntime(
  need: RuntimeNeed,
  facts: RuntimeFacts,
  discovery: NeedDiscovery | undefined,
  neededBy: string[],
): RuntimePlanItem {
  const base = { need, neededBy }

  if (need.kind === 'path') {
    if (discovery?.pathExists) return { ...base, action: 'present', found: { path: need.name } }
    return {
      ...base,
      action: 'impossible',
      reason: `${need.name} 在目标机上不存在——ocrc 只装 npm 形态的运行时，二进制分发包要你在被控端自己装好`,
    }
  }

  if (discovery?.inPath) {
    return {
      ...base,
      action: 'present',
      found: { path: discovery.inPath },
      reason: `目标机 PATH 里已经有 ${need.name}（${discovery.inPath}）——用它，不另装一份`,
    }
  }
  if (discovery?.installed?.entry) {
    return {
      ...base,
      action: 'present',
      found: { path: discovery.installed.entry, version: discovery.installed.version },
    }
  }
  if (discovery?.unmanagedDir) {
    return {
      ...base,
      action: 'impossible',
      reason: `${discovery.unmanagedDir} 已存在但不是 ocrc 装的（没有 ${RUNTIME_MARKER_NAME} 标记）——不往里装，避免搅乱别人的目录`,
    }
  }

  if (!facts.nodeOk) return { ...base, action: 'impossible', reason: nodeReason(facts) }
  if (!facts.npm) return { ...base, action: 'impossible', reason: '目标机没有 npm——运行时要靠它装；装好 npm 再回来' }
  if (facts.outbound === false) {
    return {
      ...base,
      action: 'impossible',
      reason: '目标机不出网，而运行时要由被控端自己从 npm 取件（面板推送运行时留到下一轮）',
    }
  }

  const slot = runtimeSlot(need.version)
  return {
    ...base,
    action: 'install',
    package: need.name,
    version: need.version,
    // 入口装完才知道（读包自己的 bin）——预演里不写一个假的路径。
    dir: runtimeDirFor(facts.home, need.name, slot),
  }
}

/** 汇总成计划：逐项 install/present/impossible，附带 node/npm 现状（判断依据要一起显示）。 */
export function buildRuntimePlan(
  needs: Array<{ need: RuntimeNeed; neededBy: string[] }>,
  facts: RuntimeFacts,
  discovery: Map<string, NeedDiscovery>,
): RuntimePlan {
  return {
    items: needs.map(({ need, neededBy }) => decideRuntime(need, facts, discovery.get(need.raw), neededBy)),
    root: runtimeRootFor(facts.home),
    node: facts.node,
    npm: facts.npm,
    nodeOk: facts.nodeOk,
  }
}

/** 装完之后给入口垫片用的小工具：读**已装包自己的** package.json 的 bin。
 *  写成 .cjs 避免被任何 `"type":"module"` 影响；没有 bin 的纯库如实报 NO_BIN。 */
export const ENTRY_RESOLVER_SOURCE = `const fs = require('fs')
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
`

export interface RuntimeInstallOptions {
  home: string
  need: RuntimeNeed
  /** registry 覆盖（验收用本地 fixture registry；产品路径不传）。 */
  registry?: string
  /** 忽略 marker 的幂等短路，强制重装。 */
  force?: boolean
}

/** 原子安装一项运行时：幂等短路 → npm install → 解析入口 → 写 marker。
 *
 *  失败时不留半截目录：**这次刚建出来**的槽位目录会被删掉（否则下一次探测会把它当成
 *  「别人装的目录」而永久拒绝安装）。别人早就有的目录一个字节都不动，旧 marker 还原。 */
export function buildRuntimeInstallScript(options: RuntimeInstallOptions): string {
  const { need } = options
  const root = runtimeRootFor(options.home)
  const slot = runtimeSlot(need.version)
  const dir = runtimeDirFor(options.home, need.name, slot)
  const spec = runtimeSpec(need)
  const helper = `${root}/.ocrc-entry-resolver.cjs`
  const helperB64 = Buffer.from(ENTRY_RESOLVER_SOURCE, 'utf-8').toString('base64')

  return [
    `ROOT=${q(root)}`,
    `D=${q(dir)}`,
    'M="$D/' + RUNTIME_MARKER_NAME + '"',
    `SPEC=${q(spec)}`,
    `PKG=${q(need.name)}`,
    `HELPER=${q(helper)}`,
    // ── 前置条件：npm 与 node 是这条路的全部依赖 ──
    'if ! command -v npm >/dev/null 2>&1; then echo "OCRC_ERR=no-npm"; echo "RUNTIME_DONE=1"; exit 0; fi',
    'if ! command -v node >/dev/null 2>&1; then echo "OCRC_ERR=no-node"; echo "RUNTIME_DONE=1"; exit 0; fi',
    // ── 幂等：同 spec 且入口还在 → 什么都不做（force 时跳过这段）──
    ...(options.force ? [] : [
      'if [ -f "$M" ]; then',
      '  PREV_SPEC=$(sed -n "s/^SPEC=//p" "$M" | head -1)',
      '  PREV_ENTRY=$(sed -n "s/^ENTRY=//p" "$M" | head -1)',
      '  if [ "$PREV_SPEC" = "$SPEC" ] && [ -n "$PREV_ENTRY" ] && [ -x "$PREV_ENTRY" ]; then',
      '    echo "OCRC_SKIPPED=1"; echo "OCRC_ENTRY=$PREV_ENTRY"; echo "OCRC_DIR=$D"',
      '    sed -n "s/^VERSION=/OCRC_VERSION=/p" "$M"',
      '    echo "RUNTIME_DONE=1"; exit 0',
      '  fi',
      'fi',
    ]),
    'if [ -d "$D" ]; then PRE_EXISTING=1; else PRE_EXISTING=0; fi',
    // 失败收尾：先还原旧 marker，再只删「这次刚建出来且仍无 marker」的槽位。
    'cleanup_failed() {',
    '  if [ -f "$M' + RUNTIME_BACKUP_SUFFIX + '" ] && [ ! -f "$M" ]; then mv "$M' + RUNTIME_BACKUP_SUFFIX + '" "$M"; fi',
    '  if [ "$PRE_EXISTING" = "0" ] && [ ! -f "$M" ]; then rm -rf "$D" && rmdir "$(dirname "$D")" 2>/dev/null; fi',
    '}',
    'fail_runtime() {',
    '  cleanup_failed',
    '  echo "OCRC_ERR=$1"',
    '  if [ -n "$2" ]; then echo "OCRC_GOT=$2"; fi',
    '  echo "RUNTIME_DONE=1"; exit 0',
    '}',
    'mkdir -p "$ROOT" || fail_runtime root',
    'mkdir -p "$D" || fail_runtime dir',
    'if [ -f "$M" ]; then cp -p "$M" "$M' + RUNTIME_BACKUP_SUFFIX + '"; fi',
    // ── 取件：npm 自己下（--prefix 落点、不写 package.json/lock，保持目录干净）──
    // 参数直接写在命令行上，不攒成字符串变量：`$D` 可能带空格，重新分词会把它拆开
    // （而且 `\"$D\"` 展开后引号是字面量，不是引用）。
    'if ! npm install --prefix "$D" --no-save --no-package-lock --no-audit --no-fund --loglevel=error'
      + (options.registry ? ` --registry ${q(options.registry)}` : '')
      + ' "$SPEC" >"$D/.ocrc-npm.log" 2>&1; then',
    '  fail_runtime install "$(tail -3 "$D/.ocrc-npm.log" 2>/dev/null | tr "\\n" " " | head -c 300)"',
    'fi',
    // ── 入口：读已装包自己的 bin（npm 元数据），优先 .bin 垫片 ──
    `printf '%s' ${q(helperB64)} | (base64 -d 2>/dev/null || openssl base64 -d 2>/dev/null) > "$HELPER"`,
    '[ -s "$HELPER" ] || fail_runtime helper',
    'RESOLVED=$(node "$HELPER" "$D" "$PKG" 2>/dev/null)',
    'if [ -z "$RESOLVED" ] || [ "$RESOLVED" = "NO_BIN" ]; then fail_runtime no-bin; fi',
    'ENTRY=$(printf "%s\\n" "$RESOLVED" | head -1)',
    'VERSION=$(printf "%s\\n" "$RESOLVED" | sed -n "s/^OCRC_VERSION=//p" | head -1)',
    'if [ ! -e "$ENTRY" ]; then fail_runtime entry-missing "$ENTRY"; fi',
    // ── marker：key=value（ssh 面越笨越好，解析复用同一套）──
    'cat > "$D/.ocrc-marker.tmp" <<OCRC_RUNTIME_MARKER',
    'SPEC=$SPEC',
    'PACKAGE=$PKG',
    'VERSION=$VERSION',
    'ENTRY=$ENTRY',
    'SLOT=' + slot,
    `INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    'OCRC_RUNTIME_MARKER',
    'mv "$D/.ocrc-marker.tmp" "$M" || fail_runtime marker',
    'echo "OCRC_OK=1"',
    'echo "OCRC_ENTRY=$ENTRY"',
    'echo "OCRC_VERSION=$VERSION"',
    'echo "OCRC_DIR=$D"',
    'if [ -f "$M' + RUNTIME_BACKUP_SUFFIX + '" ]; then echo "OCRC_BACKUP=$M' + RUNTIME_BACKUP_SUFFIX + '"; fi',
    'echo "RUNTIME_DONE=1"',
  ].join('\n')
}

export interface RuntimeOutcome {
  ok: boolean
  /** 幂等短路：目标机已经是这个 spec，一个字都没写。 */
  skipped?: boolean
  entry?: string
  version?: string
  dir?: string
  backup?: string
  error?: string
}

const RUNTIME_ERRORS: Record<string, string> = {
  'no-npm': '目标机没有 npm——运行时要靠它装',
  'no-node': '目标机没有 node——npm 形态的运行时需要它',
  root: '在目标机上创建 ~/.ocrc/runtime 失败（$HOME 不可写？）',
  dir: '在目标机上创建运行目录失败',
  install: 'npm 安装失败',
  helper: '把入口解析器写到目标机失败（base64/openssl 都不可用？）',
  'no-bin': '这个包没有可执行入口（package.json 里没有 bin）——它是库而不是服务',
  'entry-missing': '解析出来的入口在目标机上不存在',
  marker: '写 marker 失败',
}

export function parseRuntimeInstallOutput(stdout: string, expectedSpec: string): RuntimeOutcome {
  const fields = new Map<string, string>()
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields.set(line.slice(0, eq), line.slice(eq + 1))
  }
  const err = fields.get('OCRC_ERR')
  if (err) {
    const got = fields.get('OCRC_GOT')
    return { ok: false, error: `${RUNTIME_ERRORS[err] ?? `安装失败（${err}）`}${got ? `：${got.trim()}` : ''}` }
  }
  if (fields.get('OCRC_OK') !== '1' && fields.get('OCRC_SKIPPED') !== '1') {
    return { ok: false, error: `安装脚本没有给出结果（${expectedSpec}；连接中断或被 kill）` }
  }
  return {
    ok: true,
    skipped: fields.get('OCRC_SKIPPED') === '1',
    entry: fields.get('OCRC_ENTRY')?.trim(),
    version: fields.get('OCRC_VERSION')?.trim(),
    dir: fields.get('OCRC_DIR')?.trim(),
    backup: fields.get('OCRC_BACKUP')?.trim(),
  }
}

/** 卸载一项运行时：只删我们的槽位目录（marker 在才删），不动别人。 */
export function buildRuntimeRemoveScript(dir: string): string {
  return [
    `D=${q(dir)}`,
    `if [ -f "$D/${RUNTIME_MARKER_NAME}" ]; then rm -rf "$D" && echo "OCRC_REMOVED=1"; else echo "OCRC_REMOVED=0"; fi`,
  ].join('\n')
}

/** 解析 marker 的一行文本（发现路径与测试共用）。 */
export function parseRuntimeMarker(text: string): Record<string, string> {
  return markerFields(text)
}
