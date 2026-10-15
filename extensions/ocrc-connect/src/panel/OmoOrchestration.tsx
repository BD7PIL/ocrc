import { useCallback, useEffect, useState } from 'react'
import type { RequestFn } from './service-client.js'

/** Batch 5.1: the omo orchestration block inside the config-sync tab.
 *  Structured knobs (active preset / fallback) + read-only agent-chain tree
 *  + a raw-JSON escape hatch. Every write goes through POST /omo/config —
 *  the service validates, backs up (.ocrc-bak) and writes atomically; the
 *  remote engine hot-reloads within ~300ms (v2 fs.watch, inference fields
 *  apply to NEW orchestration child sessions). */

interface OmoSummary {
  exists: boolean
  format: 'json' | 'jsonc' | 'missing'
  size?: number
  activePreset?: string
  presetNames: string[]
  fallback?: Record<string, unknown>
  agentChains?: Record<string, unknown>
  parsed?: Record<string, unknown>
  parseError?: string
  commentsWillBeLost?: boolean
}

interface WriteResult {
  ok: boolean
  target: string
  backup: string | null
  commentsWillBeLost?: boolean
  note: string
}

const FALLBACK_PLACEHOLDERS = { maxRetries: 3, initialRetryDelayMs: 0, retryDelayMs: 500 } as const

async function post<T>(request: RequestFn, path: string, body?: unknown): Promise<T> {
  const r = await request(path, 'POST', body)
  const parsed = JSON.parse(r.body) as unknown
  if (r.status >= 400) throw new Error((parsed as { error?: string }).error ?? `HTTP ${r.status}`)
  return parsed as T
}

async function get<T>(request: RequestFn, path: string): Promise<T> {
  const r = await request(path, 'GET')
  const parsed = JSON.parse(r.body) as unknown
  if (r.status >= 400) throw new Error((parsed as { error?: string }).error ?? `HTTP ${r.status}`)
  return parsed as T
}

/** Chain editor: an agent's per-preset override block as a readable row. */
function AgentChainRow(props: { agent: string; block: Record<string, unknown> }) {
  const { agent, block } = props
  const model = typeof block.model === 'string' ? block.model : Array.isArray(block.model) ? block.model.join(' → ') : '（继承）'
  const extras = Object.keys(block).filter((k) => k !== 'model')
  return (
    <div style={{ fontSize: 12, display: 'grid', gridTemplateColumns: '110px 1fr', gap: 4 }}>
      <strong>{agent}</strong>
      <span className="muted">
        {model}
        {extras.length > 0 && ` · ${extras.map((k) => k).join(', ')}`}
      </span>
    </div>
  )
}

