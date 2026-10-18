import { useCallback, useEffect, useState } from 'react'
import type { HostClient } from '@openchamber/sdk'
import { networkLabel, stateLabel, tierLabel } from '../shared/instance-labels.js'
import { KitBadge, KitBanner, KitButton, KitEmpty, KitField, KitSelect, KitSeparator, KitSwitch } from '../shared/kit.js'
import { post, type RequestFn } from '../shared/service-client.js'

/**
 * 远程服务器列表（2.0.0-alpha.8「远程机器能力」，PRODUCT 第零点十条；0.8.2 重做卡片）。
 *
 * 这一页只做一件事：**把 openchamber 装到远程机器上，然后把 app 连过去**。动线只有
 * 一条——添加服务器 → 检查并安装 → 启动 → 创建配对链接（在桌面 app 里确认后，这台
 * 机器出现在「其他 OpenChamber 服务器」）。
 *
 * 卡片按**固定字段顺序**画，缺的字段写「未知」：以前是"状态里有什么画什么"，于是两台
 * 机器显示的事实集不一样（一台有版本没有 node，另一台反过来），看起来像两个产品。
 * 每条事实只出现一次：地址不再既进标题又进第二行，网络也不再同时进徽标、摘要与详情。
 *
 * 主动作**随状态推进**（未安装 → 检查并安装；已停止 → 启动；在线 → 打开界面 + 停止），
 * 其余动作收在「更多」里并按配置 / 维护分组——十二个同权按钮排成两行时，没有一个看
 * 起来是"该按的"。写远程机器的动作（安装、同步、移除）都要一次显式确认。
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
  /** D7: who holds each forward leg (pid + role), from the manager's markers. */
  holders?: string[]
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

/** C5：控制端 vs 远程机器的配置差异 + 一次同步会做什么（同一个 plan 就是 apply 用的那份）。 */
interface ConfigDiff {
  localDir: string
  add: string[]
  change: string[]
  same: string[]
  peerOnly: string[]
  unknown: string[]
  auth: { local: boolean; peer: boolean }
  plan: {
    basename: string
    configChanged: boolean
    files: string[]
    deletes: string[]
    keyDeletes: { requested: string[]; removed: string[] }
    keyDeleteCandidates: Array<{ collection: string; key: string }>
    droppedManagedKeys: string[]
    secretsReplaced: Array<{ path: string; env: string }>
    baseUrlRewrites: Array<{ provider: string; from?: string; to: string }>
    commentsWillBeLost?: boolean
    shadowed: string[]
    notes: string[]
  }
  peerError?: string
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

/** D3：远程机器两份日志（我们的 serve 重定向 + 实例自己的）。 */
interface PeerLogs {
  ok: boolean
  error?: string
  instance: string[]
  app: string[]
  paths: { instance: string; app: string }
}

export function RemoteInstance(props: { request: RequestFn; host: HostClient | null }) {
  const { request, host } = props
  const [rows, setRows] = useState<InstanceRow[]>([])
  const [busy, setBusy] = useState('')
  /** 错误带**作用域**：`page`（读列表失败）贴顶部；某台服务器的 id 则贴**那张卡**里——
   *  列表长了以后，用户在卡片中部操作失败，顶部横幅在屏幕外，等于没报错。 */
  const [error, setError] = useState<{ scope: string; message: string } | null>(null)
  /** 首屏是否还在读列表。没有它，服务慢的时候会先闪一下「还没有服务器」。 */
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [planFor, setPlanFor] = useState<{ id: string; reply: PlanDetail } | null>(null)
  const [confirmFor, setConfirmFor] = useState('')
  const [pairFor, setPairFor] = useState<{ id: string; reply: PairLink } | null>(null)
  const [logFor, setLogFor] = useState<{ id: string; lines: string[]; peer?: PeerLogs } | null>(null)
  const [secretFor, setSecretFor] = useState<{ id: string; url: string; uiPassword: string } | null>(null)
  const [configFor, setConfigFor] = useState<{ id: string; diff: ConfigDiff } | null>(null)
  const [syncResult, setSyncResult] = useState('')
  /** Which card has its 详情 expanded (one at a time — the point is less noise). */
  const [detailsFor, setDetailsFor] = useState<string | null>(null)
  /** Which card has 更多 expanded (one at a time, same reason as 详情). */
  const [moreFor, setMoreFor] = useState<string | null>(null)
  /** 移除要二次确认：记录删掉之后这台机器就从列表里消失了。 */
  const [removeFor, setRemoveFor] = useState('')
  /** Deletions are opt-in per item: a peer-only file or key is never removed by
   *  the diff itself (that would be a wipe wearing a sync's clothes). */
  const [checkedDeletes, setCheckedDeletes] = useState<Record<string, boolean>>({})

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
      setError(null)
    } catch (err) {
      setError({ scope: 'page', message: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [op])

  // 宿主桥要先就绪：Panel 第一遍渲染时 host 还是 null，这时发请求只会拿到
  // 「宿主桥未就绪」——正常情况下它被紧接着的成功应答盖掉，服务慢时却会留在屏幕上。
  useEffect(() => { if (host) void refresh() }, [host, refresh])

  // The pins and the free local port are needed outside the form too (the plan
  // card names the app version), so they are fetched once on mount.
  useEffect(() => {
    if (!host) return
    void op<Defaults>({ op: 'defaults' }).then(setDefaults).catch(() => { /* the form re-asks */ })
  }, [host, op])

  const run = async (label: string, fn: () => Promise<unknown>, scope = 'page') => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError({ scope, message: (err as Error).message })
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
    if (!host0) throw new Error('需要主机地址')
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
  }, id)

