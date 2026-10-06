// pages/AutomationsPage.tsx — the 自动化 main view (ZCode AutomationsSection
// register, ocrc schedules backend): list with enable switches, 立即运行,
// two-step delete, and an inline create form (every-N / daily-at).
import { useEffect, useState } from 'react'
import { CalendarClock, Play, Trash2, Plus } from 'lucide-react'
import { api, type ScheduleRow, type ScheduleSpec } from '$lib/api/client.js'

export function AutomationsPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = () => {
    void api.schedules().then((r) => { setRows(r.schedules ?? []); setLoaded(true) }).catch(() => setLoaded(true))
  }
  useEffect(reload, [])

  const toggle = (r: ScheduleRow) => {
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
    void api.setScheduleEnabled(r.id, !r.enabled).then(reload)
  }
  const run = (r: ScheduleRow) => { void api.runSchedule(r.id).then(reload) }
  const remove = (r: ScheduleRow) => {
    if (confirmDelete !== r.id) { setConfirmDelete(r.id); return }
    setConfirmDelete(null)
    void api.deleteSchedule(r.id).then(reload)
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-4 flex items-center gap-3">
        <CalendarClock size={18} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
        <h1 style={{ fontSize: 'var(--ui-xl)', color: 'var(--text)' }}>自动化</h1>
        <button
          type="button"
          className="ml-auto flex items-center gap-1.5 rounded-[9px] px-3 py-1.5"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
          onClick={() => setCreating((v) => !v)}
        >
          <Plus size={14} /> 新建
        </button>
      </header>

      {creating && (
        <CreateForm
          onDone={(row) => { setCreating(false); if (row) reload() }}
        />
      )}

      {!loaded && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>加载中…</p>}
      {loaded && rows.length === 0 && (
        <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>
          {creating ? '填写上方表单创建第一个自动化' : '没有定时任务——点「新建」创建'}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-3 rounded-[9px] px-4 py-3"
            style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-2)' }}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate" style={{ fontSize: 'var(--ui-base)', color: 'var(--text)' }}>{r.name || r.prompt.slice(0, 40)}</p>
              <p className="mono mt-0.5 truncate" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
                {specLabel(r.spec)}{r.lastRunAt ? ` · 上次运行 ${new Date(r.lastRunAt).toLocaleString()}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="rounded-[6px] p-1.5"
              style={{ color: 'var(--text-3)' }}
              title="立即运行"
              onClick={() => run(r)}
            >
              <Play size={14} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={r.enabled}
              className="h-4 w-7 shrink-0 rounded-full transition-colors"
              style={{ background: r.enabled ? 'var(--accent)' : 'var(--border)' }}
              onClick={() => toggle(r)}
            >
              <span
                className="block h-3 w-3 rounded-full transition-transform"
                style={{ background: 'var(--bg-elev)', transform: r.enabled ? 'translateX(14px)' : 'translateX(2px)' }}
              />
            </button>
            <button
              type="button"
              className="rounded-[6px] p-1.5"
              style={{ color: confirmDelete === r.id ? 'var(--err)' : 'var(--text-4)' }}
              title={confirmDelete === r.id ? '再点一次确认删除' : '删除'}
              onClick={() => remove(r)}
            >
              <Trash2 size={14} strokeWidth={1.75} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function specLabel(spec: ScheduleSpec): string {
  if (spec.kind === 'every') return `每 ${spec.minutes} 分钟`
  return `每天 ${spec.time}`
}

function CreateForm({ onDone }: { onDone: (row: ScheduleRow | null) => void }) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<'every' | 'daily'>('every')
  const [minutes, setMinutes] = useState('60')
  const [time, setTime] = useState('05:20')
  const [busy, setBusy] = useState(false)

  const create = () => {
    const spec: ScheduleSpec = kind === 'every'
      ? { kind: 'every', minutes: Math.max(1, Number(minutes) || 60) }
      : { kind: 'daily', time }
    setBusy(true)
    void api.addSchedule({ name: name.trim() || undefined, prompt: prompt.trim(), spec, enabled: true })
      .then((r) => onDone(r.schedule ?? null))
      .catch(() => onDone(null))
  }

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-[9px] p-4" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
      <Field label="名称（可选）" value={name} onChange={setName} placeholder="每日巡检" />
      <Field label="提示词" value={prompt} onChange={setPrompt} placeholder="要 agent 每次执行的内容" multiline />
      <div className="flex items-end gap-2">
        <div className="flex gap-0.5 rounded-full p-0.5" style={{ background: 'var(--bg-input)' }}>
          <button type="button" className="rounded-full px-3 py-1" style={{ fontSize: 'var(--ui-xs)', background: kind === 'every' ? 'var(--bg-elev2)' : 'transparent', color: kind === 'every' ? 'var(--text)' : 'var(--text-3)' }} onClick={() => setKind('every')}>每 N 分钟</button>
          <button type="button" className="rounded-full px-3 py-1" style={{ fontSize: 'var(--ui-xs)', background: kind === 'daily' ? 'var(--bg-elev2)' : 'transparent', color: kind === 'daily' ? 'var(--text)' : 'var(--text-3)' }} onClick={() => setKind('daily')}>每天</button>
        </div>
        {kind === 'every'
          ? <input className="w-24 rounded-[9px] px-2.5 py-1.5 outline-none" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          : <input type="time" className="rounded-[9px] px-2.5 py-1.5 outline-none" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }} value={time} onChange={(e) => setTime(e.target.value)} />}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="demo-btn" onClick={() => onDone(null)}>取消</button>
        <button
          type="button"
          className="rounded-[9px] px-4 py-2 disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
          disabled={busy || !prompt.trim()}
          onClick={create}
        >
          创建
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, multiline }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  return (
    <div>
      <label className="label mb-1 block">{label}</label>
      {multiline ? (
        <textarea
          rows={2}
          className="w-full resize-none rounded-[9px] px-2.5 py-1.5 outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="w-full rounded-[9px] px-2.5 py-1.5 outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
