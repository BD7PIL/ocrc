import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 0.27 M5-tail 技能源管理 (user-stated convention):
 *   源目录 (sources)  — registered dirs, each holding <skill-name>/SKILL.md
 *   生效目录 (effective) — ~/.config/opencode/skills/<name> → symlink to the
 *                         source skill dir. Toggle = symlink add/remove.
 * Conflicts: the same skill name discovered in multiple sources — the first
 * registered source wins for "enable", and the scan flags it.
 */

export interface SkillEntry {
  name: string
  source: string
  path: string
  description?: string
}

export interface SkillStatus extends SkillEntry {
  enabled: boolean
  conflict: boolean
}

export interface SkillsScan {
  effectiveDir: string
  sources: string[]
  skills: SkillStatus[]
  conflicts: string[]
}

export function effectiveSkillsDir(home = process.env.HOME ?? ''): string {
  return join(home, '.config', 'opencode', 'skills')
}

export function sourcesPath(stateDir: string): string {
  return join(stateDir, 'skills-sources.json')
}

export function readSources(stateDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(sourcesPath(stateDir), 'utf-8')) as { sources?: unknown }
    return Array.isArray(v.sources) ? v.sources.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

export function writeSources(stateDir: string, sources: string[]): void {
  const tmp = `${sourcesPath(stateDir)}.tmp`
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(tmp, JSON.stringify({ sources }, null, 2))
  renameSyncSafe(tmp, sourcesPath(stateDir))
}

function renameSyncSafe(from: string, to: string): void {
  // atomic replace (rename over existing works on POSIX)
  renameSync(from, to)
}

function readSkillDescription(skillDir: string): string | undefined {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    const m = md.match(/^description:\s*(.+)$/m)
    if (m) return m[1]!.trim()
    const h1 = md.match(/^#\s+(.+)$/m)
    return h1?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** Pure: merge per-source discoveries into the conflict-aware skill table. */
export function mergeDiscoveries(discoveries: Array<{ source: string; entries: SkillEntry[] }>): { skills: Array<SkillEntry & { conflict: boolean }>; conflicts: string[] } {
  const byName = new Map<string, Array<{ source: string; path: string; description?: string }>>()
  for (const d of discoveries) {
    for (const e of d.entries) {
      const list = byName.get(e.name) ?? []
      list.push({ source: d.source, path: e.path, description: e.description })
      byName.set(e.name, list)
    }
  }
  const skills: Array<SkillEntry & { conflict: boolean }> = []
  const conflicts: string[] = []
  for (const [name, list] of byName) {
    const conflict = list.length > 1
    if (conflict) conflicts.push(name)
    for (const item of list) {
      skills.push({ name, source: item.source, path: item.path, description: item.description, conflict })
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))
  return { skills, conflicts }
}

export function scanSource(sourceDir: string): SkillEntry[] {
  if (!existsSync(sourceDir)) return []
  const out: SkillEntry[] = []
  for (const name of readdirSync(sourceDir)) {
    const skillDir = join(sourceDir, name)
    try {
      if (!statSync(skillDir).isDirectory()) continue
    } catch { continue }
    if (!existsSync(join(skillDir, 'SKILL.md'))) continue
    out.push({ name, source: sourceDir, path: skillDir, description: readSkillDescription(skillDir) })
  }
  return out
}

/** Full scan: sources + effective-dir symlink state. */
export function scanSkills(stateDir: string, home = process.env.HOME ?? ''): SkillsScan {
  const effectiveDir = effectiveSkillsDir(home)
  const sources = readSources(stateDir)
  const discoveries = sources.map((source) => ({ source, entries: scanSource(source) }))
  const { skills, conflicts } = mergeDiscoveries(discoveries)

  const enabledPaths = new Set<string>()
  if (existsSync(effectiveDir)) {
    for (const name of readdirSync(effectiveDir)) {
      const link = join(effectiveDir, name)
      try {
        if (!lstatSync(link).isSymbolicLink()) continue
        enabledPaths.add(realpathSync(link))
      } catch { /* dangling symlink */ }
    }
  }
  return {
    effectiveDir,
    sources,
    skills: skills.map((s) => ({ ...s, enabled: enabledPaths.has(s.path) })),
    conflicts,
  }
}

/** Toggle: create/remove the symlink in the effective dir. */
export function toggleSkill(home: string, name: string, sourceDir: string, enabled: boolean): { ok: boolean; error?: string } {
  const effectiveDir = effectiveSkillsDir(home)
  const link = join(effectiveDir, name)
  const target = join(sourceDir, name)
  if (enabled) {
    if (!existsSync(join(sourceDir, name, 'SKILL.md'))) return { ok: false, error: '源目录没有该技能（SKILL.md 缺失）' }
    mkdirSync(effectiveDir, { recursive: true })
    try { rmSync(link, { force: true }) } catch { /* absent */ }
    try {
      symlinkSync(target, link)
    } catch (err) {
      // 建符号链接要平台权限（Windows 非开发者模式/非管理员 = EPERM）。本函数的契约
      // 是 `{ok,error}`，所以必须**如实返回失败**：让 EPERM 冒出去，调用方（面板/命令）
      // 拿到的是未捕获异常，而不是一句能显示给用户的原因。
      return { ok: false, error: `无法创建符号链接：${(err as Error).message}` }
    }
    return { ok: true }
  }
  try {
    const real = existsSync(link) && lstatSync(link).isSymbolicLink() ? realpathSync(link) : ''
    if (real && !real.startsWith(sourceDir)) return { ok: false, error: '该技能不是此源的 symlink — 不移除' }
    rmSync(link, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