export function OmoOrchestration(props: { request: RequestFn }) {
  const { request } = props
  const [summary, setSummary] = useState<OmoSummary | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // structured-edit state
  const [presetSel, setPresetSel] = useState<string>('')
  const [fbEnabled, setFbEnabled] = useState<boolean | null>(null) // null = untouched
  const [fbMaxRetries, setFbMaxRetries] = useState('')
  const [fbRetryDelay, setFbRetryDelay] = useState('')
  const [fbPolicy, setFbPolicy] = useState<'' | 'retry-primary' | 'stick-to-fallback'>('')

  // escape hatch
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')

  const load = useCallback(async () => {
    setLoadErr(''); setErr(''); setMsg('')
    try {
      const s = await get<OmoSummary>(request, '/omo/config?scope=user')
      setSummary(s)
      setPresetSel(s.activePreset ?? '')
      const fb = s.fallback
      setFbEnabled(fb && typeof fb.enabled === 'boolean' ? fb.enabled : null)
      setFbMaxRetries(fb && typeof fb.maxRetries === 'number' ? String(fb.maxRetries) : '')
      setFbRetryDelay(fb && typeof fb.retryDelayMs === 'number' ? String(fb.retryDelayMs) : '')
      setFbPolicy(fb?.continuationPolicy === 'retry-primary' || fb?.continuationPolicy === 'stick-to-fallback' ? fb.continuationPolicy : '')
      setRawText(s.parsed ? JSON.stringify(s.parsed, null, 2) : '')
    } catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  useEffect(() => { void load() }, [load])

  const structuredDirty = (() => {
    if (!summary) return false
    if (presetSel !== (summary.activePreset ?? '')) return true
    if (fbEnabled !== null && fbEnabled !== (summary.fallback?.enabled ?? true)) return true
    if (fbMaxRetries !== '' && Number(fbMaxRetries) !== (typeof summary.fallback?.maxRetries === 'number' ? summary.fallback.maxRetries : FALLBACK_PLACEHOLDERS.maxRetries)) return true
    if (fbRetryDelay !== '' && Number(fbRetryDelay) !== (typeof summary.fallback?.retryDelayMs === 'number' ? summary.fallback.retryDelayMs : FALLBACK_PLACEHOLDERS.retryDelayMs)) return true
    if (fbPolicy !== '' && fbPolicy !== (summary.fallback?.continuationPolicy ?? 'retry-primary')) return true
    return false
  })()

  const writeStructured = useCallback(async () => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      const body: Record<string, unknown> = {}
      if (presetSel !== (summary?.activePreset ?? '')) body.preset = presetSel === '' ? null : presetSel
      const fb: Record<string, unknown> = {}
      if (fbEnabled !== null) fb.enabled = fbEnabled
      if (fbMaxRetries !== '') fb.maxRetries = Number(fbMaxRetries)
      if (fbRetryDelay !== '') fb.retryDelayMs = Number(fbRetryDelay)
      if (fbPolicy !== '') fb.continuationPolicy = fbPolicy
      const current = summary?.fallback ?? {}
      const fbChanged = Object.entries(fb).some(([k, v]) => (current as Record<string, unknown>)[k] !== v)
      if (fbChanged) body.fallback = fb
      if (Object.keys(body).length === 0) { setMsg('没有变更'); setBusy(false); return }
      if (body.preset && summary && !summary.presetNames.includes(body.preset as string)) {
        setErr(`预设 '${String(body.preset)}' 不在当前配置里`)
        setBusy(false); return
      }
      const r = await post<WriteResult>(request, '/omo/config', body)
      setMsg(r.note + (r.backup ? `（备份 ${r.backup}）` : ''))
      setTimeout(() => setMsg(''), 8000)
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [request, summary, presetSel, fbEnabled, fbMaxRetries, fbRetryDelay, fbPolicy, load])

  const writeRaw = useCallback(async () => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      JSON.parse(rawText) // UI-side pre-check; the service re-validates (422)
      const r = await post<WriteResult>(request, '/omo/config', { content: rawText })
      setMsg(r.note + (r.backup ? `（备份 ${r.backup}）` : ''))
      setTimeout(() => setMsg(''), 8000)
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [request, rawText, load])

  if (loadErr) {
    return (
      <div style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
        <div className="row"><strong>omo 编排</strong><button onClick={() => void load()}>重试</button></div>
        <div className="muted" role="alert" style={{ color: 'var(--err)', fontSize: 12 }}>{loadErr}</div>
      </div>
    )
  }
  if (!summary) return <div className="muted" style={{ fontSize: 12 }}>omo 编排：加载中…</div>

  const chains = summary.agentChains && typeof summary.agentChains === 'object'
    ? summary.agentChains as Record<string, Record<string, Record<string, unknown>>>
    : {}
  const activeChains = (presetSel && chains[presetSel]) || chains[summary.activePreset ?? ''] || undefined

  return (
    <div style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: 8, display: 'grid', gap: 8 }}>
      <div className="row">
        <strong>omo 编排</strong>
        {summary.exists
          ? <span className="pill ok">{summary.format}{summary.size != null ? ` · ${summary.size}B` : ''}</span>
          : <span className="pill err">远端无配置</span>}
        {summary.commentsWillBeLost && <span className="pill" title="写入会保留 .jsonc 扩展名，但注释无法保留">注释将丢失</span>}
        <button onClick={() => void load()}>刷新</button>
        <button onClick={() => { setRawMode(!rawMode); setErr('') }}>{rawMode ? '返回结构化' : '编辑原始 JSON'}</button>
      </div>
      {msg && <div className="muted" style={{ color: 'var(--ok)', fontSize: 12 }}>{msg}</div>}
      {err && <div className="muted" role="alert" style={{ color: 'var(--err)', fontSize: 12 }}>{err}</div>}
      {summary.parseError && <div style={{ color: 'var(--err)', fontSize: 12 }}>远端配置解析失败：{summary.parseError}——用「编辑原始 JSON」修复。</div>}

      {!summary.exists && (
        <div className="muted" style={{ fontSize: 12 }}>
          被控端还没有 <code>~/.config/opencode/oh-my-opencode-slim.json</code>。
          先在被控端跑一次 <code>oh-my-opencode-slim install</code>（或用远程工作区手工放置），再回来刷新。
        </div>
      )}

      {summary.exists && !rawMode && (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label style={{ fontSize: 12 }}>
              活跃预设{' '}
              <select value={presetSel} onChange={(e) => setPresetSel(e.target.value)} disabled={busy}>
                <option value="">（无——跟随会话模型）</option>
                {summary.presetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
            <label>
              fallback{' '}
              <select value={fbEnabled === null ? '' : String(fbEnabled)} onChange={(e) => setFbEnabled(e.target.value === '' ? null : e.target.value === 'true')} disabled={busy}>
                <option value="">（不动）</option>
                <option value="true">启用</option>
                <option value="false">停用</option>
              </select>
            </label>
            <label>
              maxRetries{' '}
              <input style={{ width: 64 }} type="number" min={0} placeholder={String(FALLBACK_PLACEHOLDERS.maxRetries)} value={fbMaxRetries} onChange={(e) => setFbMaxRetries(e.target.value)} disabled={busy} />
            </label>
            <label>
              retryDelayMs{' '}
              <input style={{ width: 72 }} type="number" min={0} placeholder={String(FALLBACK_PLACEHOLDERS.retryDelayMs)} value={fbRetryDelay} onChange={(e) => setFbRetryDelay(e.target.value)} disabled={busy} />
            </label>
            <label>
              续接策略{' '}
              <select value={fbPolicy} onChange={(e) => setFbPolicy(e.target.value as '' | 'retry-primary' | 'stick-to-fallback')} disabled={busy}>
                <option value="">（不动）</option>
                <option value="retry-primary">retry-primary（回主模型）</option>
                <option value="stick-to-fallback">stick-to-fallback（钉住备选）</option>
              </select>
            </label>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            空值 = 不修改该字段。官方默认：maxRetries {FALLBACK_PLACEHOLDERS.maxRetries} · retryDelayMs {FALLBACK_PLACEHOLDERS.retryDelayMs} · initialRetryDelayMs {FALLBACK_PLACEHOLDERS.initialRetryDelayMs} · retry-primary。
            写入后 v2 宿主 ~300ms 热重载，对新的编排子会话生效。
          </div>
          <div className="row">
            <button className="primary" disabled={busy || !structuredDirty} onClick={() => void writeStructured()}>应用结构化变更</button>
          </div>

          {activeChains && (
            <div style={{ display: 'grid', gap: 4 }}>
              <strong style={{ fontSize: 12 }}>per-agent 模型链（{presetSel || summary.activePreset || ''}）</strong>
              {Object.entries(activeChains).map(([agent, block]) => (
                <AgentChainRow key={agent} agent={agent} block={block && typeof block === 'object' ? block : {}} />
              ))}
              <div className="muted" style={{ fontSize: 11 }}>只读视图——改链路请用「编辑原始 JSON」（presets.&lt;名称&gt;.&lt;agent&gt;.model，字符串或数组）。</div>
            </div>
          )}
        </>
      )}

      {summary.exists && rawMode && (
        <>
          <textarea
            style={{ minHeight: 260, fontFamily: 'monospace', fontSize: 12 }}
            value={rawText}
            spellCheck={false}
            onChange={(e) => setRawText(e.target.value)}
            disabled={busy}
          />
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void writeRaw()}>校验并写回</button>
            <button disabled={busy} onClick={() => { setRawText(summary.parsed ? JSON.stringify(summary.parsed, null, 2) : ''); setErr('') }}>还原为远端当前</button>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            整体写回（服务端 JSON 校验，坏 JSON 拒绝且不落盘）。结构化控件覆盖不到的字段（agents/skills/disabled_mcps 等）都从这里走。
          </div>
        </>
      )}
    </div>
  )
}
