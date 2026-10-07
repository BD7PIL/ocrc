// components/settings/ProjectCards.tsx — M5-2 settings cards scoped to a
// project directory: 模型映射方案库 (presets), 项目 .opencode 文件
// (AGENTS.md / commands / rules / opencode.jsonc), MCP 编辑. Every write is
// two-step (RiskConfirmation) on top of the host's validate→backup→atomic.
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '$lib/api/client.js'
import type { ProjectOverview } from '$lib/api/types.js'

function useProjectDir(): { dir: string | undefined; DirPick: ReactNode } {
  const [dirs, setDirs] = useState<string[]>([])
  const [sel, setSel] = useState<string | undefined>()
  useEffect(() => {
    void import('$lib/stores/sessions.js').then(({ useSessions }) => {
      const set = [...new Set(useSessions.getState().list.map((s) => s.directory).filter(Boolean))] as string[]
      setDirs(set)
      setSel((cur) => cur ?? set[0])
    })
  }, [])
  const DirPick = (
    <div className="mb-3 flex items-center gap-2">
      <span className="label shrink-0">项目</span>
      <select
        className="min-w-0 flex-1 rounded-[9px] px-2.5 py-1.5 outline-none"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
        value={sel ?? ''}
        onChange={(e) => setSel(e.target.value)}
      >
        {dirs.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </div>
  )
  return { dir: sel, DirPick }
}

// ── 模型映射方案库 ─────────────────────────────────────────────────────────
export function MappingCard() {
  const { dir, DirPick } = useProjectDir()
  const [data, setData] = useState<{ current: Record<string, string>; presets: Record<string, Record<string, string>> } | null>(null)
  const [arm, setArm] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [importName, setImportName] = useState('')
  const [error, setError] = useState('')

  const reload = () => {
    if (!dir) return
    void api.getModelPresets(dir).then(setData).catch(() => {})
  }
  useEffect(reload, [dir])

  const apply = (name: string, mapping: Record<string, string>) => {
    if (!dir) return
    if (arm !== name) { setArm(name); return }
    setArm(null)
    void api.applyModelPreset(dir, name, mapping).then((r) => {
      if (r.error) setError(r.error)
      else reload()
    })
  }

  const doImport = () => {
    if (!dir || !importName.trim()) { setError('需要方案名称'); return }
    try {
      const mapping = JSON.parse(importText) as Record<string, string>
      void api.applyModelPreset(dir, importName.trim(), mapping).then((r) => {
        if (r.error) setError(r.error)
        else { setImportText(''); setImportName(''); reload() }
      })
    } catch {
      setError('导入内容不是合法 JSON')
    }
  }

  return (
    <section className="mb-6">
      <h2 className="label mb-2">模型映射方案库（agent → model，写入项目 .opencode 配置）</h2>
      {DirPick}
      {!dir && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>没有已知项目目录——先开一个本地会话</p>}
      {dir && (
        <>
          <p className="label mb-1 mt-2">当前映射</p>
          <div className="flex flex-col gap-0.5">
            {Object.entries(data?.current ?? {}).map(([a, m]) => (
              <div key={a} className="flex items-center gap-2 rounded-[6px] px-2 py-1" style={{ fontSize: 'var(--ui-sm)' }}>
                <span className="mono" style={{ color: 'var(--text-2)' }}>{a}</span>
                <span style={{ color: 'var(--text-4)' }}>→</span>
                <span className="mono min-w-0 flex-1 truncate" style={{ color: 'var(--text-3)' }}>{m}</span>
              </div>
            ))}
            {Object.keys(data?.current ?? {}).length === 0 && (
              <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-4)' }}>项目配置里没有 agent.model 映射</p>
            )}
          </div>

          <p className="label mb-1 mt-3">方案</p>
          <div className="flex flex-col gap-1">
            {Object.entries(data?.presets ?? {}).map(([name, mapping]) => (
              <div key={name} className="flex items-center gap-2 rounded-[6px] px-2 py-1" style={{ fontSize: 'var(--ui-sm)' }}>
                <span style={{ color: 'var(--text-2)' }}>{name}</span>
                <span className="mono min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
                  {Object.entries(mapping).map(([a, m]) => `${a}→${m}`).join(' ')}
                </span>
                <button type="button" className="demo-btn" onClick={() => apply(name, mapping)}>
                  {arm === name ? '确认应用（写入项目配置）' : '应用'}
                </button>
                <button
                  type="button"
                  className="demo-btn"
                  onClick={() => {
                    setImportName(name)
                    setImportText(JSON.stringify(mapping, null, 2))
                  }}
                >
                  导出
                </button>
              </div>
            ))}
            {Object.keys(data?.presets ?? {}).length === 0 && (
              <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-4)' }}>没有已保存方案——用下方导入创建</p>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2 rounded-[9px] p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-2)' }}>
            <span className="label">导入 / 覆盖方案（JSON：{"{agent: model}"}）</span>
            <input className="rounded-[9px] px-2.5 py-1.5 outline-none" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }} placeholder="方案名称" value={importName} onChange={(e) => setImportName(e.target.value)} />
            <textarea className="mono rounded-[9px] p-2 outline-none" rows={3} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-2xs)' }} placeholder='{"build": "provider/model", "plan": "provider/model"}' value={importText} onChange={(e) => setImportText(e.target.value)} />
            {error && <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--err)' }}>{error}</p>}
            <div className="flex justify-end"><button type="button" className="demo-btn" onClick={doImport}>保存方案</button></div>
          </div>
        </>
      )}
    </section>
  )
}

