import { useCallback, useEffect, useState } from 'react'
import { RiDownloadCloudLine, RiServerLine, RiSubtractLine } from '@remixicon/react'
import type { HostClient } from '@openchamber/sdk'
import { applyPortChanges, type CapabilityReport, type DetectReport, type PortChange, type ProvisionPlan, type ReadinessReport, type RuntimePlanItem } from '../shared/provision.js'
import type { SshProfile, TunnelStatus } from '../shared/protocol.js'
import { KitBadge, KitBanner, KitButton, KitField, KitList, KitSeparator, KitSpinner } from '../shared/kit.js'
import { post, type RequestFn } from '../shared/service-client.js'
import { buildHostChip, collectHostFacts, describeStartResult } from './commands.js'

/** 主机视图——「只要有 ssh，就一定有相应的能力」（PRODUCT 第零点九条）。
 *
 * 面板与扩展过去只会开隧道：被控端没有引擎时，这里什么也做不了。这一块就是补上
 * 那条链：**四档就绪如实报告 → 引擎预演 → 一次确认 → 部署 → 能力清单**。
 * 所有会往被控端写东西的动作都要求一次显式确认（D3），并且预演里显示的就是将要
 * 执行的那个工件（包名、版本、取件方式、大小、为什么）。
 *
 * 末端再接一步「交给模型」：现状 → chip → 新会话/当前对话。openchamber 不给扩展
 * 项目与传输 API（面板入口的硬边界，见 panel-provisioning-verdict §七），所以
 * 「在此项目上新建会话」只在那个目录**已经是 openchamber 的项目**时成立；不是就
 * 如实说，并把 chip 贴进当前对话——不假装成功。
 */

interface InspectResponse {
  detect: DetectReport
  readiness: ReadinessReport
  anchor?: string
  anchorSource: string
}

interface PlanResponse {
  plan: ProvisionPlan
  artifact: { package: string; version: string; integrity: string; tarballUrl: string; unpackedBytes?: number }
}

/** `/capabilities` 的应答形状来自 shared（命令与主机视图共用同一份类型）。 */
type CapabilitiesResponse = CapabilityReport

function bytes(value?: number): string {
  if (!value) return ''
  return `${(value / 1024 / 1024).toFixed(0)} MB`
}

/** 目录比较只吞尾斜杠——远端路径大小写敏感，不做任何「聪明」的归一化。 */
const sameDir = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

