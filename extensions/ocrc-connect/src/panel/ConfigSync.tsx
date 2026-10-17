import { useCallback, useEffect, useState } from 'react'
import type { TunnelStatus, SshProfile } from '../shared/protocol.js'
import { KitBadge, KitBanner, KitButton, KitEmpty, KitField } from '../shared/kit.js'
import { call, post, type RequestFn } from '../shared/service-client.js'
import { OmoOrchestration } from './OmoOrchestration.js'

/** 配置同步：面板宿主写的 agents / MCP / providers → 被控端的**项目级**配置。
 *
 * 2026-10-16 改判（D10）：写的是 `<项目目录>/opencode.jsonc`，不是
 * `~/.config/opencode/opencode.json`。后者是**用户级配置**——0.3.0 那版直接改它，
 * 既和引擎的优先级语义拧着（全局优先级最低），也可能被用户自己的 `opencode.jsonc`
 * 静默盖掉。项目级才是「优先级最高、且不碰用户的东西」的落点。
 *
 * 合并是粘性的（D11）：面板段逐叶覆盖，被控端独有键保留，面板没提供的密钥字段
 * 一律保留远端原值；字面量密钥在写盘前换成 `{env:…}` 引用，值本身不落文件。
 * 面板宿主的配置内容由**服务自己读**（服务就在面板宿主上），不过桥。 */

interface SourceReport {
  configPath: string
  exists: boolean
  sections: Partial<Record<string, string[]>>
  agentFiles: Array<{ name: string; path: string; size: number }>
  parseError?: string
}

interface ProjectConfigReport {
  targetPath: string
  format: 'jsonc' | 'json' | 'missing'
  exists: boolean
  parseError?: string
  commentsWillBeLost?: boolean
  sections?: Record<string, unknown>
}

interface ProjectWriteReport {
  targetPath: string
  changed: boolean
  applied?: boolean
  backup?: string | null
  commentsWillBeLost?: boolean
  parseError?: string
  secretsRewritten?: Array<{ path: string; env: string }>
  /** npx 形态的 MCP 被改写成目标机上已就位的本地入口（D13）。 */
  npxRewrites?: Array<{ capability: string; from: string; to: string }>
  mergedPreview?: string
  note?: string
}

