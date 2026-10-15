import { useCallback, useEffect, useState } from 'react'
import type { TunnelStatus, SshProfile } from '../shared/protocol.js'
import type { RequestFn } from './service-client.js'
import { OmoOrchestration } from './OmoOrchestration.js'

/** Batch 5: the config-sync tab — panel-host config artifacts (agents/MCP/
 *  provider sections written by openchamber's own UI) carried to the remote
 *  engine over the ssh face. Read-only inventory → preview → apply. */

interface SourceReport {
  configPath: string
  exists: boolean
  sections: Partial<Record<string, string[]>>
  agentFiles: Array<{ name: string; path: string; size: number }>
  parseError?: string
}

interface PreviewResult {
  remotePath: string
  remoteExisted: boolean
  sectionsBridged: string[]
  agentFilesBridged: string[]
  changed: boolean
  mergedPreview?: string
}

async function post<T>(request: RequestFn, path: string, body?: unknown): Promise<T> {
  const r = await request(path, 'POST', body)
  const parsed = JSON.parse(r.body) as unknown
  if (r.status >= 400) throw new Error((parsed as { error?: string }).error ?? `HTTP ${r.status}`)
  return parsed as T
}

export function ConfigSync(props: { request: RequestFn; status: TunnelStatus; profiles: SshProfile[] }) {
  const { request, status } = props
  const [source, setSource] = useState<SourceReport | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const activeProfile = props.profiles.find((p) => p.id === status.profileId)

  const loadSource = useCallback(async () => {
    setErr('')
    setPreview(null)
    try { setSource(await post<SourceReport>(request, '/config/source')) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  useEffect(() => { void loadSource() }, [loadSource])

  const doPreview = useCallback(async () => {
    setErr(''); setBusy(true)
    try { setPreview(await post<PreviewResult>(request, '/config/preview', {})) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [request])

  const doApply = useCallback(async () => {
    setErr(''); setBusy(true)
    try {
      const r = await post<PreviewResult & { note?: string }>(request, '/config/apply', {})
      setPreview(r)
      setMsg(r.note ?? '已应用')
      setTimeout(() => setMsg(''), 6000)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [request])

  if (status.tunnel !== 'up') {
    return <div className="muted" style={{ padding: 12 }}>配置同步需要先建立隧道（连接页）。</div>
  }

  const sectionNames = source ? Object.entries(source.sections) : []

  return (
    <div style={{ display: 'grid', gap: 10, padding: 12 }}>
      <OmoOrchestration request={request} />
      <div className="row">
        <strong>配置同步</strong>
        <span className="pill ok">{activeProfile?.name ?? status.profileId}</span>
        <button onClick={() => void loadSource()}>刷新源清单</button>
        <button className="primary" disabled={busy || !source?.exists} onClick={() => void doPreview()}>预览</button>
        <button className="primary" disabled={busy || !preview?.changed} onClick={() => void doApply()}>应用</button>
      </div>
      {msg && <div className="muted" style={{ color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="muted" role="alert" style={{ color: 'var(--err)' }}>{err}</div>}

      <div className="muted" style={{ fontSize: 12 }}>
        把 openchamber 面板写的 agents / MCP / providers 配置带到被控引擎。
        合并规则：面板段覆盖同名项，被控端独有配置全部保留；应用前远端文件备份为 <code>*.ocrc-bak</code>。
        LLM 密钥不在同步范围（密钥由引擎凭据体系自持，用 Providers 页或 sync-auth 工具下发）。
      </div>

      {source && (
        <div style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: 8, display: 'grid', gap: 6, fontSize: 13 }}>
          <div className="row"><strong>面板宿主源</strong><span className="muted" style={{ fontSize: 12 }}>{source.configPath}{source.exists ? '' : '（不存在）'}</span></div>
          {source.parseError && <div style={{ color: 'var(--err)', fontSize: 12 }}>解析失败：{source.parseError}</div>}
          {sectionNames.length === 0 && !source.parseError && <div className="muted" style={{ fontSize: 12 }}>没有可桥接的段（agent / mcp / providers）。</div>}
          {sectionNames.map(([sec, names]) => (
            <div key={sec} style={{ fontSize: 12 }}>
              <strong>{sec}</strong>：{names && names.length > 0 ? names.join(', ') : '（空）'}
            </div>
          ))}
          {source.agentFiles.length > 0 && (
            <div style={{ fontSize: 12 }}>
              <strong>agents/*.md</strong>：{source.agentFiles.map((f) => `${f.name} (${f.size}B)`).join(', ')}
            </div>
          )}
        </div>
      )}

      {preview && (
        <div style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: 8, display: 'grid', gap: 6, fontSize: 12 }}>
          <div className="row">
            <strong>预览</strong>
            <span className={`pill ${preview.changed ? '' : 'ok'}`}>{preview.changed ? '有变更' : '无变更'}</span>
            <span className="muted">→ {preview.remotePath}</span>
          </div>
          <div>桥接段：{preview.sectionsBridged.join(', ') || '—'}</div>
          {preview.agentFilesBridged.length > 0 && <div>agent 文件：{preview.agentFilesBridged.join(', ')}</div>}
          {preview.mergedPreview && <pre style={{ maxHeight: 180, overflow: 'auto', fontSize: 11, background: 'var(--bg-elev2)', padding: 8, borderRadius: 8 }}>{preview.mergedPreview}</pre>}
        </div>
      )}
    </div>
  )
}
