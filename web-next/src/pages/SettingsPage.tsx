// pages/SettingsPage.tsx — the 设置 main view (M5-1 first block):
// Provider/模型配置 (structured editor + 拉模型列表 + write-back) and the
// raw JSONC editor. Every write is RiskConfirmation-style (two-step arm →
// confirm) on top of the host's validate→backup→atomic-write service.
import { useEffect, useState } from 'react'
import { Settings as SettingsIcon, RefreshCw } from 'lucide-react'
import { api } from '$lib/api/client.js'
import type { ConfigSummary } from '$lib/api/types.js'

export function SettingsPage() {
  const [summary, setSummary] = useState<ConfigSummary | null>(null)
  const [error, setError] = useState('')
  const reload = () => {
    void api.getConfig().then((s) => { setSummary(s); setError(s.error ?? '') }).catch((e) => setError((e as Error).message))
  }
  useEffect(reload, [])

  const providers = summary?.providers ?? []

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-4 flex items-center gap-3">
        <SettingsIcon size={18} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
        <h1 style={{ fontSize: 'var(--ui-xl)', color: 'var(--text)' }}>设置</h1>
        <button type="button" className="ml-auto rounded-[6px] p-1.5" style={{ color: 'var(--text-3)' }} title="重新加载" onClick={reload}>
          <RefreshCw size={14} />
        </button>
      </header>

      {error && (
        <p className="mb-4 rounded-[9px] px-3 py-2" style={{ background: 'color-mix(in srgb, var(--err) 12%, transparent)', color: 'var(--err)', fontSize: 'var(--ui-sm)' }}>
          {error}
        </p>
      )}

      {summary && !summary.parsed && (
        <p className="mb-4 rounded-[9px] px-3 py-2" style={{ background: 'color-mix(in srgb, var(--warn) 12%, transparent)', color: 'var(--warn)', fontSize: 'var(--ui-sm)' }}>
          配置文件解析失败（{summary.error}）— 请在下方原文编辑器修复后保存
        </p>
      )}

      {summary && (
        <>
          <p className="mono mb-4" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }} title={summary.path}>
            {summary.path}
          </p>
          <ProvidersSection providers={providers} onChanged={reload} summaryPath={summary.path} raw={summary.raw} />
          <RawEditor raw={summary.raw} onChanged={reload} />
        </>
      )}
    </div>
  )
}

// ── Providers ──────────────────────────────────────────────────────────────
function ProvidersSection({ providers, onChanged, summaryPath, raw }: {
  providers: ConfigSummary['providers']
  onChanged: () => void
  summaryPath: string
  raw: string
}) {
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <section className="mb-6">
      <h2 className="label mb-2">Provider / 模型（{providers.length}）</h2>
      <div className="flex flex-col gap-1.5">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            className="flex w-full items-center gap-3 rounded-[9px] px-4 py-3 text-left transition-colors"
            style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-2)' }}
            onClick={() => setEditing(editing === p.id ? null : p.id)}
          >
            <span className="mono min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text)' }}>{p.id}</span>
            <span className="mono shrink-0" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{p.baseURL ?? '（官方默认）'}</span>
            <span className="shrink-0 rounded-full px-2 py-0.5" style={{ fontSize: 'var(--ui-2xs)', border: '1px solid var(--border)', color: p.hasKey ? 'var(--ok)' : 'var(--text-4)' }}>
              {p.hasKey ? `key ${p.keyHint}` : '无 key'}
            </span>
            <span className="shrink-0" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{p.models.length} 模型</span>
          </button>
        ))}
        {providers.length === 0 && (
          <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>配置里没有自定义 provider——在原文编辑器里添加</p>
        )}
      </div>

      {editing && (
        <ProviderEditor
          provider={providers.find((p) => p.id === editing)!}
          summaryPath={summaryPath}
          raw={raw}
          onDone={() => { setEditing(null); onChanged() }}
        />
      )}
    </section>
  )
}

