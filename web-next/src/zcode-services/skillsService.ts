// zcode-services/skillsService.ts — ocrc-backed ISkillsService（N6 批次 2C）。
//
// 技能面在 ocrc 是「源目录注册表 + symlink 生效」（M5 tail）：
//   list      ← /api/settings/skills-manager（host 扫描：源/启用/冲突）+ /api/skills（引擎可见面）
//   setEnabled← /api/settings/skills-manager/toggle（enable = symlink 进 ~/.config/opencode/skills）
// 内容编辑/删除/跨机同步：ocrc 无对应面，如实拒绝（不写没人读的文件）。
import { withGhosts } from './ghost.js'

interface OcrcSkillsScan {
  effectiveDir?: string
  sources?: string[]
  skills?: Array<{ name: string; description?: string; source?: string; enabled?: boolean; conflict?: boolean; path?: string }>
  conflicts?: string[]
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }
}

async function getJson<T>(url: string, fallback: T): Promise<T> {
  const res = await fetch(url, { headers: auth() }).catch(() => null)
  if (!res?.ok) return fallback
  return (await res.json()) as T
}

export function createOcrcSkillsService(): Record<string, any> {
  async function scan(): Promise<OcrcSkillsScan> {
    return getJson<OcrcSkillsScan>('/api/settings/skills-manager', {})
  }

  return withGhosts('skillsService', {
    list: async (_params: { workspacePath?: string }) => {
      const data = await scan()
      const skills = (data.skills ?? []).map((s) => ({
        id: s.name,
        name: s.name,
        description: s.description ?? '',
        body: '',
        path: s.path ?? '',
        scope: 'user' as const,
        enabled: s.enabled !== false,
        // 冲突是 ocrc 的真事实（同名技能来自多个源）——透传给设置页的告警位
        conflict: s.conflict === true,
        source: s.source,
      }))
      return {
        skills,
        capability: { userScopeAvailable: true },
        diagnostics: (data.conflicts ?? []).map((name) => ({
          code: 'skill_duplicate_name' as const,
          severity: 'warning' as const,
          message: `技能 ${name} 在多个源里重名`,
          skillName: name,
        })),
      }
    },

    /** enable/disable = 在 ~/.config/opencode/skills 建/删 symlink（M5 的生效模型）。 */
    setEnabled: async (params: { skillId: string; enabled: boolean; scope?: string }) => {
      const data = await scan()
      const skill = (data.skills ?? []).find((s) => s.name === params.skillId)
      if (!skill) throw new Error(`[ocrc-fork] 未找到技能 ${params.skillId}`)
      const res = await fetch('/api/settings/skills-manager/toggle', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: params.skillId, source: skill.source ?? '', enabled: params.enabled }),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `toggle ${res.status}`)
    },

    // 技能内容编辑 / 删除 / 跨机同步：ocrc 无对应面（源目录是用户自己的文件）。
    buildPromptContext: async () => { throw new Error('[ocrc-fork] 技能 prompt 上下文由引擎侧组装，/z/ 不代劳') },
    copyToCommon: async () => { throw new Error('[ocrc-fork] ocrc 的技能生效模型是源目录 + symlink，没有 .zcode/skills 通用目录') },
    removeFromCommon: async () => { throw new Error('[ocrc-fork] 同上：ocrc 没有 .zcode/skills 通用目录') },
    deleteSkill: async () => { throw new Error('[ocrc-fork] 删除技能会动用户的源文件，/z/ 不提供（请直接操作技能源目录）') },
  })
}
