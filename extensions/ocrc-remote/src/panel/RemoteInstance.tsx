import { useCallback, useEffect, useState } from 'react'
import type { HostClient } from '@openchamber/sdk'
import { KitBadge, KitBanner, KitButton, KitEmpty, KitField, KitList, KitSelect, KitSeparator, KitSpinner, KitSwitch } from '../shared/kit.js'
import { post, type RequestFn } from '../shared/service-client.js'

/**
 * 远程实例视图（2.0.0-alpha.8「对端能力」，PRODUCT 第零点十条；A3 重建表单）。
 *
 * 这一页就是用户口径的实现面：**Add project 里能看到对端、中栏连的是对端引擎**——
 * 机制是把 openchamber 实例跑在被控端，这里只负责把它装好、起好、给出要打开的地址。
 *
 * 表单 = **装机输入**（A1 认证两档、A3 装机方式/出口策略/端口），其余全是派生值：
 * 档位由对端 glibc 决定、运行时只有 glibc-217 一档、app/engine 是 pin、绑定固定回环——
 * 这些都不是选项，所以它们只显示、不带控件（用户点过这一点：tier 与 pin 不是可选项）。
 *
 * 身份那一步交给上游：**生成配对链接 → 官方 app 弹确认 → 这台机器出现在「其他
 * OpenChamber 服务器」**，不在「远程实例」列表里（那是桌面壳自己拥有的面）。
 *
 * 三点纪律在这页的 UI 上直接可见：
 *   · `plan` 先跑（只读预演），把引擎 v2 门禁、"将要做什么"、出口决定摆出来；
 *   · `apply` 会往对端写盘 → 必须一次显式确认（就是那个二次按钮）；
 *   · 引擎的路径与版本来自**实例自报**，不是我猜的（状态里直接显示它自报的 binary）。
 *
 * 所有请求走本扩展的 service（`POST /remote-instance`）；service 直接持有
 * remote-instance manager，不再经过 :4099 的 ocrc host。
 */

interface InstanceStatus {
  state: string
  detail?: string
  url: string
  forwardPid?: number
  forwardAttempts?: number
  engine?: { path: string; version: string }
  runtime?: string
  app?: string
  proxy?: { enabled: boolean; localPort: number; remotePort: number }
  egress?: { mode: string; relay: boolean; reason: string; probe?: string; cached: boolean }
  inspected?: { uname?: string; glibc?: string }
}

interface InstanceRow {
  id: string
  host: string
  user?: string
  port: number
  instancePort: number
  localPort: number
  appVersion: string
  name?: string
  enginePath?: string
  engineVersion?: string
  enabled: boolean
  reconnect?: boolean
  restoreOnStart?: boolean
  sshAuth?: 'key' | 'password'
  hasSshPassword?: boolean
  provision?: 'push' | 'reuse'
  egress?: 'auto' | 'relay' | 'direct'
  hasUiPassword: boolean
  status: InstanceStatus | null
}

interface PlanDetail {
  reachable: boolean
  sshError?: string
  inspected?: { uname?: string; glibc?: string; home?: string }
  runtime?: string
  app?: string
  engine?: { path: string; version: string }
  engineError?: string
  engineCandidates: Array<{ path: string; raw: string }>
  actions: string[]
  url: string
  egress?: { mode: string; relay: boolean; reason: string; probe?: string }
  provision?: 'push' | 'reuse'
  tier?: string
  peerPort?: 'open' | 'closed' | 'unknown'
}

interface Defaults {
  localPort: number
  instancePort: number
  appVersion: string
  enginePin: string
  nodeRuntime: string
  bind: string
  taken: number[]
}

interface PairLink {
  ok: boolean
  detail: string
  link?: string
  expiresAt?: string
  url?: string
}

/** 表单就是装机输入；其余值都是派生的，不进这里。 */
interface FormState {
  id?: string
  name: string
  host: string
  user: string
  port: string
  sshAuth: 'key' | 'password'
  sshPassword: string
  provision: 'push' | 'reuse'
  egress: 'auto' | 'relay' | 'direct'
  instancePort: string
  localPort: string
  reconnect: boolean
  restoreOnStart: boolean
}

const EMPTY_FORM: FormState = {
  name: '', host: '', user: '', port: '22',
  sshAuth: 'key', sshPassword: '',
  provision: 'push', egress: 'auto',
  instancePort: '2610', localPort: '4610',
  reconnect: true, restoreOnStart: true,
}