// ── 项目 .opencode 文件（AGENTS.md / commands / rules / opencode.jsonc）────
export function ProjectFilesCard() {
  const { dir, DirPick } = useProjectDir()
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null)
  const [arm, setArm] = useState(false)
  const [error, setError] = useState('')

  const reload = () => {
    if (!dir) return
    void api.getProjectOverview(dir).then(setOverview).catch(() => {})
  }
  useEffect(reload, [dir])

  const open = (path: string, content: string) => { setEditing({ path, content }); setArm(false); setError('') }
  const save = () => {
    if (!dir || !editing) return
    if (!arm) { setArm(true); return }
    setArm(false)
    void api.putProjectFile(dir, editing.path, editing.content).then((r) => {
      if (r.error) { setError(r.error); return }
      setEditing(null)
      reload()
    })
  }

  return (
    <section className="mb-6">
      <h2 className="label mb-2">项目 .opencode/ 文件（AGENTS.md · commands · rules · opencode.jsonc）</h2>
      {DirPick}
      {!dir && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>没有已知项目目录</p>}
      {dir && overview && (
        <div className="flex flex-col gap-2">
          <FileRow name="AGENTS.md" exists={overview.agentsMd.exists} onOpen={() => open('AGENTS.md', overview.agentsMd.content)} />
          <FileRow name="opencode.jsonc" exists={overview.projectConfig.exists} onOpen={() => open('.opencode/opencode.jsonc', overview.projectConfig.content || '{\n}')} />
          <p className="label mt-2">commands/（{overview.commands.length}）</p>
          {overview.commands.map((f) => (
            <FileRow key={f.name} name={`command/${f.name}.md`} exists onOpen={() => open(`.opencode/command/${f.name}.md`, f.content)} />
          ))}
          <button
            type="button"
            className="self-start rounded-[6px] px-2 py-1"
            style={{ border: '1px dashed var(--border)', fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}
            onClick={() => open(`.opencode/command/new-command.md`, '')}
          >
            + 新建 command
          </button>
          <p className="label mt-2">rules/（{overview.rules.length}）</p>
          {overview.rules.map((f) => (
            <FileRow key={f.name} name={`rule/${f.name}.md`} exists onOpen={() => open(`.opencode/rule/${f.name}.md`, f.content)} />
          ))}
          <button
            type="button"
            className="self-start rounded-[6px] px-2 py-1"
            style={{ border: '1px dashed var(--border)', fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}
            onClick={() => open(`.opencode/rule/new-rule.md`, '')}
          >
            + 新建 rule
          </button>
        </div>
      )}

      {editing && (
        <div className="mt-3 rounded-[9px] p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--accent-line)' }}>
          <p className="mono mb-1.5" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>{dir}/{editing.path}</p>
          <textarea
            className="mono w-full rounded-[9px] p-2.5 outline-none"
            rows={10}
            spellCheck={false}
            style={{ background: 'var(--bg-code)', border: '1px solid var(--border-2)', color: 'var(--text)', fontSize: 'var(--ui-2xs)' }}
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          />
          {error && <p className="mt-1" style={{ fontSize: 'var(--ui-xs)', color: 'var(--err)' }}>{error}</p>}
          <div className="mt-2 flex items-center justify-end gap-2">
            {arm && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--warn)' }}>写入 {editing.path}（备份 .ocrc-bak）</span>}
            {arm && <button type="button" className="demo-btn" onClick={() => setArm(false)}>取消</button>}
            <button
              type="button"
              className="rounded-[9px] px-3 py-1.5"
              style={{ background: arm ? 'var(--err)' : 'var(--accent)', color: arm ? '#fff' : 'var(--accent-ink)', fontSize: 'var(--ui-xs)' }}
              onClick={save}
            >
              {arm ? '确认写入' : '保存'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function FileRow({ name, exists, onOpen }: { name: string; exists: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-elev2)]"
      style={{ fontSize: 'var(--ui-sm)' }}
      onClick={onOpen}
    >
      <span className="mono min-w-0 flex-1 truncate" style={{ color: exists ? 'var(--text-2)' : 'var(--text-4)' }}>{name}</span>
      {!exists && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>(不存在 — 保存即创建)</span>}
    </button>
  )
}

// ── MCP 编辑 ────────────────────────────────────────────────────────────────
export function McpCard() {
  const { dir, DirPick } = useProjectDir()
  const [mcp, setMcp] = useState<Record<string, Record<string, unknown>>>({})
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ id: string; type: 'local' | 'remote'; command: string; url: string; enabled: boolean }>({ id: '', type: 'local', command: '', url: '', enabled: true })
  const [arm, setArm] = useState<string | null>(null)
  const [error, setError] = useState('')

  const reload = () => {
    if (!dir) return
    void api.getProjectMcp(dir).then((r) => setMcp(r.mcp ?? {})).catch(() => {})
  }
  useEffect(reload, [dir])

  const openNew = () => { setEditId('__new__'); setDraft({ id: '', type: 'local', command: '', url: '', enabled: true }); setArm(null) }
  const openEdit = (id: string) => {
    const e = mcp[id] ?? {}
    setEditId(id)
    setDraft({
      id,
      type: (e.type as 'local' | 'remote') ?? 'local',
      command: typeof e.command === 'string' ? e.command : '',
      url: typeof e.url === 'string' ? e.url : '',
      enabled: e.enabled !== false,
    })
    setArm(null)
  }
  const save = () => {
    if (!dir) return
    if (!arm) { setArm('__arm__'); return }
    setArm(null)
    const id = editId === '__new__' ? draft.id.trim() : editId
    if (!id) { setError('id 必填'); return }
    const entry: Record<string, unknown> = { type: draft.type, enabled: draft.enabled }
    if (draft.type === 'local') entry.command = draft.command
    else entry.url = draft.url
    void api.setProjectMcp(dir, id, entry).then((r) => {
      if (r.error) setError(r.error)
      else { setEditId(null); reload() }
    })
  }
  const remove = (id: string) => {
    if (!dir) return
    if (!arm) { setArm(id); return }
    setArm(null)
    void api.setProjectMcp(dir, id, null).then(() => reload())
  }

  return (
    <section className="mb-6">
      <h2 className="label mb-2">MCP 服务器（项目级，写 opencode.json mcp 表）</h2>
      {DirPick}
      {!dir && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>没有已知项目目录</p>}
      {dir && (
        <>
          <div className="flex flex-col gap-1">
            {Object.entries(mcp).map(([id, e]) => (
              <div key={id} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5" style={{ fontSize: 'var(--ui-sm)' }}>
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: e.enabled !== false ? 'var(--ok)' : 'var(--border)' }}
                  aria-hidden
                />
                <span className="mono min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }}>{id}</span>
                <span className="mono shrink-0" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
                  {typeof e.command === 'string' ? e.command : typeof e.url === 'string' ? e.url : String(e.type ?? '')}
                </span>
                <button type="button" className="demo-btn" onClick={() => openEdit(id)}>编辑</button>
                <button
                  type="button"
                  className="rounded-[6px] px-2 py-1"
                  style={{ fontSize: 'var(--ui-2xs)', color: arm === id ? 'var(--err)' : 'var(--text-4)' }}
                  onClick={() => remove(id)}
                >
                  {arm === id ? '确认删除' : '删除'}
                </button>
              </div>
            ))}
            {Object.keys(mcp).length === 0 && <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-4)' }}>项目配置里没有 MCP 服务器</p>}
          </div>
          <button type="button" className="mt-2 rounded-[6px] px-2 py-1" style={{ border: '1px dashed var(--border)', fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }} onClick={openNew}>
            + 新增 MCP 服务器
          </button>
          {editId !== null && (
            <div className="mt-3 flex flex-col gap-2 rounded-[9px] p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--accent-line)' }}>
              <Field2 label="id" value={editId === '__new__' ? draft.id : editId} onChange={(v) => setDraft({ ...draft, id: v })} disabled={editId !== '__new__'} />
              <div className="flex items-center gap-2">
                <span className="label shrink-0">类型</span>
                {(['local', 'remote'] as const).map((t) => (
                  <button key={t} type="button" className="rounded-full px-3 py-0.5" style={{ fontSize: 'var(--ui-xs)', background: draft.type === t ? 'var(--bg-elev2)' : 'transparent', color: draft.type === t ? 'var(--text)' : 'var(--text-3)' }} onClick={() => setDraft({ ...draft, type: t })}>
                    {t === 'local' ? '本地命令' : '远程 URL'}
                  </button>
                ))}
              </div>
              {draft.type === 'local'
                ? <Field2 label="command" value={draft.command} onChange={(v) => setDraft({ ...draft, command: v })} placeholder="npx -y some-mcp" />
                : <Field2 label="url" value={draft.url} onChange={(v) => setDraft({ ...draft, url: v })} placeholder="https://…/mcp" />}
              <label className="flex items-center gap-2" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用
              </label>
              {error && <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--err)' }}>{error}</p>}
              <div className="flex items-center justify-end gap-2">
                {arm && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--warn)' }}>写入项目 opencode.json</span>}
                <button type="button" className="demo-btn" onClick={() => setEditId(null)}>取消</button>
                <button type="button" className="rounded-[9px] px-3 py-1.5" style={{ background: arm ? 'var(--err)' : 'var(--accent)', color: arm ? '#fff' : 'var(--accent-ink)', fontSize: 'var(--ui-xs)' }} onClick={save}>
                  {arm ? '确认写入' : '保存'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Field2({ label, value, onChange, placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <div>
      <span className="label">{label}</span>
      <input
        className="mt-1 w-full rounded-[9px] px-2.5 py-1.5 outline-none disabled:opacity-50"
        style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
