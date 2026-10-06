<!-- RemoteWizard.svelte — shared "add remote host" wizard (选择方式 → 填写配置 →
     连接中 → 完成), ZCode RemoteConnectionDialog register. Opened as the
     NEXT LEVEL of the new-session page (修复#4：远程连接入口统一) and reused by
     the RemotesPanel management list. Dispatches "close" with
     { remoteId?, endState? } when the flow ends. -->
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte'
  import { api, type RemoteRow } from '$lib/api/client.js'
  import { portal } from '$lib/portal.js'

  const dispatch = createEventDispatcher<{ close: { remoteId?: string; endState?: string } }>()

  let rows: RemoteRow[] = []
  let wizardOpen = true
  let wizStep: 1 | 2 | 3 | 4 = 1
  let wizId: string | undefined
  let wizPhase = ''
  let wizFailed = false
  let wizError = ''
  let wizEndState: 'online' | 'needs-auth' = 'online'
  let wizRun = 0
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
  let destroyed = false
  onDestroy(() => { destroyed = true })

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
  void load()

  function finish(detail: { remoteId?: string; endState?: string } = {}) {
    wizardOpen = false
    dispatch('close', detail)
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  async function pollLoop(run: number) {
    while (wizardOpen && wizStep === 3 && wizRun === run && !destroyed) {
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
    const run = ++wizRun
    wizFailed = false
    wizError = ''
    wizStep = 3
    void pollLoop(run)
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
      if (run !== wizRun) return
      if (st === 'online' || st === 'needs-auth') {
        wizEndState = st
        wizStep = 4
      } else {
        wizFailed = true
      }
    } catch (e) {
      if (run !== wizRun) return
      wizError = `连接流程出错：${(e as Error).message}`
      wizFailed = true
    }
  }

  // ── 已有主机管理（折叠在第一步卡片下方）────────────────────────────
  let armed: string | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined
  async function toggle(r: RemoteRow) {
    rows = rows.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x))
    try { await api.setRemoteEnabled(r.id, !r.enabled); await load() } catch { await load() }
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
    try { await api.deleteRemote(id); await load() } catch { /* keep row */ }
  }
  async function syncAuth(id: string) {
    try { await api.syncRemoteAuth(id) } catch { /* ignore */ }
    await load()
  }

  async function retryConnect() {
    if (wizId) { try { await api.setRemoteEnabled(wizId, false) } catch { /* ignore */ } }
    await runConnect()
  }
</script>

