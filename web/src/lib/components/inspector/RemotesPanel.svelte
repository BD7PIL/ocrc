<!-- src/lib/components/inspector/RemotesPanel.svelte — 0.26.0: SSH remote hosts
     (provision official opencode, launch via one ssh process = tunnel + serve).
     0.27: inline add form → ZCode-style 4-step wizard (选择方式 → 填写配置 →
     连接中 → 完成) with a log console and enterprise proxy fields.
     List / add / enable-toggle / inspect / provision / sync-auth /
     sync-config / delete. Backend registration is restart-effective — the
     panel says so. -->
<script lang="ts">
  import { api, type RemoteRow } from '$lib/api/client.js'

  export let tick = 0

  let rows: RemoteRow[] = []
  let error = ''
  let busy = ''
  let armed: string | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined
  let logOpen: string | undefined

  const STATE_LABEL: Record<string, string> = {
    unknown: '待探测',
    detecting: '探测中…',
    provisioning: '部署中…',
    launching: '启动中…',
    online: '在线',
    'needs-auth': '缺凭据',
    error: '错误',
    offline: '离线',
    disabled: '已停用',
  }

  async function load() {
    try {
      rows = (await api.remotes()).remotes ?? []
    } catch { /* keep last list */ }
  }
  $: load(), tick

  async function toggle(r: RemoteRow) {
    rows = rows.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) // optimistic
    try {
      await api.setRemoteEnabled(r.id, !r.enabled)
      await load()
    } catch {
      await load()
    }
  }

  async function remove(id: string) {
    if (armed !== id) {
      armed = id
      clearTimeout(armTimer)
      armTimer = setTimeout(() => (armed = undefined), 3000)
      return
    }
    clearTimeout(armTimer)
    armed = undefined
    try {
      await api.deleteRemote(id)
      await load()
    } catch { /* keep row on failure */ }
  }

  async function act(id: string, what: 'inspect' | 'provision' | 'sync-auth' | 'sync-config') {
    busy = `${id}:${what}`
    error = ''
    try {
      if (what === 'inspect') await api.inspectRemote(id)
      else if (what === 'provision') await api.provisionRemote(id)
      else if (what === 'sync-config') await api.syncRemoteConfig(id)
      else await api.syncRemoteAuth(id)
    } catch (e) {
      error = `${what}: ${(e as Error).message}`
    } finally {
      busy = ''
      await load()
    }
  }

  function rowLabel(r: RemoteRow): string {
    return r.name || r.host
  }

  // ── wizard (0.27): 选择方式 → 填写配置 → 连接中 → 完成 ──────────────────────
  let wizardOpen = false
  let wizStep: 1 | 2 | 3 | 4 = 1
  let wizId: string | undefined
  let wizPhase = ''
  let wizFailed = false
  let wizError = ''
  let wizEndState: 'online' | 'needs-auth' = 'online'
  // step-2 fields
  let fHost = ''
  let fUser = ''
  let fPort = 22
  let fRemotePort = 4199
  let showProxy = false
  let fHttpProxy = ''
  let fHttpsProxy = ''
  let fNoProxy = ''
  let fCaPath = ''
  let logEl: HTMLElement | undefined

  function openWizard() {
    wizardOpen = true
    wizStep = 1
    wizId = undefined
    wizPhase = ''
    wizFailed = false
    wizError = ''
    wizEndState = 'online'
    fHost = ''
    fUser = ''
    fPort = 22
    fRemotePort = 4199
    showProxy = false
    fHttpProxy = ''
    fHttpsProxy = ''
    fNoProxy = ''
    fCaPath = ''
  }
  function closeWizard() {
    wizardOpen = false
    void load()
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  /** Poll load() while the wizard is on step 3 so the log console stays live. */
  async function pollLoop() {
    while (wizardOpen && wizStep === 3) {
      await load()
      await sleep(1500)
    }
  }

  $: if (logEl && wizStep === 3) logEl.scrollTop = logEl.scrollHeight

  function wizardRow(): RemoteRow | undefined {
    return rows.find((r) => r.id === wizId)
  }
  $: wizLogs = wizardRow()?.status?.logTail ?? []
  $: wizState = wizardRow()?.status?.state ?? 'unknown'

  async function runConnect() {
    wizFailed = false
    wizError = ''
    wizStep = 3
    void pollLoop()
    try {
      wizPhase = '保存配置'
      const saved = await api.saveRemote({
        host: fHost.trim(),
        user: fUser.trim() || undefined,
        port: fPort,
        remotePort: fRemotePort,
        enabled: false,
        httpProxy: fHttpProxy.trim() || undefined,
        httpsProxy: fHttpsProxy.trim() || undefined,
        noProxy: fNoProxy.trim() || undefined,
        caPath: fCaPath.trim() || undefined,
      })
      if (saved.error) { wizError = saved.error; wizFailed = true; return }
      wizId = saved.remote.id

      wizPhase = '探测环境（一轮 ssh）'
      let inspection: Record<string, any> | undefined
      try { inspection = (await api.inspectRemote(wizId)).inspection } catch { /* state recorded server-side */ }

      if (inspection && !inspection.opencodePath) {
        wizPhase = '部署 opencode（官方安装器，pin 本机版本）'
        const res = await api.provisionRemote(wizId)
        if (!res.ok) { wizFailed = true; return }
      }

      wizPhase = '启动隧道 + serve'
      await api.setRemoteEnabled(wizId, true)
      wizPhase = '等待在线（最多 120s）'

      const t0 = Date.now()
      let end: RemoteRow | undefined
      while (Date.now() - t0 < 120_000) {
        await load()
        const st = wizardRow()?.status?.state
        if (st === 'online' || st === 'needs-auth' || st === 'error') { end = wizardRow(); break }
        await sleep(1500)
      }
      const st = end?.status?.state
      if (st === 'online' || st === 'needs-auth') {
        wizEndState = st
        wizStep = 4
      } else {
        wizFailed = true
      }
    } catch (e) {
      wizError = (e as Error).message
      wizFailed = true
    }
  }

  async function retryConnect() {
    if (wizId) { try { await api.setRemoteEnabled(wizId, false) } catch { /* ignore */ } }
    await runConnect()
  }
</script>

<div class="remotes">
  <div class="hd">
    <button class="add" on:click={openWizard} aria-label="添加远程主机">+</button>
  </div>

  <div class="list">
    {#each rows as r (r.id)}
      {@const st = r.status?.state ?? 'unknown'}
      <div class="row" class:off={!r.enabled} class:online={st === 'online'}>
        <button class="switch" class:on={r.enabled} on:click={() => toggle(r)} aria-pressed={r.enabled} aria-label={`${r.enabled ? '停用' : '启用'} ${rowLabel(r)}`}>
          <span class="dot" aria-hidden="true"></span>
        </button>
        <button class="main" on:click={() => (logOpen = logOpen === r.id ? undefined : r.id)} title="部署/隧道日志">
          <div class="txt">
            <div class="prompt">{rowLabel(r)} <span class="badge b-{st}">{STATE_LABEL[st] ?? st}</span></div>
            <div class="spec mono">
              {r.user ? `${r.user}@` : ''}{r.host}{r.port !== 22 ? `:${r.port}` : ''} · 远端 :{r.remotePort}{r.status?.detail ? ` · ${r.status.detail}` : ''}
            </div>
          </div>
        </button>
        <div class="ops">
          {#if st === 'needs-auth'}
            <button class="op" disabled={busy === `${r.id}:sync-auth`} on:click={() => act(r.id, 'sync-auth')}>同步凭据</button>
          {:else}
            <button class="op" disabled={!!busy} on:click={() => act(r.id, 'inspect')}>探测</button>
            {#if !r.status?.inspection?.opencodePath}
              <button class="op accent" disabled={!!busy || st === 'provisioning'} on:click={() => act(r.id, 'provision')}>部署</button>
            {/if}
          {/if}
          <button class="op" disabled={!!busy} on:click={() => act(r.id, 'sync-config')} title="推送本机 opencode 配置（skills/MCP/agents 文档），同名文件先备份">同步配置</button>
          <button class="del" class:arm={armed === r.id} on:click={() => remove(r.id)} aria-label="删除 {rowLabel(r)}">{armed === r.id ? '确认?' : '✕'}</button>
        </div>
      </div>
      {#if logOpen === r.id && r.status?.logTail?.length}
        <pre class="logs mono">{r.status.logTail.join('\n')}</pre>
      {/if}
    {/each}
    {#if rows.length === 0}
      <div class="empty">添加一台 SSH 主机（需先 <code>ssh-copy-id</code> 免密）。opencode 未安装时会自动官方部署并钉版本。</div>
    {/if}
  </div>

  {#if error}<div class="err">{error}</div>{/if}
</div>

{#if wizardOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" on:click={(e) => { if (e.target === e.currentTarget) closeWizard() }}>
    <div class="wiz" role="dialog" aria-modal="true" aria-label="添加远程主机">
      <aside class="wiz-steps">
        <div class="ws-title">远程连接</div>
        {#each [{ label: '选择方式', n: 1 }, { label: '填写配置', n: 2 }, { label: '连接中', n: 3 }, { label: '完成', n: 4 }] as s (s.n)}
          <div class="ws-row" class:current={wizStep === s.n} class:done={wizStep > s.n}>
            <span class="ws-dot">{wizStep > s.n ? '✓' : s.n}</span>
            <span>{s.label}</span>
          </div>
        {/each}
      </aside>

      <div class="wiz-body">
        <button class="wiz-close" aria-label="关闭" on:click={closeWizard}>×</button>

        {#if wizStep === 1}
          <h3>选择连接方式</h3>
          <p class="hint">选择进入目标主机的方式；ocrc 通过系统 ssh 管理远程 opencode。</p>
          <div class="cards">
            <button class="card selected" type="button">
              <span class="cicon">▣</span>
              <span class="cname">SSH</span>
              <span class="cdesc">远程主机</span>
            </button>
            <button class="card disabled" type="button" disabled>
              <span class="cicon">›_</span>
              <span class="cname">WSL</span>
              <span class="cdesc">待接入</span>
            </button>
            <button class="card disabled" type="button" disabled>
              <span class="cicon">⚙</span>
              <span class="cname">Docker</span>
              <span class="cdesc">待接入</span>
            </button>
          </div>
          <div class="wiz-foot">
            <button class="btn" on:click={closeWizard}>取消</button>
            <button class="btn primary" on:click={() => (wizStep = 2)}>下一步 ›</button>
          </div>

        {:else if wizStep === 2}
          <h3>填写连接配置</h3>
          <p class="hint">填写建立 SSH 连接所需的信息；需已对目标主机 <code>ssh-copy-id</code> 免密。</p>
          <div class="form">
            <label class="frow"><span>主机</span><input bind:value={fHost} placeholder="IP 或 ~/.ssh/config 别名" /></label>
            <div class="fgrid">
              <label class="frow"><span>端口</span><input type="number" min="1" max="65535" bind:value={fPort} /></label>
              <label class="frow"><span>用户名（可空）</span><input bind:value={fUser} /></label>
            </div>
            <label class="frow"><span>远端 opencode 端口</span><input type="number" min="1" max="65535" bind:value={fRemotePort} title="远端 loopback serve 端口" /></label>

            <button class="proxy-toggle" on:click={() => (showProxy = !showProxy)}>
              {showProxy ? '▾' : '▸'} 企业代理（可选 — 远端 LLM 请求经企业网关出网）
            </button>
            {#if showProxy}
              <div class="proxy">
                <label class="frow"><span>HTTP_PROXY</span><input bind:value={fHttpProxy} placeholder="http://gw.corp:3128" /></label>
                <label class="frow"><span>HTTPS_PROXY</span><input bind:value={fHttpsProxy} placeholder="http://gw.corp:3128" /></label>
                <label class="frow"><span>NO_PROXY</span><input bind:value={fNoProxy} placeholder="留空自动追加 127.0.0.1,localhost" /></label>
                <label class="frow"><span>CA 证书路径（远端）</span><input bind:value={fCaPath} placeholder="/etc/pki/corp-ca.pem" /></label>
                <p class="note">注入远端 serve 进程；NO_PROXY 强制包含 127.0.0.1（隧道流量不走代理）。含凭据的代理 URL 在面板中脱敏显示。</p>
              </div>
            {/if}
            {#if wizError}<div class="err">{wizError}</div>{/if}
          </div>
          <div class="wiz-foot">
            <button class="btn" on:click={() => (wizStep = 1)}>上一步</button>
            <button class="btn primary" disabled={!fHost.trim()} on:click={runConnect}>开始连接</button>
          </div>

        {:else if wizStep === 3}
          <h3>连接中</h3>
          <p class="phase mono">{wizPhase}{#if wizState !== 'unknown'} · 状态：{STATE_LABEL[wizState] ?? wizState}{/if}</p>
          <pre class="console mono" bind:this={logEl}>{(wizLogs.length ? wizLogs : ['$ 等待日志…']).join('\n')}</pre>
          {#if wizFailed}
            <div class="fail">⚠ 连接失败{wizError ? `：${wizError}` : '——查看上方日志定位'}。</div>
            <div class="wiz-foot">
              <button class="btn" on:click={closeWizard}>关闭</button>
              <button class="btn primary" on:click={retryConnect}>重试</button>
            </div>
          {:else}
            <div class="wiz-foot">
              <button class="btn" on:click={closeWizard}>后台继续</button>
            </div>
          {/if}

        {:else}
          <h3>完成</h3>
          {#if wizEndState === 'online'}
            <p class="done-ok">✅ 远程主机已在线。重启 ocrc 实例后接入会话列表（重启生效）。</p>
          {:else}
            <p class="done-warn">⚠ 主机已连接但缺少 opencode 凭据——在列表中点「同步凭据」复制本机 auth.json。</p>
          {/if}
          <div class="wiz-foot">
            <button class="btn primary" on:click={closeWizard}>完成</button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .remotes { font-size: 11.5px; }
  .hd { display: flex; align-items: center; justify-content: space-between; }
  .add {
    width: 20px; height: 20px; display: grid; place-items: center; padding: 0;
    background: transparent; border: 1px solid var(--border-2); border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 13px; line-height: 1; cursor: pointer;
  }
  .add:hover { color: var(--text); border-color: var(--accent); }

  .list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .row { display: flex; align-items: flex-start; gap: 8px; }
  .row.off .prompt { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--border); }

  .switch {
    flex-shrink: 0; width: 22px; height: 14px; margin-top: 2px; padding: 0;
    border: 1px solid var(--border); border-radius: var(--radius-pill);
    background: var(--bg-input); display: grid; align-items: center; cursor: pointer;
  }
  .switch .dot {
    width: 8px; height: 8px; margin: 0 2px; border-radius: 50%;
    background: var(--text-3); transition: transform .16s ease, background .16s ease;
  }
  .switch.on { border-color: var(--accent); }
  .switch.on .dot { background: var(--accent); transform: translateX(8px); }

  .main { flex: 1; min-width: 0; padding: 0; background: transparent; border: none; text-align: left; cursor: pointer; }
  .txt { min-width: 0; }
  .prompt { font-size: 11.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .spec { font-size: 10px; color: var(--text-3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .badge {
    display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: var(--radius-pill);
    font-size: 9px; letter-spacing: .04em; border: 1px solid var(--border); color: var(--text-3);
  }
  .badge.b-online { border-color: var(--ok); color: var(--ok); }
  .badge.b-launching, .badge.b-provisioning, .badge.b-detecting { border-color: var(--accent); color: var(--accent); }
  .badge.b-error { border-color: var(--err); color: var(--err); }
  .badge.b-needs-auth { border-color: var(--warn, var(--accent)); color: var(--warn, var(--accent)); }

  .ops { display: flex; gap: 3px; align-items: center; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
  .op {
    padding: 1px 6px; background: transparent; border: 1px solid var(--border-2); border-radius: var(--radius-xs);
    color: var(--text-3); font-size: 10px; cursor: pointer;
  }
  .op:hover { color: var(--text); border-color: var(--accent); }
  .op.accent { color: var(--accent); border-color: var(--accent); }
  .op:disabled { opacity: .45; cursor: default; }
  .del {
    flex-shrink: 0; padding: 0 5px; min-width: 18px; height: 18px;
    background: transparent; border: none; border-radius: var(--radius-xs);
    color: var(--text-3); font-size: 11px; cursor: pointer;
  }
  .del:hover { color: var(--err); }
  .del.arm { color: var(--err); border: 1px solid var(--err); }

  .logs {
    margin: 2px 0 0 30px; padding: 7px 9px; max-height: 180px; overflow-y: auto;
    background: var(--bg-code); border: 1px solid var(--border-2); border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 10px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }

  .empty { color: var(--text-3); font-size: 10.5px; line-height: 1.6; padding: 4px 0; }
  .empty code { font-family: var(--font-mono); color: var(--text-2); }
  .err { color: var(--err); font-size: 10.5px; margin-top: 6px; }

  /* ── wizard (ZCode RemoteConnectionDialog register) ── */
  .scrim {
    position: fixed; inset: 0; z-index: var(--z-modal, 90);
    background: rgba(0, 0, 0, .55);
    display: grid; place-items: center;
  }
  .wiz {
    display: flex;
    width: min(760px, calc(100vw - 32px));
    height: min(520px, calc(100vh - 48px));
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 24px 70px rgba(0, 0, 0, .6);
    overflow: hidden;
  }
  .wiz-steps {
    width: 176px; flex-shrink: 0;
    background: var(--bg-panel);
    border-right: 1px solid var(--border-2);
    padding: 18px 14px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .ws-title { font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 14px; }
  .ws-row {
    display: flex; align-items: center; gap: 9px;
    padding: 8px 10px; border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 12px;
  }
  .ws-row.current { color: var(--text); background: var(--bg-elev2); }
  .ws-row.done { color: var(--text-2); }
  .ws-dot {
    width: 20px; height: 20px; display: grid; place-items: center; flex-shrink: 0;
    border: 1.5px solid var(--border); border-radius: 50%;
    font-family: var(--font-mono); font-size: 10px;
  }
  .ws-row.current .ws-dot { border-color: var(--accent); color: var(--accent); }
  .ws-row.done .ws-dot { border-color: var(--ok); color: var(--ok); }

  .wiz-body {
    position: relative;
    flex: 1; min-width: 0;
    padding: 20px 22px 16px;
    display: flex; flex-direction: column;
    overflow-y: auto;
  }
  .wiz-close {
    position: absolute; top: 10px; right: 12px;
    width: 26px; height: 26px; display: grid; place-items: center;
    background: transparent; border: none; border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 16px; cursor: pointer;
  }
  .wiz-close:hover { color: var(--text); background: var(--bg-input); }
  .wiz-body h3 { margin: 0 0 6px; font-size: 15px; font-weight: 700; color: var(--text); }
  .hint { margin: 0 0 14px; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
  .hint code { font-family: var(--font-mono); color: var(--text-2); }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .card {
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
    padding: 14px; text-align: left;
    background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text-2); cursor: pointer;
    transition: border-color .12s ease;
  }
  .card.selected { border-color: var(--accent); }
  .card.disabled { opacity: .45; cursor: default; }
  .cicon { font-size: 15px; color: var(--text-2); }
  .cname { font-size: 13px; font-weight: 700; color: var(--text); }
  .cdesc { font-size: 11px; color: var(--text-3); }

  .form { display: flex; flex-direction: column; gap: 9px; }
  .frow { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-3); }
  .frow input {
    padding: 6px 9px; background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 12px;
  }
  .frow input:focus { outline: 1px solid var(--accent); }
  .fgrid { display: grid; grid-template-columns: 110px 1fr; gap: 9px; }
  .proxy-toggle {
    align-self: flex-start; padding: 0; background: transparent; border: none;
    color: var(--text-3); font: inherit; font-size: 11px; cursor: pointer;
  }
  .proxy-toggle:hover { color: var(--text); }
  .proxy { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px dashed var(--border); border-radius: var(--radius-sm); }
  .note { margin: 0; font-size: 10px; color: var(--text-4); line-height: 1.6; }

  .phase { margin: 0 0 8px; font-size: 11px; color: var(--accent); }
  .console {
    flex: 1; min-height: 180px; margin: 0; padding: 10px 12px;
    background: var(--bg-code); border: 1px solid var(--border-2); border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 10.5px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
    overflow-y: auto;
  }
  .fail { margin-top: 10px; font-size: 11.5px; color: var(--err); }

  .wiz-foot {
    margin-top: auto; padding-top: 14px;
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .btn {
    padding: 6px 16px;
    background: transparent; border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-2);
    font: inherit; font-size: 12px; cursor: pointer;
    transition: border-color .12s ease, color .12s ease;
  }
  .btn:hover { color: var(--text); border-color: var(--text-4); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn:disabled { opacity: .45; cursor: default; }
  .done-ok { font-size: 12.5px; color: var(--ok); line-height: 1.7; }
  .done-warn { font-size: 12.5px; color: var(--warn, var(--accent)); line-height: 1.7; }

  @media (max-width: 820px) {
    .scrim { place-items: stretch; }
    .wiz { width: 100%; height: 100%; border: none; border-radius: 0; flex-direction: column; }
    .wiz-steps {
      width: 100%; flex-direction: row; align-items: center; gap: 8px;
      padding: 12px 14px; border-right: none; border-bottom: 1px solid var(--border-2);
      overflow-x: auto; scrollbar-width: none;
    }
    .ws-title { margin-bottom: 0; margin-right: 6px; white-space: nowrap; }
    .ws-row { padding: 4px 8px; white-space: nowrap; }
  }
</style>
