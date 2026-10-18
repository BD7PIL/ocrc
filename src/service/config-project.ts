/** 远程**项目级**配置——读与写（PRODUCT 第零点九条 / D9–D11）。
 *
 * 设计要点（全部来自裁决记录，不是实现偏好）：
 *   · 写入目标是 `<项目目录>/opencode.jsonc`——项目根配置**优先级高于全局**，
 *     而且同目录 `.jsonc` 优先于 `.json`。存在 `.jsonc` 就写 `.jsonc`。
 *   · **全局层只读不写**。被控端现存的 `~/.config/opencode/opencode.json` 桥接
 *     （ocrc-remote 0.3.0 的行为）是设计错误：它改的是用户级配置。
 *   · 合并是**按叶覆盖 + 粘性密钥**：面板段覆盖同名项，被控端独有键全部保留，
 *     **面板没提供的密钥字段一律保留远端原值**（否则一次同步就把远端凭据打掉）。
 *   · 只写差异；`*.ocrc-bak` 兜底；坏 JSON 拒绝且不落盘。
 *
 * 纯字符串/结构进出，ssh 由调用方注入——与 remote-fs/omo-config 同一套路。
 * 合并引擎（mergeSticky / hasChanges / stripLiteralSecrets / 读写脚本）已移到
 * `src/core/config-merge.ts`：实例拓扑（C1，被控端 `~/.config/opencode`）用的是
 * 同一份实现，两套合并规则不能各说各话。
 */
import { stripJsonc } from './omo-config.js'
import {
  buildConfigWriteScript, hasChanges, mergeSticky, stripLiteralSecrets,
} from '../../../../src/core/config-merge.js'

/** The atomic writer lives in the shared engine now; the project-level callers
 *  keep their name so the two topologies cannot diverge on backup semantics. */
export const buildProjectConfigWriteScript = buildConfigWriteScript
export { hasChanges, mergeSticky, stripLiteralSecrets }

export const PROJECT_CONFIG_BASENAMES = ['opencode.jsonc', 'opencode.json'] as const

export type ProjectConfigFormat = 'jsonc' | 'json' | 'missing'

export interface ProjectConfigRead {
  projectPath: string
  /** 引擎实际会读的那一个；都不存在时是推荐落点（`.jsonc`）。 */
  targetPath: string
  format: ProjectConfigFormat
  exists: boolean
  /** 原始文本（用于差异化写入与「注释会丢」的如实提示）。 */
  raw?: string
  parsed?: Record<string, unknown>
  parseError?: string
  /** `.jsonc` 里有注释 → 写回会丢注释，面板要如实说。 */
  commentsWillBeLost?: boolean
}

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** 一条 ssh 读完两个候选文件（内容 base64 带回来，避免引号/换行撕碎输出）。 */
export function buildProjectConfigReadScript(projectPath: string): string {
  const dir = projectPath.replace(/\/+$/, '')
  return [
    `D=${q(dir)}`,
    'for name in opencode.jsonc opencode.json; do',
    '  f="$D/$name"',
    '  if [ -f "$f" ]; then',
    '    echo "FOUND=$name"',
    '    echo "SIZE=$(wc -c < "$f" | tr -d " ")"',
    '    echo "B64_BEGIN"',
    '    base64 < "$f"',
    '    echo "B64_END"',
    '    break',
    '  fi',
    'done',
    'echo "READ_DONE=1"',
  ].join('\n')
}

export function parseProjectConfigRead(stdout: string, projectPath: string): ProjectConfigRead {
  const target = `${projectPath.replace(/\/+$/, '')}`
  const found = /^FOUND=(\S+)$/m.exec(stdout)?.[1]
  const block = /B64_BEGIN\r?\n([\s\S]*?)\r?\nB64_END/.exec(stdout)
  if (!found || !block) {
    return {
      projectPath,
      targetPath: `${target}/${PROJECT_CONFIG_BASENAMES[0]}`,
      format: 'missing',
      exists: false,
    }
  }
  const raw = Buffer.from(block[1].replace(/[\r\n]/g, ''), 'base64').toString('utf-8')
  const format: ProjectConfigFormat = found.endsWith('.jsonc') ? 'jsonc' : 'json'
  const result: ProjectConfigRead = {
    projectPath,
    targetPath: `${target}/${found}`,
    format,
    exists: true,
    raw,
  }
  if (format === 'jsonc' && /(^|\n)\s*(\/\/|\/\*)/.test(raw)) result.commentsWillBeLost = true
  try {
    const parsed = JSON.parse(format === 'jsonc' ? stripJsonc(raw) : raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      result.parseError = '顶层不是对象'
    } else {
      result.parsed = parsed as Record<string, unknown>
    }
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error)
  }
  return result
}

/** 深合并：面板段逐叶覆盖，被控端独有的键保留（实现见 src/core/config-merge.ts）。
 *  `undefined` 面板值 = 不修改（这是「粘性」的实现点：缺字段不会打掉远端原值）。 */

/** 原子写：临时文件 → `.ocrc-bak` 备份旧件 → `mv` 就位。内容走 stdin 的
 *  base64（与 fs/write、omo/config 同款，避免引号与换行撕碎脚本）。
 *  实现与实例拓扑共用（`src/core/config-merge.ts` 的 `buildConfigWriteScript`）。 */

/** 面板产物 → 项目级配置。只取白名单段：其余面板字段（含凭据）不落被控端文件。 */
export const PROJECT_WRITE_SECTIONS = ['agent', 'mcp', 'provider', 'agents', 'model', 'small_model', 'permission', 'instructions'] as const

export function extractProjectSections(panelConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of PROJECT_WRITE_SECTIONS) {
    const value = panelConfig[section]
    if (value !== undefined) out[section] = value
  }
  return out
}

