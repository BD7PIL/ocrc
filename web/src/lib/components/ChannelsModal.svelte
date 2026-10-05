<!-- src/lib/components/ChannelsModal.svelte — M9 bot-channels management,
     modelled on the ZCode 机器人管理 dialog: channel list (Telegram/微信/Lark)
     on the left, per-channel detail (enable switch, credentials, reply
     granularity, workspace scope, reset) on the right. Settings persist to
     ~/.ocrc/channels.json via /api/channels. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api, type ChannelRow, type ChannelsInfo } from '$lib/api/client.js'
  import { channelsOpen } from '$lib/stores/ui.js'
  import ChannelLogo from './ChannelLogo.svelte'

  let channels: ChannelRow[] = []
  let tgMeta: ChannelsInfo | null = null
  let selectedId: string | undefined
  let pair: { url: string; svg: string; expiresAt?: number } | null = null
  let tokenDraft = ''
  let credNote = ''
  let credError = ''
  let allowDraft = ''
  let allowNote = ''
  let allowError = ''
  let workspaceDirs: string[] = []
  let copied = false
  // ZCode-style pairing session: countdown from expiresAt; 停止 parks the block
  // until 刷新二维码 restarts it. No expiresAt = legacy static-token QR (no session).
  let now = Date.now()
  let stopped = false
  let countdownTimer: ReturnType<typeof setInterval> | undefined

  $: selected = channels.find((c) => c.id === selectedId) ?? channels[0]
  $: remaining = pair?.expiresAt ? Math.max(0, pair.expiresAt - now) : null
  $: expired = remaining !== null && remaining <= 0
  $: countdown = remaining === null ? '' : `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`

  async function load() {
    try {
      const res = await api.channels()
      channels = res.channels ?? []
      tgMeta = res.telegram ?? null
      if (!selectedId && channels.length > 0) selectedId = channels[0].id
    } catch { /* keep */ }
  }
  async function loadPair() {
    stopped = false
    try { pair = await api.pairQr() } catch { pair = null }
  }
  function stopPairing() {
    stopped = true
  }
  onMount(() => {
    void load()
    void loadPair()
    countdownTimer = setInterval(() => (now = Date.now()), 1000)
  })
  onDestroy(() => { if (countdownTimer) clearInterval(countdownTimer) })

  function name(channel: string): string {
    return channel === 'telegram' ? 'Telegram' : channel === 'wechat' ? '微信' : channel === 'lark' ? 'Lark' : channel
  }
  function close() { channelsOpen.set(false) }
  function select(id: string) {
    selectedId = id
    tokenDraft = ''; credNote = ''; credError = ''
    allowDraft = ''; allowNote = ''; allowError = ''
  }
  async function toggleEnabled(c: ChannelRow) {
    channels = channels.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x))
    try { await api.updateChannel(c.id, { enabled: !c.enabled }) } catch { /* ignore */ }
  }
  async function setGranularity(c: ChannelRow, g: 'standard' | 'detailed') {
    channels = channels.map((x) => (x.id === c.id ? { ...x, replyGranularity: g } : x))
    try { await api.updateChannel(c.id, { replyGranularity: g }) } catch { /* ignore */ }
  }
  async function saveCred(c: ChannelRow) {
    if (!tokenDraft.trim()) { credError = '请输入凭证内容'; return }
    credError = ''
    try {
      const res = await api.updateChannel(c.id, { credentials: { token: tokenDraft.trim() } })
      if (res.error) { credError = res.error; return }
      credNote = res.warning ?? '已保存——重启实例后生效（面板凭证优先于 config.env）'
      tokenDraft = ''
      await load()
    } catch (e) {
      credError = `保存失败：${(e as Error).message}`
    }
  }
  async function resetBot() {
    if (!selected) return
    try { await api.resetChannel(selected.id) } catch { /* ignore */ }
    allowDraft = ''; allowNote = ''; allowError = ''
    await load()
  }

  /** Parse the comma-separated draft into a validated numeric id list. */
  function parseAllow(text: string): number[] | null {
    const ids = text.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
    if (ids.length === 0) return []
    for (const t of ids) {
      if (!/^\d{1,15}$/.test(t)) return null
    }
    return ids.map(Number)
  }
  async function saveAllow(c: ChannelRow) {
    const parsed = parseAllow(allowDraft)
    if (parsed === null) { allowError = '存在非法 id——必须是纯数字（Telegram 数字 user id）'; return }
    try {
      const res = await api.updateChannel(c.id, { allowUsers: parsed })
      if (res.error) { allowError = res.error; return }
      allowNote = parsed.length === 0 ? '面板名单已清空——恢复使用 config.env 的 ALLOWED_USER_IDS（重启生效）' : `已保存 ${parsed.length} 个用户——重启实例后生效`
      allowError = ''
      allowDraft = ''
      await load()
    } catch (e) {
      allowError = `保存失败：${(e as Error).message}`
    }
  }
  async function clearAllow() {
    allowDraft = ''
    await saveAllow(selected!)
  }
  async function copyLink() {
    if (!pair) return
    try {
      await navigator.clipboard.writeText(pair.url)
      copied = true
      setTimeout(() => (copied = false), 1600)
    } catch { /* clipboard denied */ }
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
</script>

<svelte:window on:keydown={onKey} />

{#if $channelsOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" on:click={close}>
    <button class="backdrop" aria-label="关闭" on:click={close}></button>
    <div class="modal" role="dialog" aria-modal="true" aria-label="机器人与通道" tabindex="-1" on:click|stopPropagation>
      <div class="header">
        <span class="title">🤖 机器人 · 通道</span>
        <button class="close" aria-label="关闭" on:click={close}>✕</button>
      </div>

      <div class="cols">
        <div class="list">
          {#each channels as c (c.id)}
            <button class="ch" class:sel={selected?.id === c.id} on:click={() => select(c.id)}>
              <span class="ch-logo"><ChannelLogo channel={c.channel} size={22} /></span>
              <span class="ch-name">{name(c.channel)}</span>
              <span class="ch-state" class:on={c.enabled}>{c.enabled ? '已启用' : '已停用'}</span>
            </button>
          {/each}
        </div>

        {#if selected}
          <div class="detail">
            <div class="d-hd">
              <span class="d-name">{name(selected.channel)}</span>
              <button
                class="switch" class:on={selected.enabled}
                on:click={() => toggleEnabled(selected)}
                aria-pressed={selected.enabled}
                aria-label="启用通道"
              ><span class="knob"></span></button>
            </div>
            <p class="note">
              {#if selected.channel === 'telegram'}
                {selected.live?.connected ? '轮询运行中' : '未在轮询'}{selected.live?.username ? ` · @${selected.live.username}` : ''}。
                停用/启用在重启实例后生效。<br />
                凭证来源：{tgMeta?.tokenSource === 'panel' ? '面板凭证' : tgMeta?.tokenSource === 'env' ? 'config.env（TELEGRAM_BOT_TOKEN）' : '未配置'}
                {#if selected.hasToken && selected.tokenHint}（面板：{selected.tokenHint}）{/if}
                · 允许用户（生效）：{tgMeta?.allowUsers ?? 0} 个（来源：{tgMeta?.allowSource === 'panel' ? '面板' : 'config.env'}）
                {#if (tgMeta?.allowUsers ?? 0) === 0}——bot 不会回复任何人{/if}
              {:else}
                待接入：凭证保存后，通道本体在后续版本启用。
              {/if}
            </p>

            <div class="sec">
              <div class="sec-label">关联凭证{#if selected.channel === 'telegram'}（保存时向 Telegram 验证）{/if}</div>
              <input class="cred mono" placeholder={selected.channel === 'telegram' ? 'BotFather token（留空保持不变）' : '凭证（预留）'}
                bind:value={tokenDraft} />
              <div class="sec-acts">
                <button class="save" on:click={() => saveCred(selected)}>保存</button>
                {#if credNote}<span class="note">{credNote}</span>{/if}
                {#if credError}<span class="note err">{credError}</span>{/if}
              </div>
            </div>

            {#if selected.channel === 'telegram'}
              <div class="sec">
                <div class="sec-label">允许用户{#if tgMeta?.allowSource === 'panel'}（面板优先于 config.env）{:else}（当前来自 config.env）{/if}</div>
                <input class="cred mono" placeholder="逗号分隔的数字 user id，如 123456789, 987654321"
                  bind:value={allowDraft} />
                <div class="sec-acts">
                  <button class="save" on:click={() => saveAllow(selected)}>保存</button>
                  <button class="save" on:click={clearAllow} title="清空面板名单，恢复 config.env 的 ALLOWED_USER_IDS">恢复 env</button>
                  {#if allowNote}<span class="note">{allowNote}</span>{/if}
                  {#if allowError}<span class="note err">{allowError}</span>{/if}
                </div>
                <p class="note">改动重启实例后生效。数字 id 通过 @userinfobot 等获取；空名单 = bot 不回复任何人。</p>
              </div>
            {/if}

            <div class="sec">
              <div class="sec-label">回复粒度</div>
              <div class="opts">
                <button class="opt" class:sel={selected.replyGranularity === 'standard'}
                  on:click={() => setGranularity(selected, 'standard')}>标准回复（隐藏工具过程）</button>
                <button class="opt" class:sel={selected.replyGranularity === 'detailed'}
                  on:click={() => setGranularity(selected, 'detailed')}>详细回复（显示工具过程）</button>
              </div>
            </div>

            <div class="sec">
              <div class="sec-label">工作区访问范围</div>
              <div class="opts">
                <button class="opt" class:sel={selected.workspaces.mode === 'all'}
                  on:click={() => api.updateChannel(selected.id, { workspaces: { mode: 'all' } }).then(load)}>所有工作区</button>
                <button class="opt" class:sel={selected.workspaces.mode === 'custom'}
                  on:click={() => api.updateChannel(selected.id, { workspaces: { mode: 'custom', dirs: [] } }).then(load)}>自定义</button>
              </div>
              {#if selected.workspaces.mode === 'custom'}
                <p class="hint">自定义白名单已保存——用工作区切换器添加条目后再来这里勾选。</p>
              {/if}
            </div>

            <div class="sec danger">
              <div class="sec-label">重置</div>
              <button class="reset" on:click={resetBot}>恢复默认设置</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="pair">
        {#if pair && !stopped}
          <div class="pair-head">
            <div>
              <div class="pair-title">
                等待手机连接
                {#if remaining !== null}
                  <span class="cd mono" class:expired>{expired ? '已过期' : `· ${countdown}`}</span>
                {/if}
              </div>
              <div class="hint">用手机扫码，或在手机上打开链接。链接 1 分钟内有效，仅可使用一次。</div>
            </div>
            <button class="stop" on:click={stopPairing}>停止</button>
          </div>
          <div class="qr-big" class:dim={expired}>
            <!-- eslint-disable-next-line svelte/no-at-html-tags — server-generated QR SVG -->
            {@html pair.svg}
            {#if expired}
              <div class="qr-expired">
                <span>二维码已过期</span>
                <button class="copy" on:click={loadPair}>刷新二维码</button>
              </div>
            {/if}
          </div>
          <div class="pair-acts">
            <span class="hint">无法扫码？可以在手机上打开链接。</span>
            <span class="spacer"></span>
            <button class="copy" on:click={loadPair}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
              刷新二维码
            </button>
            <button class="copy" on:click={copyLink}>
              {copied ? '✓ 已复制' : '复制链接'}
            </button>
          </div>
        {:else if stopped}
          <div class="pair-stopped">
            <span>已停止配对。</span>
            <button class="copy" on:click={loadPair}>重新开始</button>
          </div>
        {:else}
          <p class="hint">配对信息加载中…</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    border: none;
    padding: 0;
    margin: 0;
    cursor: default;
    animation: ocrc-fade .16s ease backwards;
  }
  .modal {
    position: relative;
    width: min(880px, 94vw);
    max-height: 86vh;
    overflow: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-palette);
    animation: ocrc-pop .16s var(--ease-out, ease-out) backwards;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-2);
  }
  .title { font-family: var(--font-serif); font-size: 16px; font-weight: 600; color: var(--text); }
  .close {
    background: transparent;
    border: none;
    color: var(--text-3);
    font-size: 14px;
    cursor: pointer;
  }
  .cols { display: flex; gap: 14px; padding: 14px 18px; }
  .list {
    width: 170px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ch {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 8px 10px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ch-logo { display: grid; place-items: center; }
  .ch.sel { border-color: var(--accent); background: var(--accent-2); }
  .ch-state { font-size: 10px; color: var(--text-3); }
  .ch-state.on { color: var(--ok, var(--accent)); }
  .detail { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .d-hd { display: flex; align-items: center; justify-content: space-between; }
  .d-name { font-family: var(--font-serif); font-size: 15px; font-weight: 600; color: var(--text); }
  .switch {
    width: 40px; height: 22px;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--bg-input);
    display: grid;
    align-items: center;
    padding: 0 2px;
    cursor: pointer;
  }
  .switch .knob {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: var(--text-3);
    transition: transform .16s ease, background .16s ease;
  }
  .switch.on { border-color: var(--accent); }
  .switch.on .knob { background: var(--accent); transform: translateX(18px); }
  .note { margin: 0; font-size: 11.5px; color: var(--text-3); }
  .note.err { color: var(--err); }
  .sec { border-top: 1px solid var(--border-2); padding-top: 10px; }
  .danger { border-top-color: var(--err); }
  .sec-label { font-size: 11px; color: var(--text-3); margin-bottom: 6px; }
  .cred {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 11px;
  }
  .cred:focus { outline: 1px solid var(--accent); }
  .sec-acts { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .save {
    padding: 4px 12px;
    background: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--accent-ink);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .opts { display: flex; flex-direction: column; gap: 4px; }
  .opt {
    padding: 7px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .opt.sel { border-color: var(--accent); color: var(--text); background: var(--accent-2); }
  .hint { font-size: 10.5px; color: var(--text-3); margin: 4px 0 0; }
  .reset {
    padding: 5px 12px;
    background: transparent;
    border: 1px solid var(--err);
    border-radius: var(--radius-sm);
    color: var(--err);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .pair { border-top: 1px solid var(--border-2); padding: 12px 18px 16px; }
  /* ZCode 手机扫码连接 block: status header (等待手机连接 · countdown + 停止),
     big centered QR on a white card, actions row. */
  .pair-head { display: flex; align-items: flex-start; gap: 10px; justify-content: space-between; }
  .pair-title { font-size: 12.5px; font-weight: 650; color: var(--text); }
  .cd { font-weight: 500; color: var(--text-3); font-size: 11.5px; margin-left: 4px; }
  .cd.expired { color: var(--warn); }
  .stop {
    flex-shrink: 0;
    padding: 4px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .stop:hover { color: var(--err); border-color: var(--err); }
  .qr-big {
    position: relative;
    width: min(200px, 70%);
    margin: 14px auto 12px;
    background: #fff;
    padding: 10px;
    border-radius: var(--radius);
    animation: ocrc-fade 180ms var(--ease-out, ease-out);
  }
  .qr-big :global(svg) { width: 100%; height: auto; display: block; }
  .qr-big.dim :global(svg) { opacity: .18; filter: blur(1px); }
  .qr-expired {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    color: var(--text);
    font-size: 12px; font-weight: 600;
  }
  .pair-acts { display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1; }
  .pair-stopped {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 0 2px;
    color: var(--text-2);
    font-size: 12px;
  }
  .copy {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .copy:hover { border-color: var(--accent); color: var(--text); }
</style>
