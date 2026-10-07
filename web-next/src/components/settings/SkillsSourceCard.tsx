// components/settings/SkillsSourceCard.tsx — M5-tail 技能源管理 (user
// convention): sources are registered dirs holding <name>/SKILL.md; the
// effective dir (~/.config/opencode/skills) holds symlinks — toggle =
// symlink add/remove; conflicts = same name from multiple sources (first
// registered source wins for enable).
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '$lib/api/client.js'

interface SkillStatus {
  name: string
  source: string
  description?: string
  enabled: boolean
  conflict: boolean
}

interface Scan {
  effectiveDir: string
  sources: string[]
  skills: SkillStatus[]
  conflicts: string[]
  error?: string
}

export function SkillsSourceCard() {
  const [scan, setScan] = useState<Scan | null>(null)
  const [newSource, setNewSource] = useState('')
  const [error, setError] = useState('')

  const reload = () => {
    void api.skillsManager().then((s) => {
      if ('error' in s && s.error) setError(s.error)
      else setScan(s as Scan)
    }).catch((e) => setError((e as Error).message))
  }
  useEffect(reload, [])

  const addSource = () => {
    if (!newSource.trim()) return
    void api.addSkillsSource(newSource.trim()).then(() => { setNewSource(''); reload() }).catch((e) => setError((e as Error).message))
  }
  const removeSource = (dir: string) => {
    void api.removeSkillsSource(dir).then(reload).catch((e) => setError((e as Error).message))
  }
  const toggle = (s: SkillStatus) => {
    void api.toggleSkillSource(s.name, s.source, !s.enabled).then((r) => {
      if ('error' in r && r.error) setError(r.error)
      else reload()
    }).catch((e) => setError((e as Error).message))
  }

  return (
    <section className="mb-6">
      <h2 className="label mb-2">技能源管理（源目录 + symlink 生效开关）</h2>

      <div className="mb-2 flex items-center gap-2">
        <span className="mono shrink-0" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>生效：{scan?.effectiveDir ?? '~/.config/opencode/skills'}</span>
        <button type="button" className="ml-auto rounded-[6px] p-1.5" style={{ color: 'var(--text-3)' }} title="重新扫描" onClick={reload}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="mb-2 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-[9px] px-2.5 py-1.5 outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
          placeholder="注册源目录（含 <name>/SKILL.md）"
          value={newSource}
          onChange={(e) => setNewSource(e.target.value)}
        />
        <button type="button" className="demo-btn" disabled={!newSource.trim()} onClick={addSource}>注册</button>
      </div>

      {(scan?.sources ?? []).length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(scan?.sources ?? []).map((d) => (
            <span key={d} className="mono flex items-center gap-1 rounded-full px-2.5 py-1" style={{ border: '1px solid var(--border)', fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>
              {d}
              <button type="button" style={{ color: 'var(--err)' }} title="移除源" onClick={() => removeSource(d)}>✕</button>
            </span>
          ))}
        </div>
      )}

      {scan?.conflicts.length ? (
        <p className="mb-2 rounded-[6px] px-2.5 py-1.5" style={{ background: 'color-mix(in srgb, var(--warn) 12%, transparent)', color: 'var(--warn)', fontSize: 'var(--ui-xs)' }}>
          名称冲突：{scan.conflicts.join('、')}（同名技能来自多个源 — 启用第一个注册源的版本）
        </p>
      ) : null}

      {error && <p className="mb-2" style={{ fontSize: 'var(--ui-xs)', color: 'var(--err)' }}>{error}</p>}

      <div className="flex flex-col gap-1">
        {(scan?.skills ?? []).map((s) => (
          <div key={`${s.source}::${s.name}`} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5" style={{ fontSize: 'var(--ui-sm)' }}>
            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }}>
              {s.name}
              {s.conflict && <span style={{ color: 'var(--warn)' }}> ⚠冲突</span>}
              <span className="mono ml-2" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{s.source}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={s.enabled}
              className="h-4 w-7 shrink-0 rounded-full transition-colors"
              style={{ background: s.enabled ? 'var(--accent)' : 'var(--border)' }}
              onClick={() => toggle(s)}
            >
              <span className="block h-3 w-3 rounded-full transition-transform" style={{ background: 'var(--bg-elev)', transform: s.enabled ? 'translateX(14px)' : 'translateX(2px)' }} />
            </button>
          </div>
        ))}
        {(scan?.skills ?? []).length === 0 && (
          <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>还没有注册技能源——注册一个含 SKILL.md 子目录的仓库即可扫描并开关</p>
        )}
      </div>
    </section>
  )
}