  const openUi = (row: InstanceRow) => run(`url:${row.id}`, async () => {
    const reply = await op<{ url: string }>({ op: 'url', id: row.id })
    // The guest sandbox has no allow-popups, so window.open is blocked.
    // host.openUrl is the sanctioned "open externally".
    if (!host) throw new Error('宿主未连接，无法打开界面')
    await host.openUrl(reply.url)
  })

  const makePairLink = (id: string) => run(`pairlink:${id}`, async () => {
    const reply = await op<PairLink>({ op: 'pairlink', id })
    setPairFor({ id, reply })
  }, id)

  const showLogs = (id: string) => run(`logs:${id}`, async () => {
    // 控制端转发日志是**本进程**的（同步取）；远程机器两份要一次 ssh（job 型）。
    const reply = await op<{ lines: string[] }>({ op: 'logs', id, tail: 80 })
    const peer = await op<PeerLogs>({ op: 'peerlog', id, lines: 60 })
    setLogFor({ id, lines: reply.lines ?? [], peer })
  }, id)

  const showSecret = (id: string) => run(`secret:${id}`, async () => {
    const reply = await op<{ uiPassword: string; url: string }>({ op: 'uipassword', id })
    setSecretFor({ id, ...reply })
  }, id)

  const showConfigDiff = (id: string) => run(`configdiff:${id}`, async () => {
    const diff = await op<ConfigDiff>({ op: 'configdiff', id })
    setConfigFor({ id, diff })
    setCheckedDeletes({})
    setSyncResult('')
  }, id)

  const syncConfigNow = (id: string, dryRun: boolean) => run(`${dryRun ? 'dryrun' : 'syncconfig'}:${id}`, async () => {
    const deletes = Object.entries(checkedDeletes).filter(([k, v]) => v && k.startsWith('file:')).map(([k]) => k.slice(5))
    const keyDeletes = Object.entries(checkedDeletes).filter(([k, v]) => v && k.startsWith('key:')).map(([k]) => k.slice(4))
    const r = await op<{ ok: boolean; detail: string }>({ op: 'syncconfig', id, payload: { deletes, keyDeletes, dryRun } })
    setSyncResult(`${r.ok ? 'OK' : 'FAIL'} ${r.detail}`)
    const diff = await op<ConfigDiff>({ op: 'configdiff', id })
    setConfigFor({ id, diff })
  }, id)

  const syncAuthNow = (id: string) => run(`syncauth:${id}`, async () => {
    const r = await op<{ ok: boolean; detail: string }>({ op: 'syncauth', id })
    setSyncResult(`${r.ok ? 'OK' : 'FAIL'} ${r.detail}`)
  }, id)

  const copy = async (label: string, text: string) => {
    if (!host) throw new Error('宿主未连接，无法写剪贴板')
    await run(label, async () => { await host.writeClipboard(text) })
  }