export function HostView(props: { request: RequestFn; status: TunnelStatus; profiles: SshProfile[]; host: HostClient | null }) {
  const { request, status, host } = props
  const active = props.profiles.find((p) => p.id === status.profileId) ?? null

  const [inspect, setInspect] = useState<InspectResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [planned, setPlanned] = useState<PlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null)
  const [projectDraft, setProjectDraft] = useState('')
  const [runtimePlan, setRuntimePlan] = useState<RuntimePlanItem | null>(null)
  const [portChanges, setPortChanges] = useState<PortChange[]>([])

  const projectPath = active?.projects?.[0]?.path ?? ''

  useEffect(() => { setProjectDraft(projectPath) }, [projectPath])

  const refresh = useCallback(async () => {
    if (status.tunnel !== 'up') { setInspect(null); return }
    setLoading(true)
    setErr('')
    try {
      setInspect(await post<InspectResponse>(request, '/detect'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [request, status.tunnel])

  useEffect(() => { void refresh() }, [refresh])

  const doPlan = useCallback(async () => {
    if (!inspect) return
    setBusy(true); setErr(''); setMsg('')
    try {
      setPlanned(await post<PlanResponse>(request, '/provision/plan', { detect: inspect.detect }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [inspect, request])

  const doPrefetch = useCallback(async () => {
    if (!planned) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await post<{ path: string }>(request, '/provision/prefetch', { artifact: planned.artifact })
      setMsg(`工件已缓存到面板宿主：${r.path}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [planned, request])

  const doApply = useCallback(async () => {
    if (!planned) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const outcome = await post<{ ok: boolean; version?: string; backup?: string; error?: string; got?: string }>(
        request, '/provision/apply', { plan: planned.plan, artifact: planned.artifact, confirm: true },
      )
      setMsg(outcome.ok
        ? `引擎已就位${outcome.version ? `：${outcome.version}` : ''}${outcome.backup ? `（旧件备份 ${outcome.backup}）` : ''}`
        : (outcome.error ?? '部署失败'))
      setPlanned(null)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [planned, refresh, request])

  const loadCapabilities = useCallback(async () => {
    if (!projectDraft.trim()) return
    setBusy(true); setErr(''); setMsg('')
    try {
      setCaps(await post<CapabilitiesResponse>(request, '/capabilities', { projectPath: projectDraft.trim() }))
      setPortChanges([])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [projectDraft, request])

  /** 运行时安装：预演里那一项原样执行（D3：一次显式确认）。 */
  const applyRuntime = useCallback(async () => {
    if (!runtimePlan) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const outcome = await post<{ ok: boolean; entry?: string; version?: string; skipped?: boolean; backup?: string; error?: string }>(
        request, '/runtime/apply', { item: runtimePlan, confirm: true },
      )
      setRuntimePlan(null)
      // 先重新盘点再报结果：盘点自己会清消息，反过来写就会被它擦掉。
      await loadCapabilities()
      setMsg(outcome.ok
        ? `${outcome.skipped ? '目标机上已经是这个 spec——幂等短路，没有写任何东西' : '运行时已就位'}${outcome.entry ? `：${outcome.entry}` : ''}${outcome.version ? `（${outcome.version}）` : ''}`
        : (outcome.error ?? '安装失败'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [loadCapabilities, request, runtimePlan])

  const applyForwards = useCallback(async () => {
    if (!caps) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await post<{ forwards: unknown[]; portChanges?: PortChange[] }>(request, '/forwards', {
        forwards: caps.forwards.map((f) => ({ ...f, activePort: f.port })),
      })
      const changes = r.portChanges ?? []
      setPortChanges(changes)
      setMsg(`已挂上 ${r.forwards.length} 条转发——与主隧道同一个 ssh 进程，断开一起断${changes.length > 0 ? `；${changes.map((c) => `${c.reason} 的 ${c.from} 被占用，改用 ${c.to}`).join('；')}` : ''}`)
      setCaps(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [caps, request])

  /** 现状 → chip → 会话。目标目录已经是 openchamber 的项目就建会话；不是就把 chip
   *  贴进当前对话（没有创建项目的 API，所以不兜底造一个假的项目）。 */
  const handOff = useCallback(async (mode: 'session' | 'composer') => {
    if (!host) return
    const dir = projectDraft.trim()
    if (!dir.startsWith('/')) { setErr('先在档案里绑定一个被控机上的绝对路径'); return }
    setBusy(true); setErr(''); setMsg('')
    try {
      const chip = buildHostChip(await collectHostFacts(request, '', { projectPath: dir }), 'status')
      if (mode === 'composer') {
        await host.attach(chip)
        setMsg('现状已作为 chip 贴到当前对话的输入框——确认无误后发送。')
        return
      }
      const snapshot = await host.listProjects()
      const project = snapshot.projects.find((p) => sameDir(p.directory, dir))
      if (!project) {
        await host.attach(chip)
        setMsg(`被控机上的 ${dir} 还不是 openchamber 的项目——扩展没有创建项目的 API，所以没有替你新建目录。已把现状贴成当前对话的 chip；等该目录成为项目后，这个按钮就会直接建会话。`)
        return
      }
      setMsg(describeStartResult(await host.startSession({ ...chip, projectId: project.id, navigation: 'open' }), project.name))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [host, projectDraft, request])

  if (status.tunnel !== 'up') {
    return (
      <div className="oc-sdk-muted oc-sm">
        主机视图在隧道建立后可用——四档就绪、引擎部署与能力补齐都需要一条活的 ssh。
      </div>
    )
  }

  const detect = inspect?.detect
  const drift = Boolean(detect?.engine?.version && inspect?.anchor && detect.engine.version !== inspect.anchor)

  return (
    <div className="oc-card">
      <div className="oc-row">
        <RiServerLine size={16} className="oc-icon" />
        <strong>主机视图</strong>
        {active && <KitBadge label={active.name} tone="primary" />}
        {inspect?.anchor && <KitBadge label={`锚点 ${inspect.anchor}`} tone="neutral" />}
        <span className="oc-push" />
        {loading && <KitSpinner size="sm" />}
        <KitButton label="重新探测" variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()} />
      </div>

      {err && <KitBanner tone="error" title="操作失败" body={err} />}
      {msg && <KitBanner tone="success" title={msg} />}

      {detect && (
        <>
          <div className="oc-sdk-muted oc-xs">
            {detect.os} · {detect.kernel} · glibc {detect.glibc ?? '未知'} · {detect.container && detect.container !== 'none' ? `容器（${detect.container}）` : '物理机/VM'}
            {detect.baseline ? ' · 无 AVX2 → 需要 baseline 构建' : ''}
            {detect.outbound === true ? ' · 可出网' : detect.outbound === false ? ' · 不出网（走面板推送）' : ' · 出网未知'}
          </div>

          <KitList
            items={(inspect?.readiness.steps ?? []).map((step) => ({
              id: step.id,
              title: step.label,
              subtitle: step.ok ? step.detail : `${step.detail}　→ ${step.action ?? ''}`,
              badge: { label: step.ok ? '就绪' : '待办', tone: step.ok ? 'success' as const : 'warning' as const },
            }))}
            onSelect={() => { /* 只读清单 */ }}
          />

          {(detect.engine || detect.legacyEngine) && (
            <div className="oc-sdk-mono oc-sdk-muted oc-xs">
              {detect.engine ? `~/.opencode/bin/opencode → ${detect.engine.version}` : '~/.opencode/bin 未部署'}
              {detect.legacyEngine ? `　·　用户既有安装 ${detect.legacyEngine.version || '（版本未知）'} @ ${detect.legacyEngine.path}（不动它）` : ''}
            </div>
          )}

          {drift && (
            <KitBanner
              tone="warning"
              title={`版本漂移：在位 ${detect.engine?.version} ≠ 面板宿主 ${inspect?.anchor}`}
              body="按镜像策略，被控端跟面板宿主走（不 follow latest）。升级是提示后一键动作。"
            />
          )}
          {detect.unsupportedReason && <KitBanner tone="error" title="目标机不在官方支持矩阵内" body={detect.unsupportedReason} />}

          <div className="oc-row">
            <KitButton
              label={planned ? '重新预演' : '部署引擎'}
              variant="outline"
              size="sm"
              disabled={busy || Boolean(detect.unsupportedReason)}
              onClick={() => void doPlan()}
            />
            {detect.outbound === false && (
              <KitButton label="下载工件到面板" variant="ghost" size="sm" disabled={busy} onClick={() => void doPrefetch()} />
            )}
          </div>
        </>
      )}

      {planned && (
        <div className="oc-card" style={{ borderColor: 'var(--primary, #fb8b3c)' }}>
          <div className="oc-row">
            <strong>将要执行</strong>
            <KitBadge
              label={planned.plan.action === 'none' ? '无需动作' : planned.plan.action === 'install' ? '安装' : planned.plan.action === 'upgrade' ? '升级' : planned.plan.action === 'downgrade' ? '降级' : '重装'}
              tone={planned.plan.action === 'none' ? 'success' : 'warning'}
            />
            <KitBadge label={planned.plan.source === 'remote' ? '被控端直取' : '面板推送'} tone="info" />
            {planned.artifact.unpackedBytes ? <KitBadge label={bytes(planned.artifact.unpackedBytes)} tone="neutral" /> : null}
          </div>
          <div className="oc-sdk-mono oc-xs">{planned.plan.package}@{planned.plan.version} → {planned.plan.installDir}</div>
          <div className="oc-sdk-muted oc-xs">{planned.plan.reason}</div>
          <div className="oc-sdk-muted oc-xs">
            校验：sha512 {planned.plan.integrity.slice(0, 24)}…（两条取件路同一套校验）；失败不动旧件，推送前旧件备份 .ocrc-bak。
          </div>
          <div className="oc-row">
            <KitButton label="确认部署" size="sm" loading={busy} disabled={planned.plan.action === 'none'} onClick={() => void doApply()} />
            <KitButton label="取消" variant="ghost" size="sm" disabled={busy} onClick={() => setPlanned(null)} />
          </div>
        </div>
      )}

      <KitSeparator label="项目与能力" />

      <div className="oc-row">
        <div className="oc-grow">
          <KitField
            label="被控机上的工作目录"
            value={projectDraft}
            onChange={setProjectDraft}
            placeholder="/home/demo/project"
            mono
            helper="项目级配置写在这里（opencode.jsonc，优先级高于全局）——凭据与用户级配置不落此处。"
          />
        </div>
        <KitButton label="盘点能力" variant="outline" size="sm" disabled={busy || !projectDraft.trim()} onClick={() => void loadCapabilities()} />
      </div>

      <div className="oc-card">
        <div className="oc-row">
          <strong>交给模型</strong>
          <KitBadge label="chip + 会话" tone="neutral" />
        </div>
        <div className="oc-sdk-muted oc-xs">
          把上面这份现状（四档就绪 · 引擎 · 能力缺口）打包成一个 chip 交给模型；composer 里敲{' '}
          <span className="oc-sdk-mono">/ocrc-host</span>（现状）或 <span className="oc-sdk-mono">/ocrc-plan</span>（待办）是同一个动作。
        </div>
        <div className="oc-row">
          <KitButton
            label="在此项目上新建会话"
            size="sm"
            loading={busy}
            disabled={!host || busy || !projectDraft.trim()}
            onClick={() => void handOff('session')}
          />
          <KitButton
            label="贴到当前对话"
            variant="outline"
            size="sm"
            disabled={!host || busy || !projectDraft.trim()}
            onClick={() => void handOff('composer')}
          />
        </div>
      </div>

      {caps && (
        <>
          <div className="oc-sdk-muted oc-xs">
            引擎读的是 <span className="oc-sdk-mono">{caps.config.targetPath}</span>
            （{caps.config.exists ? caps.config.format : '尚不存在'}）{caps.config.parseError ? `——解析失败：${caps.config.parseError}` : ''}
          </div>
          {caps.capabilities.length === 0 && <div className="oc-sdk-muted oc-xs">这份配置里没有可盘点的 MCP 能力。</div>}
          <KitList
            items={caps.capabilities.map((c) => ({
              id: c.id,
              title: c.label,
              leading: c.where === 'remote' ? '远端' : '面板',
              subtitle: [
                c.needs.runtime?.length ? `运行时：${c.needs.runtime.join(', ')}` : '',
                c.needs.network?.length ? `网络：${c.needs.network.join(', ')}` : '',
                c.needs.secrets?.length ? `密钥：${c.needs.secrets.join(', ')}` : '',
              ].filter(Boolean).join('　·　') || '无额外需求',
            }))}
            onSelect={() => { /* 只读清单 */ }}
          />
          {caps.forwards.length > 0 && (
            <div className="oc-card">
              <div className="oc-row">
                <strong>需要补 {caps.forwards.length} 条转发</strong>
                <KitBadge label="与主隧道共生" tone="info" />
              </div>
              {caps.forwards.map((f) => (
                <div key={`${f.peerHost}:${f.peerPort}`} className="oc-sdk-mono oc-xs">
                  {f.direction === 'local' ? '-L' : '-R'} 127.0.0.1:{f.port} → {f.peerHost}:{f.peerPort}　({f.reason})
                </div>
              ))}
              {applyPortChanges(caps.rewrites, portChanges).map((r) => (
                <div key={r.from} className="oc-sdk-mono oc-xs">
                  改写：{r.from} → {r.to}
                  {portChanges.some((c) => r.to.includes(`:${c.to}/`) || r.to.endsWith(`:${c.to}`)) ? '（端口被占用，这是换过之后的实际端口）' : ''}
                </div>
              ))}
              <div className="oc-row">
                <KitButton label="挂上这些转发" size="sm" loading={busy} onClick={() => void applyForwards()} />
                <KitButton label="取消" variant="ghost" size="sm" disabled={busy} onClick={() => setCaps(null)} />
              </div>
            </div>
          )}

          {caps.runtime && caps.runtime.items.length > 0 && (
            <div className="oc-card">
              <div className="oc-row">
                <strong>运行时</strong>
                <KitBadge
                  label={caps.runtime.node ? `node ${caps.runtime.node}` : '没有 node'}
                  tone={caps.runtime.nodeOk ? 'success' : 'error'}
                />
                <KitBadge
                  label={caps.runtime.npm ? `npm ${caps.runtime.npm}` : '没有 npm'}
                  tone={caps.runtime.npm ? 'success' : 'error'}
                />
                <span className="oc-sdk-muted oc-xs">落点 {caps.runtime.root}</span>
              </div>
              {caps.runtime.items.map((item) => (
                <div key={item.need.raw} className="oc-card">
                  <div className="oc-row">
                    <span className="oc-sdk-mono oc-xs">{item.need.raw}</span>
                    <KitBadge
                      label={item.action === 'present' ? '已就位' : item.action === 'install' ? '待安装' : '装不了'}
                      tone={item.action === 'present' ? 'success' : item.action === 'install' ? 'warning' : 'error'}
                    />
                    <span className="oc-sdk-muted oc-xs">供 {item.neededBy.join('、')} 使用</span>
                    <span className="oc-push" />
                    {item.action === 'install' && (
                      <KitButton label="安装这一项" size="sm" disabled={busy} onClick={() => setRuntimePlan(item)} />
                    )}
                  </div>
                  {item.action === 'present' && item.found && (
                    <div className="oc-sdk-mono oc-xs">
                      {item.found.path}{item.found.version ? `（${item.found.version}）` : ''}
                      {item.reason ? `　·　${item.reason}` : ''}
                    </div>
                  )}
                  {item.action === 'install' && (
                    <div className="oc-sdk-mono oc-xs">
                      将在被控端跑：npm install {item.package}{item.version ? `@${item.version}` : ''} → {item.dir}
                    </div>
                  )}
                  {item.action === 'impossible' && (
                    <div className="oc-sdk-muted oc-xs">为什么不做：{item.reason}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {runtimePlan && (
            <div className="oc-card" style={{ borderColor: 'var(--primary, #fb8b3c)' }}>
              <div className="oc-row">
                <strong>将要执行</strong>
                <KitBadge label="一次确认" tone="warning" />
                <KitBadge label="在被控端跑 npm" tone="info" />
              </div>
              <div className="oc-sdk-mono oc-xs">
                npm install {runtimePlan.package}{runtimePlan.version ? `@${runtimePlan.version}` : '@latest'} --prefix {runtimePlan.dir}
              </div>
              <div className="oc-sdk-muted oc-xs">
                入口装完后从**包自己的** bin 解析（写进配置的是真实路径，运行期不再走 npx 联网）。
                幂等：同 spec 且入口还在就一个字都不写；旧 marker 备份 .ocrc-bak；目录里若有非 ocrc 装的东西，压根不会走到这一步。
              </div>
              <div className="oc-row">
                <KitButton label="确认安装" size="sm" loading={busy} onClick={() => void applyRuntime()} />
                <KitButton label="取消安装" variant="ghost" size="sm" disabled={busy} onClick={() => setRuntimePlan(null)} />
              </div>
            </div>
          )}

          {caps.notes.length > 0 && (
            <div className="oc-sdk-muted oc-xs">{caps.notes.map((n) => <div key={n}>{n}</div>)}</div>
          )}
        </>
      )}

      <div className="oc-sdk-muted oc-xs">
        <span className="oc-icon"><RiSubtractLine size={12} /></span> 探测全自动；安装与写配置各需一次显式确认（可勾「此主机不再询问」）。
        传输凭据（SSH 私钥/密码、TG bot token）永不离开面板宿主。
      </div>
      <div className="oc-sdk-muted oc-xs">
        <span className="oc-icon"><RiDownloadCloudLine size={12} /></span> 被控端不出网时先「下载工件到面板」，再推过去——两条路产物必须过同一套 sha512。
      </div>
    </div>
  )
}