export function ConfigSync(props: { request: RequestFn; status: TunnelStatus; profiles: SshProfile[] }) {
  const { request, status } = props
  const [source, setSource] = useState<SourceReport | null>(null)
  const [remote, setRemote] = useState<ProjectConfigReport | null>(null)
  const [preview, setPreview] = useState<ProjectWriteReport | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [projectPath, setProjectPath] = useState('')

  const activeProfile = props.profiles.find((p) => p.id === status.profileId)
  const boundProject = activeProfile?.projects?.[0]?.path ?? ''

  useEffect(() => { setProjectPath(boundProject) }, [boundProject])

  const loadSource = useCallback(async () => {
    setErr('')
    setPreview(null)
    try { setSource(await post<SourceReport>(request, '/config/source')) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  useEffect(() => { void loadSource() }, [loadSource])

  const loadRemote = useCallback(async () => {
    const path = projectPath.trim()
    if (!path) return
    setErr(''); setMsg(''); setPreview(null)
    try { setRemote(await call<ProjectConfigReport>(request, `/project-config?projectPath=${encodeURIComponent(path)}`)) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [projectPath, request])

  const write = useCallback(async (apply: boolean) => {
    const path = projectPath.trim()
    if (!path) return
    setErr(''); setMsg(''); setBusy(true)
    try {
      const r = await post<ProjectWriteReport>(request, '/project-config', { projectPath: path, fromPanel: true, ...(apply ? { apply: true } : {}) })
      setPreview(r)
      if (apply) {
        setMsg(r.note ?? (r.changed ? '已写入项目级配置' : '远端已是这个状态，没有写入'))
        await loadRemote()
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [loadRemote, projectPath, request])

  if (status.tunnel !== 'up') {
    return (
      <div className="oc-page">
        <KitEmpty title="需要先建立隧道" body="配置同步要把面板宿主的配置送到被控引擎——先在「连接」页连上档案。" />
      </div>
    )
  }

  const sectionNames = source ? Object.entries(source.sections) : []

  return (
    <div className="oc-page">
      <OmoOrchestration request={request} />

      <div className="oc-row">
        <strong>配置同步</strong>
        <KitBadge label={activeProfile?.name ?? status.profileId ?? ''} tone="primary" />
        <KitBadge label="写项目级" tone="info" />
        <span className="oc-push" />
        <KitButton label="刷新源清单" variant="ghost" size="sm" disabled={busy} onClick={() => void loadSource()} />
        <KitButton label="读远端现状" variant="outline" size="sm" disabled={busy || !projectPath.trim()} onClick={() => void loadRemote()} />
        <KitButton label="预览写入" variant="outline" size="sm" disabled={busy || !source?.exists || !projectPath.trim()} onClick={() => void write(false)} />
        <KitButton label="应用" size="sm" loading={busy} disabled={!preview?.changed} onClick={() => void write(true)} />
      </div>

      {msg && <KitBanner tone="success" title={msg} />}
      {err && <KitBanner tone="error" title="操作失败" body={err} />}

      <div className="oc-sdk-muted oc-xs">
        写入目标是被控端**项目目录**里的 <span className="oc-sdk-mono">opencode.jsonc</span>（优先级高于全局；存在 .jsonc 就写 .jsonc）。
        全局层只读不写——那是用户自己的配置。合并是粘性的：面板段覆盖同名项、被控端独有键保留、面板没提供的密钥字段一律保留远端原值；
        写盘前字面量密钥会换成 <span className="oc-sdk-mono">{'{env:…}'}</span> 引用，值本身不落文件。
      </div>

      <KitField
        label="被控机上的项目目录"
        value={projectPath}
        onChange={setProjectPath}
        placeholder="/home/demo/project"
        mono
        helper={boundProject ? '档案里绑定的工作目录（可在「连接」页改）。' : '档案还没绑定工作目录——先填一个再读远端现状。'}
      />

      {source && (
        <div className="oc-card">
          <div className="oc-row">
            <strong>面板宿主源</strong>
            <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate oc-grow" title={source.configPath}>
              {source.configPath}{source.exists ? '' : '（不存在）'}
            </span>
          </div>
          {source.parseError && <KitBanner tone="error" title="解析失败" body={source.parseError} />}
          {sectionNames.length === 0 && !source.parseError && (
            <div className="oc-sdk-muted oc-xs">没有可桥接的段（agent / mcp / providers）。</div>
          )}
          {sectionNames.map(([sec, names]) => (
            <div key={sec} className="oc-xs">
              <strong>{sec}</strong>：{names && names.length > 0 ? names.join(', ') : '（空）'}
            </div>
          ))}
          {source.agentFiles.length > 0 && (
            <div className="oc-xs">
              <strong>agents/*.md</strong>：{source.agentFiles.map((f) => `${f.name} (${f.size}B)`).join(', ')}
            </div>
          )}
        </div>
      )}

      {remote && (
        <div className="oc-card">
          <div className="oc-row">
            <strong>远端现状</strong>
            <KitBadge label={remote.exists ? remote.format : '尚不存在'} tone={remote.exists ? 'success' : 'neutral'} />
            <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate oc-grow" title={remote.targetPath}>{remote.targetPath}</span>
          </div>
          {remote.parseError && (
            <KitBanner tone="error" title="远端配置解析失败" body={`${remote.parseError}——面板不猜内容，先修好它再同步。`} />
          )}
          {remote.commentsWillBeLost && (
            <KitBanner tone="warning" title="写回会丢掉 .jsonc 里的注释" body="面板按 JSON 合并后整份写回，注释无法保留。" />
          )}
        </div>
      )}

      {preview && (
        <div className="oc-card">
          <div className="oc-row">
            <strong>预览</strong>
            <KitBadge label={preview.changed ? '有变更' : '无变更'} tone={preview.changed ? 'warning' : 'success'} />
            <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate oc-grow">→ {preview.targetPath}</span>
          </div>
          {preview.secretsRewritten && preview.secretsRewritten.length > 0 && (
            <div className="oc-xs">
              密钥改写：{preview.secretsRewritten.map((s) => `${s.path} → {env:${s.env}}`).join('；')}
            </div>
          )}
          {preview.npxRewrites && preview.npxRewrites.length > 0 && (
            <div className="oc-xs">
              npx 改写（目标机上已就位的运行时——运行期不再靠 npx 联网取件）：
              {preview.npxRewrites.map((r) => (
                <div key={r.capability} className="oc-sdk-mono oc-xs">
                  {r.capability}：{r.from} → {r.to}
                </div>
              ))}
            </div>
          )}
          {preview.backup && <div className="oc-sdk-muted oc-xs">旧件备份：{preview.backup}</div>}
          {preview.mergedPreview && <pre className="oc-pre">{preview.mergedPreview}</pre>}
        </div>
      )}
    </div>
  )
}