  return (
    <div className="oc-stack">
      {/* 页面级错误（读列表失败）。它出现时**不显示空态**——请求失败了，
          我们并不知道有没有服务器，不能断言"还没有"。 */}
      {error?.scope === 'page' ? <KitBanner tone="error" title="出错了" body={error.message} /> : null}

      <span className="oc-muted oc-sm">把 openchamber 装到远程机器，然后用配对链接把它加进 app。</span>
      <div className="oc-row oc-row-between">
        <span className="oc-muted oc-xs">
          {error?.scope === 'page'
            ? '列表读取失败'
            : loading && rows.length === 0
              ? '正在读取服务器列表…'
              : rows.length > 0 ? `已添加 ${rows.length} 台` : '还没有添加服务器'}
        </span>
        <div className="oc-row">
          {/* 列表为空时这个按钮不出现：空态自己带「添加服务器」动作，两个同名按钮
              同时挂在屏上是同一件事说两遍。 */}
          {rows.length > 0 || form ? (
            <KitButton size="sm" label={form ? '取消' : '添加服务器'} variant={form ? 'ghost' : 'default'} loading={busy === 'defaults'} onClick={() => (form ? setForm(null) : openForm())} />
          ) : null}
          <KitButton size="sm" label="刷新" variant="ghost" loading={busy === 'refresh'} onClick={() => void run('refresh', refresh)} />
        </div>
      </div>

      {form ? (
        <div className="oc-card">
          <strong>{form.id ? `编辑 ${form.name || form.id}` : '添加服务器'}</strong>
          <div className="oc-form">
            <div className="oc-form-cell">
              <KitField label="服务器名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="EL7 box（留空则用 用户@主机）" />
            </div>
            <div className="oc-form-cell">
              <KitField label="主机" value={form.host} mono onChange={(v) => setForm({ ...form, host: v })} placeholder="192.168.26.101 或主机名" />
            </div>
            <div className="oc-form-cell">
              <KitField label="SSH 端口" value={form.port} mono onChange={(v) => setForm({ ...form, port: v })} />
            </div>
            <div className="oc-form-cell">
              <KitField label="登录用户" value={form.user} mono onChange={(v) => setForm({ ...form, user: v })} placeholder="demo（留空=本机当前用户）" />
            </div>
            <div className="oc-form-cell">
              <KitSelect
                label="登录方式"
                value={form.sshAuth}
                options={[
                  { id: 'key', label: '密钥', hint: '用本机 ~/.ssh 与 ssh-agent（BatchMode，不弹提示）' },
                  { id: 'password', label: '密码', hint: '密码经 askpass 喂给 ssh；只落 0600 文件，接口不回显' },
                ]}
                onChange={(id) => setForm({ ...form, sshAuth: id === 'password' ? 'password' : 'key' })}
              />
            </div>
            {form.sshAuth === 'password' ? (
              <div className="oc-form-cell">
                <KitField
                  label="SSH 密码"
                  value={form.sshPassword}
                  password
                  onChange={(v) => setForm({ ...form, sshPassword: v })}
                  placeholder={form.id ? '留空 = 不改' : '远程账户密码'}
                  helper="密码档会禁用公钥：否则带口令的私钥会先被试，报的错与密码无关。"
                />
              </div>
            ) : null}
            <div className="oc-form-cell">
              <KitSelect
                label="安装方式"
                value={form.provision}
                options={[
                  { id: 'push', label: '推送安装', hint: '控制端把运行时 + 我们 pin 的 OpenCode + OpenChamber 推过去，远程机器不用联网' },
                  { id: 'reuse', label: '复用已安装', hint: '一个字节都不推：只检查运行时/应用/OpenCode 并把 OpenCode pin 下来' },
                ]}
                onChange={(id) => setForm({ ...form, provision: id === 'reuse' ? 'reuse' : 'push' })}
              />
            </div>
            <div className="oc-form-cell">
              <KitSelect
                label="联网方式"
                value={form.egress}
                options={[
                  { id: 'auto', label: '自动（探测远程机器）', hint: '推荐：远程机器能自己出网就直连' },
                  { id: 'relay', label: '经本机转发', hint: '远程机器完全出不了网时用' },
                { id: 'direct', label: '直连', hint: '远程机器有外网；本机转发不参与' },
              ]}
              onChange={(id) => setForm({ ...form, egress: id === 'relay' ? 'relay' : id === 'direct' ? 'direct' : 'auto' })}
            />
            </div>
            <div className="oc-form-cell">
              <KitField
                label="远程端口"
                value={form.instancePort}
                mono
                onChange={(v) => setForm({ ...form, instancePort: v })}
                helper={defaults ? `OpenChamber 在远程机器上用的端口，默认 ${defaults.instancePort}；占用情况在检查里说（看得到就说，看不到就说看不到）` : undefined}
              />
            </div>
            <div className="oc-form-cell">
              <KitField
                label="本机端口"
                value={form.localPort}
                mono
                onChange={(v) => setForm({ ...form, localPort: v })}
                helper={defaults
                  ? `这台电脑上通往它的端口，实测空闲 ${defaults.localPort}；已占用：${defaults.taken.length ? defaults.taken.join(', ') : '无'}`
                  : undefined}
              />
            </div>
          </div>

          <KitSeparator label="连接行为" />
          <div className="oc-row">
            <KitSwitch label="自动重连" checked={form.reconnect} onChange={(v) => setForm({ ...form, reconnect: v })} />
            <KitSwitch label="服务重启后恢复" checked={form.restoreOnStart} onChange={(v) => setForm({ ...form, restoreOnStart: v })} />
          </div>

          <KitSeparator label="自动决定（不是选项）" />
          <div className="oc-xs oc-muted">
            {`兼容档：按远程机器 glibc 判定${defaults ? '（< 2.28 → 含重建 node-pty 的旧档）' : ''}　·　运行时：node v${defaults?.nodeRuntime ?? '…'}`}
          </div>
          <div className="oc-xs oc-muted">
            {`OpenChamber pin：${defaults?.appVersion ?? '…'}（跟随控制端，不取 latest）　·　OpenCode pin：${defaults?.enginePin ?? '…'}　·　绑定：${defaults?.bind ?? '127.0.0.1'}`}
          </div>
          <div className="oc-xs oc-muted">界面密码：添加时自动生成，只存在控制端；卡片里「界面密码」可看可复制（在浏览器里打开远程界面时要）。</div>
          <div className="oc-row">
            <KitButton size="sm" label={form.id ? '保存' : '添加'} loading={busy === 'save'} onClick={() => void save()} />
            <KitButton size="sm" variant="ghost" label="取消" disabled={busy === 'save'} onClick={() => setForm(null)} />
          </div>
        </div>
      ) : null}

      {!loading && !form && !error && rows.length === 0 ? (
        <KitEmpty
          title="还没有服务器"
          body="一台远程机器一条记录。装好之后用配对链接把它加进 app，它就会出现在「其他 OpenChamber 服务器」。"
          action={{ label: '添加服务器', onClick: () => openForm() }}
        />
      ) : null}

      {rows.map((row) => {
        const st = row.status
        const state = stateLabel(st?.state)
        const isUp = st?.state === 'online'
        // 「装过没有」只看一件事：有没有探测到 OpenCode。在线本身就是证据。
        const provisioned = Boolean(st?.engine) || isUp
        const address = `${row.user ? `${row.user}@` : ''}${row.host}:${row.port}`
        const isPlan = planFor?.id === row.id
        return (
          <div className="oc-card" key={row.id}>
            {/* ① 名称 + 状态 */}
            <div className="oc-row">
              <strong className="oc-truncate">{row.name ?? row.id}</strong>
              <KitBadge label={state.label} tone={state.tone} />
            </div>
            {/* ② 地址 + 登录方式 */}
            <div className="oc-muted oc-sm oc-truncate">{`${address} · ${row.sshAuth === 'password' ? '密码登录' : '密钥登录'}`}</div>
            {/* ③ 版本 + 网络（缺的写「未知」，不省字段） */}
            <div className="oc-muted oc-sm">
              {`OpenChamber ${st?.app ?? '未知'} · OpenCode ${st?.engine?.version ?? '未知'} · ${networkLabel(st?.egress)}`}
            </div>
            {/* 这台卡自己产生的错误贴在这里：长列表下用户看不到页面顶部的横幅。 */}
            {error?.scope === row.id ? <KitBanner tone="error" title="出错了" body={error.message} /> : null}
            {/* 需要人管的状态才解释；在线不需要解释（它的解释在详情里）。 */}
            {st && st.state !== 'online' && st.detail ? <div className="oc-xs oc-muted">{st.detail}</div> : null}
            {/* 首跑动线：装完但没启动时，把下一步说出来——「创建配对链接」在装完前是隐藏的。 */}
            {provisioned && !isUp ? <div className="oc-xs oc-muted">已装好。下一步：启动 → 创建配对链接。</div> : null}

            <KitSeparator />
            {/* 主动作随状态推进：没装就装、停了就起、在线就打开。 */}
            <div className="oc-row">
              {!provisioned ? (
                <KitButton
                  size="sm"
                  label="检查并安装"
                  loading={busy === `plan:${row.id}`}
                  onClick={() => void plan(row.id)}
                />
              ) : isUp ? (
                <KitButton size="sm" label="打开界面" loading={busy === `url:${row.id}`} onClick={() => void openUi(row)} />
              ) : (
                <KitButton
                  size="sm"
                  label="启动"
                  loading={busy === `up:${row.id}`}
                  onClick={() => void run(`up:${row.id}`, async () => { await op({ op: 'up', id: row.id }) }, row.id)}
                />
              )}
              {isUp ? (
                <KitButton
                  size="sm"
                  variant="outline"
                  label="停止"
                  loading={busy === `down:${row.id}`}
                  onClick={() => void run(`down:${row.id}`, async () => { await op({ op: 'down', id: row.id }) }, row.id)}
                />
              ) : null}
              {/* 配对链接要求实例在跑，所以没装过就不摆出来（免得点了才发现不行）。 */}
              {provisioned ? (
                <KitButton
                  size="sm"
                  variant="outline"
                  label="创建配对链接"
                  loading={busy === `pairlink:${row.id}`}
                  onClick={() => void makePairLink(row.id)}
                />
              ) : null}
              <span className="oc-push" />
              <KitButton
                size="xs"
                variant="ghost"
                label={detailsFor === row.id ? '收起详情' : '详情 ▾'}
                onClick={() => setDetailsFor(detailsFor === row.id ? null : row.id)}
              />
              <KitButton
                size="xs"
                variant="ghost"
                label={moreFor === row.id ? '收起更多' : '更多 ▾'}
                onClick={() => setMoreFor(moreFor === row.id ? null : row.id)}
              />
            </div>

            {detailsFor === row.id ? (
              <div className="oc-col">
                <div className="oc-xs oc-muted">{`端口：远程 ${row.instancePort} → 本机 ${row.localPort}（绑定 127.0.0.1）`}</div>
                {st?.engine ? <div className="oc-xs oc-muted oc-sdk-mono">{`OpenCode：${st.engine.path}`}</div> : null}
                {st?.runtime ? <div className="oc-xs oc-muted">{`运行时：node ${st.runtime}`}</div> : null}
                {st?.proxy?.enabled && st?.egress?.relay ? <div className="oc-xs oc-muted">{`本机转发：:${st.proxy.localPort} → :${st.proxy.remotePort}`}</div> : null}
                {st?.egress ? <div className="oc-xs oc-muted">{`联网方式：${st.egress.mode}${st.egress.probe ? `，探测 ${st.egress.probe}` : ''} —— ${st.egress.reason}`}</div> : null}
                {st?.inspected ? <div className="oc-xs oc-muted">{`远程机器：${st.inspected.uname ?? '?'} · glibc ${st.inspected.glibc ?? '?'}`}</div> : null}
                {st?.forwardAttempts ? <div className="oc-xs oc-muted">{`转发重连 ${st.forwardAttempts} 次`}</div> : null}
                {(st?.holders ?? []).map((line) => <div key={line} className="oc-xs oc-muted">{`转发持有者 ${line}`}</div>)}
                {st?.detail ? <div className="oc-xs oc-muted">{`最近一次结果：${st.detail}`}</div> : null}
              </div>
            ) : null}

            {moreFor === row.id ? (
              <div className="oc-col">
                <div className="oc-xs oc-muted">配置</div>
                <div className="oc-row">
                  <KitButton size="sm" variant="ghost" label="配置差异与同步" loading={busy === `configdiff:${row.id}`} onClick={() => void showConfigDiff(row.id)} />
                  <KitButton size="sm" variant="ghost" label="界面密码" loading={busy === `secret:${row.id}`} onClick={() => void showSecret(row.id)} />
                </div>
                <div className="oc-xs oc-muted">维护</div>
                <div className="oc-row">
                  <KitButton size="sm" variant="ghost" label={provisioned ? '检查并更新' : '检查并安装'} loading={busy === `plan:${row.id}`} onClick={() => void plan(row.id)} />
                  <KitButton size="sm" variant="ghost" label="日志" loading={busy === `logs:${row.id}`} onClick={() => void showLogs(row.id)} />
                  <KitButton size="sm" variant="ghost" label="编辑" onClick={() => openForm(row)} />
                </div>
                <div className="oc-xs oc-muted">开关</div>
                <div className="oc-row">
                  <KitSwitch
                    label="自动重连"
                    checked={row.reconnect !== false}
                    onChange={(v) => void run(`patch:${row.id}`, async () => {
                      await op({ op: 'patch', id: row.id, payload: { reconnect: v } })
                    }, row.id)}
                  />
                  <KitSwitch
                    label="服务重启后恢复"
                    checked={row.restoreOnStart !== false}
                    onChange={(v) => void run(`patch:${row.id}`, async () => {
                      await op({ op: 'patch', id: row.id, payload: { restoreOnStart: v } })
                    }, row.id)}
                  />
                </div>
                {/* 移除是破坏性动作：单独一行，且先问一次（原来它和 日志/编辑 挤在一排，
                    确认行把那一排挤爆、"取消"被挤出可视区）。 */}
                <div className="oc-xs oc-muted">移除</div>
                {removeFor === row.id ? (
                  <>
                    <KitBanner
                      tone="warning"
                      title="移除这台服务器？"
                      body="只删控制端的这条记录；远程机器上的实例会先被停掉（~/.ocrc/remote 不动）。"
                    />
                    <div className="oc-row">
                      <KitButton
                        size="sm"
                        variant="destructive"
                        label="确认移除"
                        loading={busy === `delete:${row.id}`}
                        onClick={() => void run(`delete:${row.id}`, async () => {
                          await op({ op: 'delete', id: row.id })
                          setRemoveFor('')
                        }, row.id)}
                      />
                      <KitButton size="sm" variant="ghost" label="取消" onClick={() => setRemoveFor('')} />
                    </div>
                  </>
                ) : (
                  <div className="oc-row">
                    <KitButton size="sm" variant="destructive" label="移除服务器" onClick={() => setRemoveFor(row.id)} />
                  </div>
                )}
              </div>
            ) : null}

            {/* 动作结果（同步/升级）就贴在这一行下面：卡片可能没打开，结果不能只活在卡片里。 */}
            {syncResult ? <div className="oc-xs oc-sdk-mono">{syncResult}</div> : null}

            {pairFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>配对链接</strong>
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
                        }, row.id)}
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
                        label="重新创建"
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
                  <strong>界面密码（只在控制端本地）</strong>
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

            {configFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>配置差异（控制端 ↔ 远程机器的 ~/.config/opencode）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setConfigFor(null)} />
                </div>
                {configFor.diff.peerError ? <KitBanner tone="error" title="读远程机器失败" body={configFor.diff.peerError} /> : null}
                {/* 先给结论：这一卡最该先看到的是"会写几个文件"。 */}
                <div className="oc-muted">
                  {configFor.diff.add.length + configFor.diff.change.length > 0
                    ? `会写 ${configFor.diff.add.length + configFor.diff.change.length} 个文件（旧件留 .ocrc-bak）`
                    : '文件层面没有差异'}
                  {configFor.diff.plan.configChanged ? `，并改配置文档 ${configFor.diff.plan.basename}` : ''}
                </div>

                <KitSeparator label="差异" />
                <div className="oc-xs oc-muted">
                  {`只在控制端（会推过去）${configFor.diff.add.length}　·　两边不同（覆盖）${configFor.diff.change.length}　·　两边相同${configFor.diff.same.length}　·　只在远程机器${configFor.diff.peerOnly.length}　·　算不出哈希${configFor.diff.unknown.length}（读不到内容，不当作相同）`}
                </div>
                {configFor.diff.add.length + configFor.diff.change.length > 0 ? (
                  <pre className="oc-pre">{[...configFor.diff.add.map((f) => `+ ${f}`), ...configFor.diff.change.map((f) => `~ ${f}`)].join('\n')}</pre>
                ) : null}
                <div className="oc-xs oc-muted">{`控制端配置目录：${configFor.diff.localDir}`}</div>

                <KitSeparator label="同步会做什么" />
                <div className="oc-xs oc-muted">
                  {`配置文档：${configFor.diff.plan.configChanged ? `会改（写远程 ${configFor.diff.plan.basename}）` : '无变化'}　·　凭据 auth.json：控制端 ${configFor.diff.auth.local ? '有' : '无'}，远程 ${configFor.diff.auth.peer ? '有' : '无'}`}
                </div>
                {configFor.diff.plan.shadowed.length > 0 ? (
                  <KitBanner
                    tone="warning"
                    title="会被远程覆盖层压住的键"
                    body={`${configFor.diff.plan.shadowed.join('、')}——远程的 jsonc 是更高优先层，同步后这些键仍按它的值生效。`}
                  />
                ) : null}

                {/* 删除必须显式勾选：diff 只负责提出候选。 */}
                {configFor.diff.peerOnly.length > 0 || configFor.diff.plan.keyDeleteCandidates.length > 0 ? (
                  <>
                    <KitSeparator label="删除（勾选才会删）" />
                    <div className="oc-col">
                      <div className="oc-xs oc-muted">只在远程机器（旧件留 .ocrc-bak）：</div>
                      {configFor.diff.peerOnly.map((rel) => (
                        <KitSwitch
                          key={`file:${rel}`}
                          label={`文件 ${rel}`}
                          checked={checkedDeletes[`file:${rel}`] === true}
                          onChange={(v) => setCheckedDeletes((prev) => ({ ...prev, [`file:${rel}`]: v }))}
                        />
                      ))}
                      {configFor.diff.plan.keyDeleteCandidates.map((c) => (
                        <KitSwitch
                          key={`key:${c.collection}:${c.key}`}
                          label={`配置项 ${c.collection}:${c.key}`}
                          checked={checkedDeletes[`key:${c.collection}:${c.key}`] === true}
                          onChange={(v) => setCheckedDeletes((prev) => ({ ...prev, [`key:${c.collection}:${c.key}`]: v }))}
                        />
                      ))}
                    </div>
                  </>
                ) : null}

                {configFor.diff.plan.notes.length > 0 ? (
                  <>
                    <KitSeparator label="说明" />
                    <div className="oc-col">
                      {configFor.diff.plan.notes.map((n, i) => (
                        <div key={String(i)} className="oc-xs oc-muted">{`· ${n}`}</div>
                      ))}
                    </div>
                  </>
                ) : null}
                <KitSeparator label="动作" />
                {syncResult ? <div className="oc-xs oc-sdk-mono">{syncResult}</div> : null}
                <div className="oc-row">
                  <KitButton
                    size="sm"
                    variant="outline"
                    label="试运行（不写远程机器）"
                    loading={busy === `dryrun:${row.id}`}
                    onClick={() => void syncConfigNow(row.id, true)}
                  />
                  <KitButton
                    size="sm"
                    label="同步配置"
                    loading={busy === `syncconfig:${row.id}`}
                    onClick={() => void syncConfigNow(row.id, false)}
                  />
                  <KitButton
                    size="sm"
                    variant="outline"
                    label="同步凭据（auth.json）"
                    loading={busy === `syncauth:${row.id}`}
                    onClick={() => void syncAuthNow(row.id)}
                  />
                </div>
                <div className="oc-xs oc-muted">
                  凭据走 ssh stdin 写到远程 0600，不回显；配置只推差异、opencode.json 深合并（远程独有键保留）、plugin 键交给远程自己的 OpenChamber。
                </div>
              </div>
            ) : null}

            {logFor?.id === row.id ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>日志（三处：控制端转发 / 远程实例 / 远程机器的 OpenChamber）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setLogFor(null)} />
                </div>
                {logFor.peer && !logFor.peer.ok ? (
                  <KitBanner tone="warning" title="取远程日志失败" body={logFor.peer.error ?? '原因未知'} />
                ) : null}
                <KitSeparator label="控制端转发（本进程，尾 80 行）" />
                <pre className="oc-pre">{logFor.lines.length ? logFor.lines.join('\n') : '（空）'}</pre>
                {logFor.peer ? (
                  <>
                    <KitSeparator label={`远程实例日志 · ${logFor.peer.paths.instance || '路径未知'}`} />
                    <pre className="oc-pre">{logFor.peer.instance.length ? logFor.peer.instance.join('\n') : '（空——实例可能没起过）'}</pre>
                    <KitSeparator label={`远程机器的 OpenChamber 日志 · ${logFor.peer.paths.app || '路径未知'}`} />
                    <pre className="oc-pre">{logFor.peer.app.length ? logFor.peer.app.join('\n') : '（空）'}</pre>
                  </>
                ) : null}
              </div>
            ) : null}

            {isPlan && planFor ? (
              <div className="oc-card">
                <div className="oc-row oc-row-between">
                  <strong>检查结果（只读，不写远程机器）</strong>
                  <KitButton size="xs" variant="ghost" label="收起" onClick={() => setPlanFor(null)} />
                </div>
                <div className="oc-muted">
                  {planFor.reply.reachable
                    ? `${planFor.reply.inspected?.uname ?? '?'} · glibc ${planFor.reply.inspected?.glibc ?? '?'} · HOME=${planFor.reply.inspected?.home ?? '?'}`
                    : `ssh 不可达：${planFor.reply.sshError ?? '未知原因'}`}
                </div>
                <div className="oc-muted">{`运行时：${planFor.reply.runtime ?? '缺失（会推送）'}`}</div>
                <div className="oc-muted">{`OpenChamber：${planFor.reply.app ?? '缺失（会推送）'}`}</div>
                <div className="oc-muted">
                  {planFor.reply.engine
                    ? `OpenCode：${planFor.reply.engine.path} → ${planFor.reply.engine.version}`
                    : 'OpenCode：不满足 v2 门禁'}
                </div>
                <div className="oc-xs oc-muted">
                  {`兼容档：${tierLabel(planFor.reply.tier)}（按 glibc ${planFor.reply.inspected?.glibc ?? '?'}）　·　安装方式：${planFor.reply.provision === 'reuse' ? '复用已安装（不推字节）' : '推送安装'}`}
                </div>
                {planFor.reply.egress ? (
                  <div className="oc-xs oc-muted">
                    {`网络：${planFor.reply.egress.relay ? '经本机转发' : '直连'}（策略 ${planFor.reply.egress.mode}${planFor.reply.egress.probe ? `，探测 ${planFor.reply.egress.probe}` : ''}：${planFor.reply.egress.reason}）`}
                  </div>
                ) : null}
                {planFor.reply.engineCandidates.length > 0 ? (
                  <div className="oc-col">
                    {planFor.reply.engineCandidates.map((c) => (
                      <div key={c.path} className="oc-xs oc-muted">{`· ${c.raw || '（版本未知）'} · ${c.path}`}</div>
                    ))}
                  </div>
                ) : null}
                {planFor.reply.engineError ? <KitBanner tone="warning" title="OpenCode 门禁" body={planFor.reply.engineError} /> : null}
                <div className="oc-muted">将要做的：</div>
                {/* 不用 KitList：它的 `row-lead` 是 64px 定宽列，动作清单会变成
                    "标记在最左、文字在右边很远" 的坏表格。这里就是几行文字。 */}
                <div className="oc-col">
                  {planFor.reply.actions.map((a, i) => (
                    <div key={String(i)} className={a.startsWith('FAIL') ? 'oc-xs oc-err' : 'oc-xs oc-muted'}>
                      {`${a.startsWith('FAIL') ? '!' : '·'} ${a}`}
                    </div>
                  ))}
                </div>
                <KitSeparator />
                {confirmFor === row.id ? (
                  <div className="oc-row">
                    <span className="oc-muted">会在远程机器写盘（旧文件留 .ocrc-bak）——确认继续？</span>
                    <KitButton
                      size="sm"
                      label="确认安装"
                      loading={busy === `apply:${row.id}`}
                      onClick={() => void run(`apply:${row.id}`, async () => {
                        await op({ op: 'apply', id: row.id, payload: { confirm: true } })
                        setConfirmFor('')
                        setPlanFor(null)
                      }, row.id)}
                    />
                    <KitButton size="sm" variant="ghost" label="取消" onClick={() => setConfirmFor('')} />
                  </div>
                ) : (
                  <div className="oc-row">
                    <KitButton
                      size="sm"
                      label={planFor.reply.provision === 'reuse' ? '检查（复用已安装：不写远程机器）' : `安装到远程机器（OpenChamber ${defaults?.appVersion ?? planFor.reply.app ?? ''}）`}
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
