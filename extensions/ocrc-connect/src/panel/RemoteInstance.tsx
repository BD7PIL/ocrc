import { useCallback, useEffect, useState } from 'react'
import type { HostClient } from '@openchamber/sdk'
import { KitBadge, KitBanner, KitButton, KitEmpty, KitField, KitList, KitSeparator, KitSpinner } from '../shared/kit.js'
import { post, type RequestFn } from '../shared/service-client.js'

/**
 * 远程实例视图（2.0.0-alpha.8「对端能力」，PRODUCT 第零点十条）。
 *
 * 这一页就是用户口径的实现面：**Add project 里能看到对端、中栏连的是对端引擎**——
 * 机制是把 openchamber 实例跑在被控端，这里只负责把它装好、起好、给出要打开的地址。
 *
 * 三点纪律在这页的 UI 上直接可见：
 *   · `plan` 先跑（只读预演），把引擎 v2 门禁与"将要做什么"摆出来——用户按下去之前就能看见；
 *   · `apply` 会往对端写盘 → 必须一次显式确认（就是那个二次按钮）；
 *   · 引擎的路径与版本来自**实例自报**，不是我猜的（状态里直接显示它自报的 binary）。
 *
 * 所有请求走本扩展的窄口 `POST /remote-instance`（服务端只放行 `/api/remote-instance*`）。
 * Kit 组件是命令式挂载的（`label`/`items` 属性，不吃 children），这里按它的形状拼。
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
  enginePath?: string
  engineVersion?: string
  enabled: boolean
  reconnect?: boolean
  restoreOnStart?: boolean
  hasUiPassword: boolean
  status: InstanceStatus | null
}

interface PlanReply {
  plan: {
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
  }
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

export function RemoteInstance(props: { request: RequestFn; host: HostClient | null }) {
  const { request } = props
  const [rows, setRows] = useState<InstanceRow[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [target, setTarget] = useState('')
  const [adding, setAdding] = useState(false)
  const [planFor, setPlanFor] = useState<{ id: string; reply: PlanReply['plan'] } | null>(null)
  const [confirmFor, setConfirmFor] = useState('')
  const [handoffFor, setHandoffFor] = useState<{ id: string; reply: { url: string; port: number; hasUiPassword: boolean; lines: string[] } } | null>(null)

  const op = useCallback(
    async <T,>(body: Record<string, unknown>): Promise<T> => post<T>(request, '/remote-instance', body),
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

  const add = () => run('add', async () => {
    const line = target.trim()
    if (!line) return
    const [hostPart, portPart] = line.split(':')
    const [user, host] = hostPart.includes('@') ? hostPart.split('@') : ['', hostPart]
    await op({ op: 'add', payload: { host: host.trim(), user: user.trim() || undefined, port: portPart ? Number(portPart) : undefined } })
    setTarget('')
    setAdding(false)
  })

  const plan = (id: string) => run(`plan:${id}`, async () => {
    const reply = await op<PlanReply>({ op: 'plan', id })
    setPlanFor({ id, reply: reply.plan })
    setConfirmFor('')
  })

  const actionsFor = (row: InstanceRow) => {
    const st = row.status
    const items: string[] = [st?.state === 'online' ? '停机' : '启动']
    return { st, items }
  }

  return (
    <div className="oc-stack">
      <KitBanner
        tone="info"
        title="把 openchamber 实例装到对端"
        body="Add project 列的、中栏连的就是对端。引擎必须是 opencode v2（major 2 且 ≥ 2.0.20）；对端只有 v1 时会推我们 pin 的 v2 到 ~/.ocrc/remote/engine/，既有安装一律不动。"
      />
      {error ? <KitBanner tone="error" title="出错了" body={error} /> : null}

      <div className="oc-row oc-row-between">
        <span className="oc-muted">{`已登记 ${rows.length} 台`}</span>
        <div className="oc-row">
          <KitButton size="sm" label={adding ? '取消添加' : '添加对端'} variant={adding ? 'ghost' : 'default'} onClick={() => setAdding((v) => !v)} />
          <KitButton size="sm" label="刷新" variant="ghost" loading={busy === 'refresh'} onClick={() => void run('refresh', refresh)} />
        </div>
      </div>

      {adding ? (
        <div className="oc-card">
          <KitField
            label="SSH 目标"
            value={target}
            onChange={setTarget}
            placeholder="user@host[:port]"
            helper="被控机地址。认证走本机 ssh（~/.ssh 密钥或 ssh-agent），这里不存任何凭据。"
          />
          <div className="oc-row">
            <KitButton size="sm" label="登记" loading={busy === 'add'} onClick={() => void add()} />
          </div>
        </div>
      ) : null}

      {rows.length === 0 && !adding ? (
        <KitEmpty title="还没有对端" body="点「添加对端」登记一台被控机：先预演，再装机，然后启动它。" />
      ) : null}

      {rows.map((row) => {
        const st = row.status
        const tone = TONE[st?.state ?? 'unknown'] ?? 'warning'
        const isPlan = planFor?.id === row.id
        return (
          <div className="oc-card" key={row.id}>
            <div className="oc-row oc-row-between">
              <div className="oc-row">
                <strong>{row.id}</strong>
                <KitBadge label={st?.state ?? 'unknown'} tone={tone} />
                {st?.engine ? <KitBadge label={`引擎 ${st.engine.version}`} tone="success" /> : null}
                {st?.runtime ? <KitBadge label={`node ${st.runtime}`} /> : null}
                {st?.proxy?.enabled ? <KitBadge label={`出网中继 :${st.proxy.localPort} → :${st.proxy.remotePort}`} /> : null}
              </div>
              <span className="oc-muted">{`${row.user ? `${row.user}@` : ''}${row.host}:${row.port}`}</span>
            </div>
            {st?.detail ? <div className="oc-muted">{st.detail}</div> : null}
            {st?.engine ? <div className="oc-muted oc-sdk-mono">{st.engine.path}</div> : null}
            {st?.forwardAttempts ? <div className="oc-muted">{`隧道重连 ${st.forwardAttempts} 次`}</div> : null}

            <KitSeparator />
            <div className="oc-row">
              <KitButton size="sm" label="预演" variant="outline" loading={busy === `plan:${row.id}`} onClick={() => void plan(row.id)} />
              {actionsFor(row).items.map((label) => (
                <KitButton
                  key={label}
                  size="sm"
                  label={label}
                  loading={busy === `${label === '启动' ? 'up' : 'down'}:${row.id}`}
                  onClick={() => void run(`${label === '启动' ? 'up' : 'down'}:${row.id}`, async () => {
                    await op({ op: label === '启动' ? 'up' : 'down', id: row.id })
                  })}
                />
              ))}
              <KitButton
                size="sm"
                variant="ghost"
                label="打开界面"
                onClick={() => void run(`url:${row.id}`, async () => {
                  const reply = await op<{ url: string }>({ op: 'url', id: row.id })
                  window.open(reply.url, '_blank', 'noopener')
                })}
              />
              <KitButton
                size="sm"
                variant="ghost"
                label="桌面版三项"
                loading={busy === `connect:${row.id}`}
                onClick={() => void run(`connect:${row.id}`, async () => {
                  const reply = await op<{ handoff: { url: string; port: number; hasUiPassword: boolean; lines: string[] } }>({ op: 'connect', id: row.id })
                  setHandoffFor({ id: row.id, reply: reply.handoff })
                })}
              />
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

            {handoffFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>桌面版 Remote Instances 三项</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setHandoffFor(null)} />
                </div>
                <KitList
                  items={handoffFor.reply.lines.map((l, i) => ({ id: String(i), title: l, leading: '·' }))}
                  onSelect={() => { /* 只读展示 */ }}
                />
                <div className="oc-muted">密码只在本机终端：ocrc remote connect &lt;id&gt;</div>
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
                {planFor.reply.engineCandidates.length > 0 ? (
                  <KitList
                    items={planFor.reply.engineCandidates.map((c) => ({ id: c.path, title: c.raw || '（版本未知）', subtitle: c.path, leading: '·' }))}
                    onSelect={() => { /* 只读展示 */ }}
                  />
                ) : null}
                {planFor.reply.engineError ? <KitBanner tone="warning" title="引擎门禁" body={planFor.reply.engineError} /> : null}
                <div className="oc-muted">将要做的：</div>
                <KitList
                  items={planFor.reply.actions.map((a, i) => ({ id: String(i), title: a, leading: '·' }))}
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
                      label="装机（推运行时 / 引擎 / 应用）"
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
