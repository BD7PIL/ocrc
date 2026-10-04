<!-- src/lib/components/inspector/RemotesPanel.svelte — 0.26.0: SSH remote hosts
     (provision official opencode, launch via one ssh process = tunnel + serve).
     List / add / enable-toggle / inspect / provision / sync-auth / sync-config / delete.
     Backend registration is restart-effective — the panel says so. -->
<script lang="ts">
  import { api, type RemoteRow } from '$lib/api/client.js'

  export let tick = 0

  let rows: RemoteRow[] = []
  let creating = false
  let host = ''
  let user = ''
  let port = 22
  let remotePort = 4199
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

  async function create() {
    if (!host.trim()) return
    error = ''
    try {
      const res = await api.saveRemote({ host: host.trim(), user: user.trim() || undefined, port, remotePort, enabled: true })
      if (res.error) { error = res.error; return }
      host = ''
      user = ''
      creating = false
      await load()
    } catch (e) {
      error = (e as Error).message
    }
  }

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
</script>

<div class="remotes">
  <div class="hd">
    <button class="add" on:click={() => (creating = !creating)} aria-label={creating ? '取消添加主机' : '添加远程主机'}>{creating ? '×' : '+'}</button>
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
            <button class="op" disabled={!!busy} on:click={() => act(r.id, 'sync-config')} title="推送本机 opencode 配置（skills/MCP/agents 文档），同名文件先备份">同步配置</button>
            {#if !r.status?.inspection?.opencodePath}
              <button class="op accent" disabled={!!busy || st === 'provisioning'} on:click={() => act(r.id, 'provision')}>部署</button>
            {/if}
          {/if}
          <button class="del" class:arm={armed === r.id} on:click={() => remove(r.id)} aria-label="删除 {rowLabel(r)}">{armed === r.id ? '确认?' : '✕'}</button>
        </div>
      </div>
      {#if logOpen === r.id && r.status?.logTail?.length}
        <pre class="logs mono">{r.status.logTail.join('\n')}</pre>
      {/if}
    {/each}
    {#if rows.length === 0 && !creating}
      <div class="empty">添加一台 SSH 主机（需先 <code>ssh-copy-id</code> 免密）。opencode 未安装时会自动官方部署并钉版本。</div>
    {/if}
  </div>

  {#if creating}
    <div class="form">
      <input class="in" placeholder="host（IP 或 ~/.ssh/config 别名）" bind:value={host} />
      <div class="grid">
        <input class="in" placeholder="user（可空）" bind:value={user} />
        <input class="in num" type="number" min="1" max="65535" bind:value={port} title="SSH 端口" />
        <input class="in num" type="number" min="1" max="65535" bind:value={remotePort} title="远端 opencode 端口" />
      </div>
      {#if error}<div class="err">{error}</div>{/if}
      <button class="go" on:click={create} disabled={!host.trim()}>添加（重启后接入会话列表）</button>
    </div>
  {/if}
</div>

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

  .ops { display: flex; gap: 3px; align-items: center; flex-shrink: 0; }
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

  .form {
    margin-top: 10px; padding: 9px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg-input); display: flex; flex-direction: column; gap: 7px;
  }
  .in {
    width: 100%; padding: 5px 8px; background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 11px; box-sizing: border-box;
  }
  .in:focus { outline: 1px solid var(--accent); }
  .grid { display: grid; grid-template-columns: 1fr 62px 62px; gap: 6px; }
  .err { color: var(--err); font-size: 10.5px; }
  .go {
    align-self: flex-end; padding: 4px 12px; background: var(--accent); border: none;
    border-radius: var(--radius-sm); color: var(--accent-ink); font: inherit; font-weight: 600; cursor: pointer;
  }
  .go:disabled { opacity: .45; cursor: default; }
</style>
