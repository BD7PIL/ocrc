// zcode/settingsSections.tsx — B9 批次 6：ocrc 域设置分区（vendor 插槽注册表）。
//
// 背景：PRODUCT 第零点七条「做」清单里的设置域四项，后端路由一直在，但 rc.3
// 大清洗（e55d3221）删掉了 rc.2 设置页 → 四个面只剩后端、前端零消费方
// （lib/api/client.ts 里留下死亡包装）。这里按 vendor 的 extraSections 注册表
// （PATCHES #14）把 UI 回填进 /z/ 设置页：
//   ① 模型映射方案库（导出/导入/切换）  ← /api/settings/model-presets
//   ② 项目 .opencode/ 五件套编辑        ← /api/settings/project{,/file}
//   ③ 技能源注册（加/删源 + 冲突诊断）  ← /api/settings/skills-manager{,/sources}
//   ④ 全局配置 raw 编辑                 ← /api/settings/opencode-config
// 一律「如实」：失败把服务端错误原文显示出来，不做静默降级。
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Brain, FileJson, Layers, WandSparkles } from 'lucide-react'
import { setZCodeSettingsExtraSections } from '@zcode/ui'
import { getToken } from '../lib/auth-token.js'

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

async function apiSend<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, { method, headers: authHeaders(true), body: JSON.stringify(body) })
  return (await res.json()) as T
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── 共用小件（与 vendor 设置页同一套 Tailwind 词汇）────────────────────
// 分区标题由设置页按导航配置渲染（i18n），这里只出说明行——避免标题重复。
function SectionShell({ hint, children }: { hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      {hint ? <p className="text-ui-sm text-foreground-subtle">{hint}</p> : null}
      {children}
    </section>
  )
}

function StatusLine({ text, tone = 'info' }: { text: string | null; tone?: 'info' | 'error' | 'ok' }) {
  if (!text) return null
  const cls = tone === 'error' ? 'text-destructive' : tone === 'ok' ? 'text-success' : 'text-foreground-subtle'
  return <p className={`text-ui-sm ${cls}`}>{text}</p>
}

function Btn({
  children,
  onClick,
  disabled,
  variant = 'secondary',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'secondary' | 'primary'
}) {
  const cls =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:opacity-90'
      : 'bg-secondary text-foreground hover:bg-hover'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-ui-sm transition disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  )
}

