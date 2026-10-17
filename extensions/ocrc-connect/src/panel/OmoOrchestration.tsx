import { useCallback, useEffect, useState } from 'react'
import { KitBadge, KitBanner, KitButton, KitField, KitSelect, KitSeparator, KitSpinner } from '../shared/kit.js'
import { call, post, type RequestFn } from '../shared/service-client.js'

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

/** Chain editor: an agent's per-preset override block as a readable row. */
function AgentChainRow(props: { agent: string; block: Record<string, unknown> }) {
  const { agent, block } = props
  const model = typeof block.model === 'string' ? block.model : Array.isArray(block.model) ? block.model.join(' → ') : '（继承）'
  const extras = Object.keys(block).filter((k) => k !== 'model')
  return (
    <div className="oc-row oc-row-nowrap oc-xs">
      <strong className="oc-mono" style={{ flex: '0 0 110px' }}>{agent}</strong>
      <span className="oc-sdk-muted oc-truncate oc-grow">
        {model}
        {extras.length > 0 && ` · ${extras.join(', ')}`}
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
  const [fbEnabled, setFbEnabled] = useState<'' | 'true' | 'false'>('') // '' = untouched
  const [fbMaxRetries, setFbMaxRetries] = useState('')
  const [fbRetryDelay, setFbRetryDelay] = useState('')
  const [fbPolicy, setFbPolicy] = useState<'' | 'retry-primary' | 'stick-to-fallback'>('')

  // escape hatch
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')

  const load = useCallback(async () => {
    setLoadErr(''); setErr(''); setMsg('')
    try {
      const s = await call<OmoSummary>(request, '/omo/config')
      setSummary(s)
      setPresetSel(s.activePreset ?? '')
      const fb = s.fallback
      setFbEnabled(typeof fb?.enabled === 'boolean' ? (fb.enabled ? 'true' : 'false') : '')
      setFbMaxRetries(typeof fb?.maxRetries === 'number' ? String(fb.maxRetries) : '')
      setFbRetryDelay(typeof fb?.retryDelayMs === 'number' ? String(fb.retryDelayMs) : '')
      setFbPolicy(fb?.continuationPolicy === 'retry-primary' || fb?.continuationPolicy === 'stick-to-fallback' ? fb.continuationPolicy : '')
      setRawText(s.parsed ? JSON.stringify(s.parsed, null, 2) : '')
    } catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  useEffect(() => { void load() }, [load])

  const structuredDirty = (() => {
    if (!summary) return false
    if (presetSel !== (summary.activePreset ?? '')) return true
    if (fbEnabled !== '' && (fbEnabled === 'true') !== (summary.fallback?.enabled ?? true)) return true
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
      if (fbEnabled !== '') fb.enabled = fbEnabled === 'true'
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
      <div className="oc-card">
        <div className="oc-row">
          <strong>omo 编排</strong>
          <span className="oc-push" />
          <KitButton label="重试" variant="outline" size="sm" onClick={() => void load()} />
        </div>
        <KitBanner tone="error" title="读取远端配置失败" body={loadErr} />
      </div>
    )
  }
  if (!summary) return <div className="oc-sdk-muted oc-sm">omo 编排：加载中…</div>

  const chains = summary.agentChains && typeof summary.agentChains === 'object'
    ? summary.agentChains as Record<string, Record<string, Record<string, unknown>>>
    : {}
  const activeChains = (presetSel && chains[presetSel]) || chains[summary.activePreset ?? ''] || undefined

  return (
    <div className="oc-card">
      <div className="oc-row">
        <strong>omo 编排</strong>
        {summary.exists
          ? <KitBadge label={`${summary.format}${summary.size != null ? ` · ${summary.size}B` : ''}`} tone="success" />
          : <KitBadge label="远端无配置" tone="error" />}
        {summary.commentsWillBeLost && <KitBadge label="注释将丢失" tone="warning" />}
        <span className="oc-push" />
        {busy && <KitSpinner size="sm" />}
        <KitButton label="刷新" variant="ghost" size="sm" onClick={() => void load()} />
        <KitButton label={rawMode ? '返回结构化' : '编辑原始 JSON'} variant="outline" size="sm" onClick={() => { setRawMode(!rawMode); setErr('') }} />
      </div>

      {msg && <KitBanner tone="success" title={msg} />}
      {err && <KitBanner tone="error" title="写入失败" body={err} />}
      {summary.parseError && (
        <KitBanner tone="error" title="远端配置解析失败" body={`${summary.parseError}——用「编辑原始 JSON」修复。`} />
      )}

      {!summary.exists && (
        <div className="oc-sdk-muted oc-xs">
          被控端还没有 <code>~/.config/opencode/oh-my-opencode-slim.json</code>。
          先在被控端跑一次 <code>oh-my-opencode-slim install</code>（或用远程工作区手工放置），再回来刷新。
        </div>
      )}

      {summary.exists && !rawMode && (
        <>
          <div className="oc-row">
            <div style={{ flex: '1 1 260px' }}>
              <KitSelect
                label="活跃预设"
                value={presetSel || null}
                options={[{ id: '', label: '（无——跟随会话模型）' }, ...summary.presetNames.map((n) => ({ id: n, label: n }))]}
                onChange={setPresetSel}
                disabled={busy}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KitSelect
                label="fallback"
                value={fbEnabled}
                options={[
                  { id: '', label: '（不动）' },
                  { id: 'true', label: '启用' },
                  { id: 'false', label: '停用' },
                ]}
                onChange={(id) => setFbEnabled(id as '' | 'true' | 'false')}
                disabled={busy}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KitSelect
                label="续接策略"
                value={fbPolicy}
                options={[
                  { id: '', label: '（不动）' },
                  { id: 'retry-primary', label: 'retry-primary（回主模型）' },
                  { id: 'stick-to-fallback', label: 'stick-to-fallback（钉住备选）' },
                ]}
                onChange={(id) => setFbPolicy(id as '' | 'retry-primary' | 'stick-to-fallback')}
                disabled={busy}
              />
            </div>
          </div>

          <div className="oc-row">
            <div style={{ flex: '0 0 140px' }}>
              <KitField
                label="maxRetries"
                value={fbMaxRetries}
                onChange={setFbMaxRetries}
                placeholder={String(FALLBACK_PLACEHOLDERS.maxRetries)}
                disabled={busy}
                mono
              />
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <KitField
                label="retryDelayMs"
                value={fbRetryDelay}
                onChange={setFbRetryDelay}
                placeholder={String(FALLBACK_PLACEHOLDERS.retryDelayMs)}
                disabled={busy}
                mono
              />
            </div>
            <span className="oc-push" />
            <KitButton label="应用结构化变更" size="sm" loading={busy} disabled={!structuredDirty} onClick={() => void writeStructured()} />
          </div>

          <div className="oc-sdk-muted oc-xs">
            空值 = 不修改该字段。官方默认：maxRetries {FALLBACK_PLACEHOLDERS.maxRetries} · retryDelayMs {FALLBACK_PLACEHOLDERS.retryDelayMs} · initialRetryDelayMs {FALLBACK_PLACEHOLDERS.initialRetryDelayMs} · retry-primary。
            写入后 v2 宿主 ~300ms 热重载，对新的编排子会话生效。
          </div>

          {activeChains && (
            <div className="oc-col">
              <KitSeparator label={`per-agent 模型链（${presetSel || summary.activePreset || ''}）`} />
              {Object.entries(activeChains).map(([agent, block]) => (
                <AgentChainRow key={agent} agent={agent} block={block && typeof block === 'object' ? block : {}} />
              ))}
              <div className="oc-sdk-muted oc-xs">只读视图——改链路请用「编辑原始 JSON」（presets.&lt;名称&gt;.&lt;agent&gt;.model，字符串或数组）。</div>
            </div>
          )}
        </>
      )}

      {summary.exists && rawMode && (
        <>
          <KitField
            value={rawText}
            onChange={setRawText}
            multiline
            rows={14}
            mono
            disabled={busy}
            helper="整体写回（服务端 JSON 校验，坏 JSON 拒绝且不落盘）。结构化控件覆盖不到的字段（agents/skills/disabled_mcps 等）都从这里走。"
          />
          <div className="oc-row">
            <KitButton label="校验并写回" size="sm" loading={busy} onClick={() => void writeRaw()} />
            <KitButton
              label="还原为远端当前"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => { setRawText(summary.parsed ? JSON.stringify(summary.parsed, null, 2) : ''); setErr('') }}
            />
          </div>
        </>
      )}
    </div>
  )
}