function ProviderEditor({ provider, summaryPath, raw, onDone }: {
  provider: ConfigSummary['providers'][number]
  summaryPath: string
  raw: string
  onDone: () => void
}) {
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '')
  const [apiKey, setApiKey] = useState('') // write-only
  const [models, setModels] = useState<Array<{ id: string; name?: string }>>(provider.models)
  const [pulled, setPulled] = useState<Array<{ id: string; name?: string }> | null>(null)
  const [pulling, setPulling] = useState(false)
  const [arm, setArm] = useState(false)
  const [error, setError] = useState('')

  // pull the provider's /models list (host-side fetch)
  const pull = async () => {
    setPulling(true)
    setError('')
    try {
      const r = await api.fetchModels(baseURL, apiKey || undefined) as { models?: Array<{ id: string; name?: string }>; error?: string }
      if ('error' in r && r.error) setError(r.error)
      else if ('models' in r) setPulled(r.models ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPulling(false)
    }
  }

  // merge pulled list with existing names, preserving selection
  const candidates = pulled ?? models
  const selectedIds = new Set(models.map((m) => m.id))
  const toggle = (m: { id: string; name?: string }) => {
    setModels((cur) => (cur.some((x) => x.id === m.id) ? cur.filter((x) => x.id !== m.id) : [...cur, m]))
  }

  const save = () => {
    if (!arm) { setArm(true); return }
    void api.patchProvider({
      providerId: provider.id,
      ...(baseURL !== (provider.baseURL ?? '') ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
      models,
    }).then((r) => {
      if ('error' in r && r.error) { setError(r.error); setArm(false); return }
      onDone()
    }).catch((e) => { setError((e as Error).message); setArm(false) })
  }

  return (
    <div className="mt-1 flex flex-col gap-3 rounded-[9px] p-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--accent-line)' }}>
      <Field label="baseURL" value={baseURL} onChange={setBaseURL} placeholder="https://api.example.com/v1" />
      <Field label={`API Key（${provider.hasKey ? `已配置 ${provider.keyHint}` : '未配置'} — write-only）`} value={apiKey} onChange={setApiKey} placeholder="留空 = 不改动" password />

      <div>
        <div className="flex items-center gap-2">
          <span className="label">模型（{models.length} 已选）</span>
          <button
            type="button"
            className="flex items-center gap-1 rounded-[6px] px-2 py-1"
            style={{ border: '1px solid var(--border)', fontSize: 'var(--ui-2xs)', color: 'var(--text-2)' }}
            disabled={pulling || !baseURL}
            onClick={() => void pull()}
          >
            <RefreshCw size={11} className={pulling ? 'animate-spin' : undefined} /> 从 {baseURL || 'provider'} 拉取模型列表
          </button>
        </div>
        <div className="mt-1.5 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
          {candidates.map((m) => {
            const on = selectedIds.has(m.id)
            return (
              <button
                key={m.id}
                type="button"
                className="rounded-full px-2.5 py-1"
                style={{
                  fontSize: 'var(--ui-2xs)',
                  border: `1px solid ${on ? 'var(--accent-line)' : 'var(--border)'}`,
                  background: on ? 'var(--accent-2)' : 'transparent',
                  color: on ? 'var(--text)' : 'var(--text-3)',
                }}
                onClick={() => toggle(m)}
              >
                {m.name || m.id}
              </button>
            )
          })}
          {candidates.length === 0 && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>（无 — 拉取或从原文编辑器添加）</span>}
        </div>
      </div>

      {error && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>}

      {/* RiskConfirmation: two-step write to the REAL config */}
      <div className="flex items-center justify-end gap-2">
        <span className="mono mr-auto" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }} title={summaryPath}>
          写入 {summaryPath}（自动备份 .ocrc-bak）· 现文件含 {countProviders(raw)} 个 provider
        </span>
        {arm && (
          <>
            <button type="button" className="demo-btn" onClick={() => setArm(false)}>取消</button>
            <button type="button" className="rounded-[9px] px-3 py-1.5" style={{ background: 'var(--err)', color: '#fff', fontSize: 'var(--ui-xs)' }} onClick={save}>
              确认写入配置文件
            </button>
          </>
        )}
        {!arm && (
          <button
            type="button"
            className="rounded-[9px] px-4 py-1.5"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
            onClick={() => setArm(true)}
          >
            保存
          </button>
        )}
      </div>
    </div>
  )
}

function countProviders(raw: string): number {
  try {
    const m = raw.match(/"provider"\s*:\s*\{/)
    if (!m) return 0
    return (raw.slice(m.index).match(/"\w+"\s*:\s*\{/g) ?? []).length
  } catch {
    return 0
  }
}

// ── 原文编辑器 ─────────────────────────────────────────────────────────────
function RawEditor({ raw, onChanged }: { raw: string; onChanged: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [arm, setArm] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const value = draft ?? raw

  const save = () => {
    void api.putConfig(value).then((r) => {
      if ('error' in r && r.error) { setError(r.error); setArm(false); return }
      setDraft(null)
      setArm(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      onChanged()
    }).catch((e) => { setError((e as Error).message); setArm(false) })
  }

  return (
    <section>
      <h2 className="label mb-2">原文（JSONC — 校验通过才写入，自动备份 .ocrc-bak）</h2>
      <textarea
        className="mono w-full rounded-[9px] p-3 outline-none"
        style={{ background: 'var(--bg-code)', border: `1px solid ${error ? 'var(--err)' : 'var(--border-2)'}`, color: 'var(--text)', fontSize: 'var(--ui-2xs)', minHeight: 260, resize: 'vertical' }}
        spellCheck={false}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
      />
      {error && <p className="mt-1" style={{ fontSize: 'var(--ui-xs)', color: 'var(--err)' }}>{error}</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        {draft !== null && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--warn)' }}>有未保存修改</span>}
        {saved && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--ok)' }}>已写入</span>}
        {arm && (
          <>
            <button type="button" className="demo-btn" onClick={() => { setArm(false); setDraft(raw) }}>取消</button>
            <button type="button" className="rounded-[9px] px-3 py-1.5" style={{ background: 'var(--err)', color: '#fff', fontSize: 'var(--ui-xs)' }} onClick={save}>
              确认写入配置文件
            </button>
          </>
        )}
        {!arm && (
          <button
            type="button"
            className="rounded-[9px] px-4 py-1.5 disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
            disabled={draft === null}
            onClick={() => setArm(true)}
          >
            保存原文
          </button>
        )}
      </div>
    </section>
  )
}

function Field({ label, value, onChange, placeholder, password }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean }) {
  return (
    <div>
      <span className="label">{label}</span>
      <input
        type={password ? 'password' : 'text'}
        className="mt-1 w-full rounded-[9px] px-2.5 py-1.5 outline-none"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