// ── ① 模型映射方案库 ───────────────────────────────────────────────────
function MappingPresetsSection({ workspacePath }: { workspacePath?: string | null }) {
  const dir = workspacePath ?? ''
  const [current, setCurrent] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<Record<string, Record<string, string>>>({})
  const [name, setName] = useState('')
  const [importText, setImportText] = useState('')
  const [status, setStatus] = useState<{ text: string; tone: 'info' | 'error' | 'ok' } | null>(null)

  const load = useCallback(async () => {
    if (!dir) return
    try {
      const r = await apiGet<{ current: Record<string, string>; presets: Record<string, Record<string, string>> }>(
        `/api/settings/model-presets?dir=${encodeURIComponent(dir)}`,
      )
      setCurrent(r.current ?? {})
      setPresets(r.presets ?? {})
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }, [dir])

  useEffect(() => { void load() }, [load])

  const apply = async (presetName: string, mapping: Record<string, string>) => {
    try {
      const r = await apiSend<{ ok: boolean; error?: string }>('/api/settings/model-presets', { dir, name: presetName, mapping })
      setStatus(r.ok === false ? { text: r.error ?? '应用失败', tone: 'error' } : { text: presetName ? `已应用并保存方案「${presetName}」` : '已应用', tone: 'ok' })
      await load()
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }

  const exportPresets = () => {
    const blob = JSON.stringify({ current, presets }, null, 2)
    void navigator.clipboard?.writeText(blob).then(
      () => setStatus({ text: '方案库 JSON 已复制到剪贴板', tone: 'ok' }),
      () => setStatus({ text: blob, tone: 'info' }),
    )
  }

  const importPresets = async () => {
    try {
      const parsed = JSON.parse(importText) as { presets?: Record<string, Record<string, string>> } | Record<string, string>
      const incoming = (parsed as { presets?: Record<string, Record<string, string>> }).presets ?? (parsed as Record<string, Record<string, string>>)
      const first = Object.entries(incoming)[0]
      if (!first) throw new Error('导入内容里没有方案')
      await apply(first[0], first[1])
      setImportText('')
    } catch (e) {
      setStatus({ text: `导入失败：${errText(e)}`, tone: 'error' })
    }
  }

  if (!dir) return <SectionShell><StatusLine text="当前没有工作区——先打开一个项目。" /></SectionShell>

  return (
    <SectionShell hint="每个 agent 用哪个模型。方案可保存、导出、导入，应用即写进项目 .opencode/opencode.json。">
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-ui-sm text-foreground-subtle">当前映射</p>
        {Object.keys(current).length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">项目配置里还没有 agent 模型映射。</p>
        ) : (
          <ul className="space-y-1">
            {Object.entries(current).map(([agent, model]) => (
              <li key={agent} className="flex items-center justify-between text-ui-sm">
                <span className="font-mono">{agent}</span>
                <span className="text-foreground-subtle">{model}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="方案名（保存当前映射）"
          className="min-w-[200px] flex-1 rounded-md border border-border bg-input px-3 py-1.5 text-ui-sm text-foreground"
        />
        <Btn onClick={() => void apply(name.trim(), current)} disabled={!name.trim() || Object.keys(current).length === 0}>保存方案</Btn>
        <Btn onClick={exportPresets}>导出</Btn>
      </div>
      {Object.keys(presets).length > 0 ? (
        <ul className="space-y-1">
          {Object.entries(presets).map(([presetName, mapping]) => (
            <li key={presetName} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-ui-sm">
              <span>
                {presetName} <span className="text-foreground-subtle">（{Object.keys(mapping).length} 个 agent）</span>
              </span>
              <Btn onClick={() => void apply(presetName, mapping)}>切换到此方案</Btn>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-2">
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='导入：粘贴 {"方案名": {"agent": "model"}} 或 {"presets": {...}}'
          rows={3}
          className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-ui-xs text-foreground"
        />
        <Btn onClick={() => void importPresets()} disabled={!importText.trim()}>导入</Btn>
      </div>
      <StatusLine text={status?.text ?? null} tone={status?.tone ?? 'info'} />
    </SectionShell>
  )
}

// ── ② 项目 .opencode/ 五件套 ───────────────────────────────────────────
interface ProjectOverviewShape {
  dir: string
  agentsMd: { exists: boolean; content: string }
  projectConfig: { exists: boolean; content: string }
  commands: Array<{ name: string; content: string }>
  rules: Array<{ name: string; content: string }>
}

function ProjectFilesSection({ workspacePath }: { workspacePath?: string | null }) {
  const dir = workspacePath ?? ''
  const [overview, setOverview] = useState<ProjectOverviewShape | null>(null)
  const [editing, setEditing] = useState<{ path: string; label: string; content: string } | null>(null)
  const [status, setStatus] = useState<{ text: string; tone: 'info' | 'error' | 'ok' } | null>(null)

  const load = useCallback(async () => {
    if (!dir) return
    try {
      setOverview(await apiGet<ProjectOverviewShape>(`/api/settings/project?dir=${encodeURIComponent(dir)}`))
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }, [dir])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!editing) return
    try {
      const r = await apiSend<{ ok: boolean; error?: string }>(
        '/api/settings/project/file',
        { dir, path: editing.path, content: editing.content },
        'PUT',
      )
      if (r.ok === false) {
        setStatus({ text: r.error ?? '写入失败', tone: 'error' })
        return
      }
      setStatus({ text: `已写入 ${editing.path}（原子写 + 备份）`, tone: 'ok' })
      setEditing(null)
      await load()
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }

  if (!dir) return <SectionShell><StatusLine text="当前没有工作区——先打开一个项目。" /></SectionShell>

  const rows: Array<{ path: string; label: string; exists: boolean; size: number }> = overview
    ? [
        { path: 'AGENTS.md', label: 'AGENTS.md', exists: overview.agentsMd.exists, size: overview.agentsMd.content.length },
        { path: '.opencode/opencode.json', label: 'opencode.json(c)', exists: overview.projectConfig.exists, size: overview.projectConfig.content.length },
        ...overview.commands.map((c) => ({ path: `.opencode/command/${c.name}.md`, label: `command/${c.name}.md`, exists: true, size: c.content.length })),
        ...overview.rules.map((r) => ({ path: `.opencode/rule/${r.name}.md`, label: `rule/${r.name}.md`, exists: true, size: r.content.length })),
      ]
    : []

  const open = async (path: string, label: string) => {
    try {
      const r = await apiGet<{ ok: boolean; content: string }>(
        `/api/settings/project/file?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`,
      )
      setEditing({ path, label, content: r.content ?? '' })
      setStatus(null)
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }

  return (
    <SectionShell hint="项目级五件套（AGENTS.md / opencode.json(c) / commands / rules）。写入是原子的，JSONC 会先校验。">
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.path} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-ui-sm">
            <span className="font-mono">{row.label}</span>
            <span className="flex items-center gap-3">
              <span className="text-foreground-subtle">{row.exists ? `${row.size} 字符` : '不存在（可新建）'}</span>
              <Btn onClick={() => void open(row.path, row.label)}>编辑</Btn>
            </span>
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="space-y-2">
          <p className="font-mono text-ui-sm text-foreground-subtle">{editing.label}</p>
          <textarea
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            rows={14}
            className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-ui-xs text-foreground"
          />
          <div className="flex gap-2">
            <Btn variant="primary" onClick={() => void save()}>保存</Btn>
            <Btn onClick={() => setEditing(null)}>取消</Btn>
          </div>
        </div>
      ) : null}
      <StatusLine text={status?.text ?? null} tone={status?.tone ?? 'info'} />
    </SectionShell>
  )
}

// ── ③ 技能源 ───────────────────────────────────────────────────────────
interface SkillsScan {
  effectiveDir?: string
  sources?: string[]
  skills?: Array<{ name: string; source?: string; path?: string; description?: string; enabled?: boolean; conflict?: boolean }>
  conflicts?: string[]
}

function SkillSourcesSection() {
  const [scan, setScan] = useState<SkillsScan | null>(null)
  const [dirInput, setDirInput] = useState('')
  const [status, setStatus] = useState<{ text: string; tone: 'info' | 'error' | 'ok' } | null>(null)

  const load = useCallback(async () => {
    try {
      setScan(await apiGet<SkillsScan>('/api/settings/skills-manager'))
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const mutateSource = async (dir: string, remove: boolean) => {
    try {
      const r = await apiSend<{ ok: boolean; sources: string[] }>('/api/settings/skills-manager/sources', { dir, remove })
      setStatus({
        text: remove
          ? `已移除源 ${dir}（余 ${r.sources?.length ?? 0} 个）`
          : `已注册源 ${dir}（余 ${r.sources?.length ?? 0} 个；生效 = symlink 进 ${scan?.effectiveDir ?? '~/.config/opencode/skills'}）`,
        tone: 'ok',
      })
      setDirInput('')
      await load()
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }

  const toggle = async (name: string, source: string, enabled: boolean) => {
    try {
      const r = await apiSend<{ ok?: boolean; error?: string }>('/api/settings/skills-manager/toggle', { name, source, enabled })
      if (r.ok === false) setStatus({ text: r.error ?? '启停失败', tone: 'error' })
      await load()
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }

  return (
    <SectionShell hint="源目录注册表：注册即扫描，启用 = symlink 进引擎可见目录。同名技能来自多个源会被标为冲突。">
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-ui-sm text-foreground-subtle">已注册源</p>
        {(scan?.sources ?? []).length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">还没有注册源。</p>
        ) : (
          <ul className="space-y-1">
            {(scan?.sources ?? []).map((s) => (
              <li key={s} className="flex items-center justify-between gap-2 text-ui-sm">
                <span className="truncate font-mono">{s}</span>
                <Btn onClick={() => void mutateSource(s, true)}>移除</Btn>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex gap-2">
          <input
            value={dirInput}
            onChange={(e) => setDirInput(e.target.value)}
            placeholder="/path/to/skills"
            className="flex-1 rounded-md border border-border bg-input px-3 py-1.5 font-mono text-ui-sm text-foreground"
          />
          <Btn onClick={() => void mutateSource(dirInput.trim(), false)} disabled={!dirInput.trim()}>注册源</Btn>
        </div>
      </div>
      {(scan?.conflicts ?? []).length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-1 text-ui-sm text-warning">冲突：{scan?.conflicts?.join('、')}</p>
          <p className="text-ui-xs text-foreground-subtle">同名技能来自多个源——只启用你要的那个。</p>
        </div>
      ) : null}
      <ul className="space-y-1">
        {(scan?.skills ?? []).map((sk) => (
          <li key={`${sk.source}:${sk.name}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-ui-sm">
            <span className="min-w-0">
              <span className="font-mono">{sk.name}</span>
              {sk.conflict ? <span className="ml-2 text-warning">冲突</span> : null}
              <span className="ml-2 text-ui-xs text-foreground-subtle">{sk.source}</span>
            </span>
            <Btn onClick={() => void toggle(sk.name, sk.source ?? '', !(sk.enabled !== false))}>
              {sk.enabled !== false ? '停用' : '启用'}
            </Btn>
          </li>
        ))}
      </ul>
      <StatusLine text={status?.text ?? null} tone={status?.tone ?? 'info'} />
    </SectionShell>
  )
}

// ── ④ 全局配置 raw ─────────────────────────────────────────────────────
interface ConfigSummaryShape {
  providers?: Array<{ id: string; models?: number }>
  mcp?: string[]
  [key: string]: unknown
}

function GlobalConfigSection() {
  const [raw, setRaw] = useState('')
  const [summary, setSummary] = useState<ConfigSummaryShape | null>(null)
  const [status, setStatus] = useState<{ text: string; tone: 'info' | 'error' | 'ok' } | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ raw?: string } & ConfigSummaryShape>('/api/settings/opencode-config')
      setRaw(typeof r.raw === 'string' ? r.raw : JSON.stringify(r, null, 2))
      setSummary(r)
      setLoaded(true)
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    try {
      const r = await apiSend<{ ok?: boolean; error?: string }>('/api/settings/opencode-config', { raw }, 'PUT')
      if (r.ok === false) {
        setStatus({ text: r.error ?? '写入被拒（JSON 校验失败？）', tone: 'error' })
        return
      }
      setStatus({ text: '已写入全局 opencode 配置（备份 + 原子写）', tone: 'ok' })
      await load()
    } catch (e) {
      setStatus({ text: errText(e), tone: 'error' })
    }
  }

  return (
    <SectionShell hint="引擎的全局 opencode 配置原文（~/.config/opencode/opencode.json）。写入前会校验 JSON 并备份。">
      {summary ? (
        <p className="text-ui-sm text-foreground-subtle">
          {Array.isArray(summary.providers) ? `${summary.providers.length} 个 provider` : ''}
          {Array.isArray(summary.mcp) ? ` · ${summary.mcp.length} 个 MCP` : ''}
        </p>
      ) : null}
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={18}
        spellCheck={false}
        className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-ui-xs text-foreground"
        placeholder={loaded ? '' : '正在读取…'}
      />
      <div className="flex gap-2">
        <Btn variant="primary" onClick={() => void save()}>保存</Btn>
        <Btn onClick={() => void load()}>重新读取</Btn>
      </div>
      <StatusLine text={status?.text ?? null} tone={status?.tone ?? 'info'} />
    </SectionShell>
  )
}

/** 注册四个 ocrc 域设置分区（ZCodeApp 模块初始化时调用一次）。 */
export function registerOcrcSettingsSections(): void {
  setZCodeSettingsExtraSections([
    { id: 'ocrcMapping', icon: Layers, titleId: 'settings.ocrcMapping.title', groupId: 'agentCapabilities', render: (ctx) => <MappingPresetsSection workspacePath={ctx.workspacePath} /> },
    { id: 'ocrcProject', icon: FileJson, titleId: 'settings.ocrcProject.title', groupId: 'agentCapabilities', render: (ctx) => <ProjectFilesSection workspacePath={ctx.workspacePath} /> },
    { id: 'ocrcSkillSources', icon: WandSparkles, titleId: 'settings.ocrcSkillSources.title', groupId: 'agentCapabilities', render: () => <SkillSourcesSection /> },
    { id: 'ocrcGlobalConfig', icon: Brain, titleId: 'settings.ocrcGlobalConfig.title', groupId: 'agentCapabilities', render: () => <GlobalConfigSection /> },
  ])
}