{#if wizardOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" use:portal on:click={(e) => { if (e.target === e.currentTarget) finish() }}>
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
        <button class="wiz-close" aria-label="关闭" on:click={() => finish({ remoteId: wizId, endState: wizEndState })}>×</button>

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
          {#if rows.length}
            <!-- 已有主机管理（修复#4：唯一的远程管理面，随向导走） -->
            <div class="owned">
              <div class="owned-hd mono">已配置的主机 · {rows.length}</div>
              {#each rows as r (r.id)}
                {@const st = r.status?.state ?? 'unknown'}
                <div class="owned-row" class:off={!r.enabled}>
                  <button class="omini switch" class:on={r.enabled} on:click={() => toggle(r)} aria-pressed={r.enabled} aria-label={`${r.enabled ? '停用' : '启用'} ${r.host}`}>
                    <span class="omini-dot"></span>
                  </button>
                  <span class="oname mono">{r.name || r.host}</span>
                  <span class="badge b-{st}">{STATE_LABEL[st] ?? st}</span>
                  {#if st === 'needs-auth'}
                    <button class="omini op" on:click={() => syncAuth(r.id)}>同步凭据</button>
                  {/if}
                  <button class="omini del" class:arm={armed === r.id} on:click={() => remove(r.id)} aria-label="删除 {r.host}">{armed === r.id ? '确认?' : '✕'}</button>
                </div>
              {/each}
            </div>
          {/if}
          <div class="wiz-foot">
            <button class="btn" on:click={() => finish({ remoteId: wizId, endState: wizEndState })}>取消</button>
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
              <button class="btn" on:click={() => finish({ remoteId: wizId, endState: wizEndState })}>关闭</button>
              <button class="btn primary" on:click={retryConnect}>重试</button>
            </div>
          {:else}
            <div class="wiz-foot">
              <button class="btn" on:click={() => finish({ remoteId: wizId, endState: wizEndState })}>后台继续</button>
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
            <button class="btn primary" on:click={() => finish({ remoteId: wizId, endState: wizEndState })}>完成</button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}


<style>
  /* ── wizard (ZCode RemoteConnectionDialog register) ──
     motion spec rule 4: modal pop entrance 160ms, transform/opacity only,
     decelerate; scrim fades. reduced-motion kills both globally. */
  .scrim {
    position: fixed; inset: 0; z-index: var(--z-modal, 90);
    background: rgba(0, 0, 0, .55);
    display: grid; place-items: center;
    animation: ocrc-fade var(--dur-1, 120ms) var(--ease-out, ease-out);
  }
  @keyframes ocrc-fade {
    from { opacity: 0; }
    to { opacity: 1; }
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
    animation: ocrc-wiz-pop var(--dur-1, 120ms) var(--ease-out, ease-out);
  }
  @keyframes ocrc-wiz-pop {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .wiz-steps {
    width: 176px; flex-shrink: 0;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
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
  .hint { margin: 0 0 14px; font-size: 12px; color: var(--text-3); line-height: 1.6; }
  .hint code { font-family: var(--font-mono); color: var(--text-2); }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .badge {
    display: inline-block; padding: 0 5px; border-radius: var(--radius-pill);
    font-size: 10px; letter-spacing: .04em; border: 1px solid var(--border); color: var(--text-3);
  }
  .badge.b-online { border-color: var(--ok); color: var(--ok); }
  .badge.b-launching, .badge.b-provisioning, .badge.b-detecting { border-color: var(--accent); color: var(--accent); }
  .badge.b-error { border-color: var(--err); color: var(--err); }
  .badge.b-needs-auth { border-color: var(--warn); color: var(--warn); }
  .badge.b-disabled, .badge.b-offline { color: var(--text-4); }

  /* 已有主机管理列表 */
  .owned { margin-top: 16px; display: flex; flex-direction: column; gap: 4px; }
  .owned-hd { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-4); margin-bottom: 2px; }
  .owned-row {
    display: flex; align-items: center; gap: 8px; padding: 5px 6px;
    border-radius: var(--radius-sm); font-size: 12px; color: var(--text-2);
  }
  .owned-row:hover { background: var(--bg-input); }
  .owned-row.off .oname { text-decoration: line-through; text-decoration-color: var(--border); color: var(--text-3); }
  .oname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .omini {
    background: transparent; border: 1px solid var(--border); border-radius: var(--radius-xs);
    color: var(--text-3); font-size: 10.5px; padding: 2px 7px; cursor: pointer;
  }
  .omini:hover { color: var(--text); border-color: var(--text-4); }
  .omini.del.arm { color: var(--err); border-color: var(--err); }
  .omini.switch {
    width: 22px; height: 14px; padding: 0; display: grid; align-items: center;
    background: var(--bg-input); border-radius: var(--radius-pill);
  }
  .omini-dot { width: 8px; height: 8px; margin: 0 2px; border-radius: 50%; background: var(--text-3); transition: transform .16s ease, background .16s ease; }
  .omini.switch.on { border-color: var(--accent); }
  .omini.switch.on .omini-dot { background: var(--accent); transform: translateX(8px); }
  .omini.op { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
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
    background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 11px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
    overflow-y: auto;
  }
  .fail { margin-top: 10px; font-size: 12px; color: var(--err); }

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
  .done-ok { font-size: 13px; color: var(--ok); line-height: 1.7; }
  .done-warn { font-size: 13px; color: var(--warn, var(--accent)); line-height: 1.7; }

  @media (max-width: 820px) {
    .scrim { place-items: stretch; }
    .wiz { width: 100%; height: 100%; border: none; border-radius: 0; flex-direction: column; }
    .wiz-steps {
      width: 100%; flex-direction: row; align-items: center; gap: 8px;
      padding: 12px 14px; border-right: none; border-bottom: 1px solid var(--border);
      overflow-x: auto; scrollbar-width: none;
    }
    .ws-title { margin-bottom: 0; margin-right: 6px; white-space: nowrap; }
    .ws-row { padding: 4px 8px; white-space: nowrap; }
  }
</style>