const TONE: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
  online: 'success',
  starting: 'info',
  provisioning: 'info',
  checking: 'info',
  offline: 'error',
  error: 'error',
  unknown: 'warning',
  disabled: 'warning',
}

const EGRESS_LABEL: Record<string, string> = {
  auto: 'auto（探测对端）',
  relay: 'relay（强制经控制端）',
  direct: 'direct（强制直连）',
}

export function RemoteInstance(props: { request: RequestFn; host: HostClient | null }) {
  const { request, host } = props
  const [rows, setRows] = useState<InstanceRow[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [planFor, setPlanFor] = useState<{ id: string; reply: PlanDetail } | null>(null)
  const [confirmFor, setConfirmFor] = useState('')
  const [pairFor, setPairFor] = useState<{ id: string; reply: PairLink } | null>(null)
  const [logFor, setLogFor] = useState<{ id: string; lines: string[] } | null>(null)
  const [secretFor, setSecretFor] = useState<{ id: string; url: string; uiPassword: string } | null>(null)

  const op = useCallback(
    async <T,>(body: Record<string, unknown>): Promise<T> => {
      const first = await post<{ jobId?: string } & T>(request, '/remote-instance', body)
      if (first && typeof (first as { jobId?: string }).jobId === 'string') {
        const jobId = (first as { jobId: string }).jobId
        const deadline = Date.now() + 10 * 60_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1_000))
          const reply = await post<{ job: { state: string; result?: T; error?: string } }>(request, '/remote-instance', { op: 'job', jobId })
          if (reply.job.state === 'done') return reply.job.result as T
          if (reply.job.state === 'error') throw new Error(reply.job.error ?? '操作失败')
        }
        throw new Error('操作超时（10 分钟）')
      }
      return first as T
    },
    [request],
  )

  const refresh = useCallback(async () => {
    try {
      const reply = await op<{ instances: InstanceRow[] }>({ op: 'list' })
      setRows(reply.instances ?? [])
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [op])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  /** 打开表单：默认值来自 service（本机端口是**实测**空闲的，不是猜的）。 */
  const openForm = (row?: InstanceRow) => {
    void run('defaults', async () => {
      const d = await op<Defaults>({ op: 'defaults' })
      setDefaults(d)
      setForm(row
        ? {
            id: row.id,
            name: row.name ?? '',
            host: row.host,
            user: row.user ?? '',
            port: String(row.port),
            sshAuth: row.sshAuth === 'password' ? 'password' : 'key',
            // 密码永不回显：留空表示"不改"，填了才覆盖。
            sshPassword: '',
            provision: row.provision === 'reuse' ? 'reuse' : 'push',
            egress: row.egress ?? 'auto',
            instancePort: String(row.instancePort),
            localPort: String(row.localPort),
            reconnect: row.reconnect !== false,
            restoreOnStart: row.restoreOnStart !== false,
          }
        : { ...EMPTY_FORM, instancePort: String(d.instancePort), localPort: String(d.localPort) })
    })
  }

  const save = () => run('save', async () => {
    if (!form) return
    const host0 = form.host.trim()
    if (!host0) throw new Error('需要 SSH 主机')
    const port = Number(form.port)
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('SSH 端口不合法')
    const payload: Record<string, unknown> = {
      host: host0,
      name: form.name.trim() || undefined,
      user: form.user.trim() || undefined,
      port,
      sshAuth: form.sshAuth,
      provision: form.provision,
      egress: form.egress,
      instancePort: Number(form.instancePort),
      localPort: Number(form.localPort),
      reconnect: form.reconnect,
      restoreOnStart: form.restoreOnStart,
    }
    // 密码只在填了的时候进 payload：空 = 保留原值（后端也不会回显）。
    if (form.sshAuth === 'password' && form.sshPassword) payload.sshPassword = form.sshPassword
    if (form.sshAuth === 'key') payload.sshPassword = undefined
    if (form.id) await op({ op: 'patch', id: form.id, payload })
    else await op({ op: 'add', payload })
    setForm(null)
  })

  const plan = (id: string) => run(`plan:${id}`, async () => {
    const reply = await op<PlanDetail>({ op: 'plan', id })
    setPlanFor({ id, reply })
    setConfirmFor('')
  })

  const makePairLink = (id: string) => run(`pairlink:${id}`, async () => {
    const reply = await op<PairLink>({ op: 'pairlink', id })
    setPairFor({ id, reply })
  })

  const showLogs = (id: string) => run(`logs:${id}`, async () => {
    const reply = await op<{ lines: string[] }>({ op: 'logs', id, tail: 80 })
    setLogFor({ id, lines: reply.lines ?? [] })
  })

  const showSecret = (id: string) => run(`secret:${id}`, async () => {
    const reply = await op<{ uiPassword: string; url: string }>({ op: 'uipassword', id })
    setSecretFor({ id, ...reply })
  })

  const copy = async (label: string, text: string) => {
    if (!host) throw new Error('宿主未连接，无法写剪贴板')
    await run(label, async () => { await host.writeClipboard(text) })
  }

  return (
    <div className="oc-stack">
      <KitBanner
        tone="info"
        title="把 openchamber 实例装到对端"
        body="Add project 列的、中栏连的就是对端。引擎必须是 opencode v2（major 2 且 ≥ 2.0.20）；对端只有 v1 时会推我们 pin 的 v2 到 ~/.ocrc/remote/engine/，既有安装一律不动。装好之后生成配对链接，在官方 app 里确认——这台机器会出现在「其他 OpenChamber 服务器」，不是「远程实例」。"
      />
      {error ? <KitBanner tone="error" title="出错了" body={error} /> : null}

      <div className="oc-row oc-row-between">
        <span className="oc-muted">{`已登记 ${rows.length} 台`}</span>
        <div className="oc-row">
          <KitButton size="sm" label={form ? '取消' : '添加对端'} variant={form ? 'ghost' : 'default'} loading={busy === 'defaults'} onClick={() => (form ? setForm(null) : openForm())} />
          <KitButton size="sm" label="刷新" variant="ghost" loading={busy === 'refresh'} onClick={() => void run('refresh', refresh)} />
        </div>
      </div>

      {form ? (
        <div className="oc-card">
          <strong>{form.id ? `编辑 ${form.id}` : '添加对端'}</strong>
          <div className="oc-row">
            <KitField label="SSH 主机" value={form.host} mono onChange={(v) => setForm({ ...form, host: v })} placeholder="192.168.26.101 或主机名" />
            <KitField label="用户" value={form.user} mono onChange={(v) => setForm({ ...form, user: v })} placeholder="demo（留空=本机当前用户）" />
            <KitField label="SSH 端口" value={form.port} mono onChange={(v) => setForm({ ...form, port: v })} />
          </div>
          <div className="oc-row">
            <KitSelect
              label="认证档"
              value={form.sshAuth}
              options={[
                { id: 'key', label: '密钥', hint: '用本机 ~/.ssh 与 ssh-agent（BatchMode，不弹提示）' },
                { id: 'password', label: '密码', hint: '密码经 askpass 喂给 ssh；只落 0600 档案，接口不回显' },
              ]}
              onChange={(id) => setForm({ ...form, sshAuth: id === 'password' ? 'password' : 'key' })}
            />
            {form.sshAuth === 'password' ? (
              <KitField
                label="SSH 密码"
                value={form.sshPassword}
                password
                onChange={(v) => setForm({ ...form, sshPassword: v })}
                placeholder={form.id ? '留空 = 不改' : '对端账户密码'}
                helper="密码档会禁用公钥：否则带口令的私钥会先被试，报的错与密码无关。"
              />
            ) : null}
            <KitField label="昵称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="EL7 box" />
          </div>
          <div className="oc-row">
            <KitSelect
              label="装机方式"
              value={form.provision}
              options={[
                { id: 'push', label: '推包', hint: '控制端备件推过去：运行时 + 我们 pin 的引擎 + 应用，对端零联网' },
                { id: 'reuse', label: '复用已有', hint: '一个字节都不推：只检查运行时/应用/引擎并把引擎 pin 下来' },
              ]}
              onChange={(id) => setForm({ ...form, provision: id === 'reuse' ? 'reuse' : 'push' })}
            />
            <KitSelect
              label="出口策略"
              value={form.egress}
              options={[
                { id: 'auto', label: EGRESS_LABEL.auto, hint: '推荐：探测对端，能自己出网就直连' },
                { id: 'relay', label: EGRESS_LABEL.relay, hint: '对端完全无出网时用' },
                { id: 'direct', label: EGRESS_LABEL.direct, hint: '对端有外网；中继不参与' },
              ]}
              onChange={(id) => setForm({ ...form, egress: id === 'relay' ? 'relay' : id === 'direct' ? 'direct' : 'auto' })}
            />
          </div>
          <div className="oc-row">
            <KitField
              label="实例端口（对端）"
              value={form.instancePort}
              mono
              onChange={(v) => setForm({ ...form, instancePort: v })}
              helper={defaults ? `默认 ${defaults.instancePort}；占用情况在预演里说（对端能看到就说，看不到就说看不到）` : undefined}
            />
            <KitField
              label="本机端口（控制端）"
              value={form.localPort}
              mono
              onChange={(v) => setForm({ ...form, localPort: v })}
              helper={defaults
                ? `实测空闲 ${defaults.localPort}；档案里已占用：${defaults.taken.length ? defaults.taken.join(', ') : '无'}`
                : undefined}
            />
            <KitSwitch label="自动重连" checked={form.reconnect} onChange={(v) => setForm({ ...form, reconnect: v })} />
            <KitSwitch label="重启自恢复" checked={form.restoreOnStart} onChange={(v) => setForm({ ...form, restoreOnStart: v })} />
          </div>

          <KitSeparator />
          {/* 派生值：只显示，不给控件（它们不是选项）。 */}
          <div className="oc-xs oc-muted">派生值（不是选项）：</div>
          <div className="oc-xs oc-muted">
            {`档位：由对端 glibc 决定${defaults ? '（< 2.28 → legacy 档，含重建的 node-pty）' : ''}　·　运行时：node v${defaults?.nodeRuntime ?? '…'}（只有 glibc-217 一档）`}
          </div>
          <div className="oc-xs oc-muted">
            {`app pin：${defaults?.appVersion ?? '…'}（跟随控制端，不取 latest）　·　引擎 pin：opencode ${defaults?.enginePin ?? '…'}　·　绑定：${defaults?.bind ?? '127.0.0.1'}`}
          </div>
          <div className="oc-xs oc-muted">UI 密码：登记时自动生成，只在控制端；行内「查看 UI 密码」可看可复制（浏览器打开对端时要）。</div>
          <div className="oc-row">
            <KitButton size="sm" label={form.id ? '保存' : '登记'} loading={busy === 'save'} onClick={() => void save()} />
          </div>
        </div>
      ) : null}

      {rows.length === 0 && !form ? (
        <KitEmpty title="还没有对端" body="点「添加对端」登记一台被控机：先预演，再装机，然后启动它、生成配对链接。" />
      ) : null}

      {rows.map((row) => {
        const st = row.status
        const tone = TONE[st?.state ?? 'unknown'] ?? 'warning'
        const isPlan = planFor?.id === row.id
        return (
          <div className="oc-card" key={row.id}>
            <div className="oc-row oc-row-between">
              <div className="oc-row">
                <strong>{row.name ? `${row.name} · ${row.id}` : row.id}</strong>
                <KitBadge label={st?.state ?? 'unknown'} tone={tone} />
                {st?.engine ? <KitBadge label={`引擎 ${st.engine.version}`} tone="success" /> : null}
                {st?.runtime ? <KitBadge label={`node ${st.runtime}`} /> : null}
                <KitBadge label={row.sshAuth === 'password' ? 'SSH 密码' : 'SSH 密钥'} />
                {row.provision === 'reuse' ? <KitBadge label="复用（不推包）" /> : null}
                {/* D1：出口是**决定**，不是"中继在不在"——直连的对端不该看起来像缺中继。 */}
                {st?.egress ? (
                  <KitBadge
                    label={st.egress.relay ? `出口 经控制端` : `出口 直连`}
                    tone={st.egress.cached ? (st.egress.relay ? 'info' : 'success') : 'warning'}
                  />
                ) : null}
                {st?.proxy?.enabled && st?.egress?.relay ? <KitBadge label={`中继 :${st.proxy.localPort} → :${st.proxy.remotePort}`} /> : null}
              </div>
              <span className="oc-muted">{`${row.user ? `${row.user}@` : ''}${row.host}:${row.port}`}</span>
            </div>
            {st?.detail ? <div className="oc-muted">{st.detail}</div> : null}
            {st?.egress ? <div className="oc-xs oc-muted">{`出口：${st.egress.relay ? '经控制端中继' : '对端直连'}（策略 ${st.egress.mode}${st.egress.probe ? `，探测 ${st.egress.probe}` : ''}：${st.egress.reason}）`}</div> : null}
            {st?.engine ? <div className="oc-muted oc-sdk-mono">{st.engine.path}</div> : null}
            {st?.forwardAttempts ? <div className="oc-muted">{`隧道重连 ${st.forwardAttempts} 次`}</div> : null}

            <KitSeparator />
            <div className="oc-row">
              <KitButton size="sm" label="预演" variant="outline" loading={busy === `plan:${row.id}`} onClick={() => void plan(row.id)} />
              <KitButton
                size="sm"
                label={st?.state === 'online' ? '停机' : '启动'}
                loading={busy === `${st?.state === 'online' ? 'down' : 'up'}:${row.id}`}
                onClick={() => void run(`${st?.state === 'online' ? 'down' : 'up'}:${row.id}`, async () => {
                  await op({ op: st?.state === 'online' ? 'down' : 'up', id: row.id })
                })}
              />
              <KitButton
                size="sm"
                label="生成配对链接"
                loading={busy === `pairlink:${row.id}`}
                onClick={() => void makePairLink(row.id)}
              />
              <KitButton size="sm" variant="ghost" label="编辑" onClick={() => openForm(row)} />
              <KitButton
                size="sm"
                variant="ghost"
                label="打开界面"
                onClick={() => void run(`url:${row.id}`, async () => {
                  const reply = await op<{ url: string }>({ op: 'url', id: row.id })
                  // The guest sandbox has no allow-popups, so window.open is
                  // blocked. host.openUrl is the sanctioned "open externally".
                  if (!host) throw new Error('宿主未连接，无法打开界面')
                  await host.openUrl(reply.url)
                })}
              />
              <KitButton size="sm" variant="ghost" label="日志" loading={busy === `logs:${row.id}`} onClick={() => void showLogs(row.id)} />
              <KitButton size="sm" variant="ghost" label="查看 UI 密码" loading={busy === `secret:${row.id}`} onClick={() => void showSecret(row.id)} />
              <KitButton
                size="sm"
                variant="ghost"
                label={row.reconnect === false ? '开自动重连' : '关自动重连'}
                onClick={() => void run(`patch:${row.id}`, async () => {
                  await op({ op: 'patch', id: row.id, payload: { reconnect: row.reconnect === false } })
                })}
              />
              <KitButton
                size="sm"
                variant="ghost"
                label={row.restoreOnStart === false ? '开重启自恢复' : '关重启自恢复'}
                onClick={() => void run(`patch:${row.id}`, async () => {
                  await op({ op: 'patch', id: row.id, payload: { restoreOnStart: row.restoreOnStart === false } })
                })}
              />
              <KitButton
                size="sm"
                variant="destructive"
                label="删档案"
                onClick={() => void run(`delete:${row.id}`, async () => {
                  await op({ op: 'delete', id: row.id })
                })}
              />
              {busy.endsWith(row.id) ? <KitSpinner size="sm" /> : null}
            </div>

            {pairFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>配对链接（身份在上游，我们只递链接）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setPairFor(null)} />
                </div>
                <div className="oc-muted">{pairFor.reply.detail}</div>
                {pairFor.reply.link ? (
                  <>
                    <pre className="oc-pre">{pairFor.reply.link}</pre>
                    <div className="oc-muted oc-xs">
                      点「在 app 里打开」会拉起桌面版并弹确认框——确认后这台机器出现在「其他 OpenChamber 服务器」，
                      每设备一个 token（可撤销、无过期），我们不存任何凭据。
                      {pairFor.reply.expiresAt ? `链接有效期至 ${pairFor.reply.expiresAt}。` : ''}
                    </div>
                    <div className="oc-row">
                      <KitButton
                        size="sm"
                        label="在 app 里打开"
                        onClick={() => void run(`openlink:${row.id}`, async () => {
                          if (!host) throw new Error('宿主未连接，无法打开链接')
                          await host.openUrl(pairFor.reply.link as string)
                        })}
                      />
                      <KitButton
                        size="sm"
                        variant="outline"
                        label="复制链接"
                        loading={busy === `copy:${row.id}`}
                        onClick={() => void copy(`copy:${row.id}`, pairFor.reply.link as string)}
                      />
                      <KitButton
                        size="sm"
                        variant="ghost"
                        label="重新生成"
                        loading={busy === `pairlink:${row.id}`}
                        onClick={() => void makePairLink(row.id)}
                      />
                    </div>
                  </>
                ) : (
                  <KitBanner tone="warning" title="没拿到链接" body={pairFor.reply.detail} />
                )}
              </div>
            ) : null}

            {secretFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>UI 密码（控制端本地）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setSecretFor(null)} />
                </div>
                <pre className="oc-pre">{`${secretFor.url}\n${secretFor.uiPassword}`}</pre>
                <div className="oc-row">
                  <KitButton
                    size="sm"
                    variant="outline"
                    label="复制"
                    onClick={() => void copy(`copysecret:${row.id}`, `${secretFor.url}\n${secretFor.uiPassword}`)}
                  />
                </div>
              </div>
            ) : null}

            {logFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>控制端隧道日志（尾 80 行）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setLogFor(null)} />
                </div>
                <pre className="oc-pre">{logFor.lines.length ? logFor.lines.join('\n') : '（空）'}</pre>
              </div>
            ) : null}

            {isPlan && planFor ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>预演（只读，不写对端）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setPlanFor(null)} />
                </div>
                <div className="oc-muted">
                  {planFor.reply.reachable
                    ? `${planFor.reply.inspected?.uname ?? '?'} · glibc ${planFor.reply.inspected?.glibc ?? '?'} · HOME=${planFor.reply.inspected?.home ?? '?'}`
                    : `ssh 不可达：${planFor.reply.sshError ?? '未知原因'}`}
                </div>
                <div className="oc-muted">{`运行时：${planFor.reply.runtime ?? '缺失（会推送）'}`}</div>
                <div className="oc-muted">{`应用：${planFor.reply.app ?? '缺失（会推送）'}`}</div>
                <div className="oc-muted">
                  {planFor.reply.engine
                    ? `引擎：${planFor.reply.engine.path} → ${planFor.reply.engine.version}`
                    : '引擎：不满足 v2 门禁'}
                </div>
                <div className="oc-xs oc-muted">
                  {`档位：${planFor.reply.tier ?? '未判定'}（由 glibc ${planFor.reply.inspected?.glibc ?? '?'} 决定）　·　装机方式：${planFor.reply.provision === 'reuse' ? '复用已有（不推字节）' : '推包'}`}
                </div>
                {planFor.reply.egress ? (
                  <div className="oc-xs oc-muted">
                    {`出口：${planFor.reply.egress.relay ? '经控制端中继' : '对端直连'}（策略 ${planFor.reply.egress.mode}${planFor.reply.egress.probe ? `，探测 ${planFor.reply.egress.probe}` : ''}：${planFor.reply.egress.reason}）`}
                  </div>
                ) : null}
                {planFor.reply.engineCandidates.length > 0 ? (
                  <KitList
                    items={planFor.reply.engineCandidates.map((c) => ({ id: c.path, title: c.raw || '（版本未知）', subtitle: c.path, leading: '·' }))}
                    onSelect={() => { /* 只读展示 */ }}
                  />
                ) : null}
                {planFor.reply.engineError ? <KitBanner tone="warning" title="引擎门禁" body={planFor.reply.engineError} /> : null}
                <div className="oc-muted">将要做的：</div>
                <KitList
                  items={planFor.reply.actions.map((a, i) => ({ id: String(i), title: a, leading: a.startsWith('FAIL') ? '!' : '·' }))}
                  onSelect={() => { /* 只读展示 */ }}
                />
                <KitSeparator />
                {confirmFor === row.id ? (
                  <div className="oc-row">
                    <span className="oc-muted">会在对端写盘（旧文件留 .ocrc-bak）——确认继续？</span>
                    <KitButton
                      size="sm"
                      label="确认装机"
                      loading={busy === `apply:${row.id}`}
                      onClick={() => void run(`apply:${row.id}`, async () => {
                        await op({ op: 'apply', id: row.id, payload: { confirm: true } })
                        setConfirmFor('')
                        setPlanFor(null)
                      })}
                    />
                    <KitButton size="sm" variant="ghost" label="取消" onClick={() => setConfirmFor('')} />
                  </div>
                ) : (
                  <div className="oc-row">
                    <KitButton
                      size="sm"
                      label={planFor.reply.provision === 'reuse' ? '检查（复用档：不写对端）' : '装机（推运行时 / 引擎 / 应用）'}
                      disabled={!planFor.reply.reachable}
                      onClick={() => setConfirmFor(row.id)}
                    />
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
