/**
 * JSONC 读取 — 从 `src/core/settings-service.ts` 抽出来的**仅剩**两块：把带注释/尾逗号的
 * 配置解析成对象。原来那个文件是 ocrc 自己的面板在用的配置服务（provider 补丁、MCP 条目、
 * 连通性测试、模型列表……），那套面已随"驾驶舱"一起从这个仓库删除；实例级的配置同步
 * （`instance-config.ts` / `config-merge.ts`）只需要这两块。
 */

/** 去掉行/块注释与尾逗号，其余原样保留（字符串里的 `//` 不能当注释）。 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  let strCh = ''
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inStr) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === strCh) inStr = false
      i++
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; out += ch; i++; continue }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue }
    out += ch
    i++
  }
  // trailing commas: `,` followed by whitespace then } or ]
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** 解析 JSONC；失败时给出行列，不抛。 */
export function parseConfig(raw: string): { ok: boolean; parsed?: Record<string, unknown>; error?: string } {
  try {
    const parsed = JSON.parse(stripJsonc(raw)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '顶层不是对象' }
    }
    return { ok: true, parsed: parsed as Record<string, unknown> }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
