<!-- src/lib/components/ChannelsModal.svelte — M9 bot-channels management,
     modelled on the ZCode 机器人管理 dialog: channel list (Telegram/微信/Lark)
     on the left, per-channel detail (enable switch, credentials, reply
     granularity, workspace scope, reset) on the right. Settings persist to
     ~/.ocrc/channels.json via /api/channels. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type ChannelRow } from '$lib/api/client.js'
  import { channelsOpen } from '$lib/stores/ui.js'

  let channels: ChannelRow[] = []
  let selectedId: string | undefined
  let pair: { url: string; svg: string } | null = null
  let tokenDraft = ''
  let credNote = ''
  let workspaceDirs: string[] = []

  $: selected = channels.find((c) => c.id === selectedId) ?? channels[0]

  async function load() {
    try {
      channels = (await api.channels()).channels ?? []
      if (!selectedId && channels.length > 0) selectedId = channels[0].id
    } catch { /* keep */ }
  }
  async function loadPair() {
    try { pair = await api.pairQr() } catch { pair = null }
  }
  onMount(() => {
    void load()
    void loadPair()
  })

  function name(channel: string): string {
    return channel === 'telegram' ? 'Telegram' : channel === 'wechat' ? '微信' : channel === 'lark' ? 'Lark' : channel
  }
  function close() { channelsOpen.set(false) }
  function select(id: string) { selectedId = id; tokenDraft = ''; credNote = '' }
  async function toggleEnabled(c: ChannelRow) {
    channels = channels.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x))
    try { await api.updateChannel(c.id, { enabled: !c.enabled }) } catch { /* ignore */ }
  }
  async function setGranularity(c: ChannelRow, g: 'standard' | 'detailed') {
    channels = channels.map((x) => (x.id === c.id ? { ...x, replyGranularity: g } : x))
    try { await api.updateChannel(c.id, { replyGranularity: g }) } catch { /* ignore */ }
  }
  async function saveCred(c: ChannelRow) {
    if (!tokenDraft.trim()) { credNote = '请输入凭证内容'; return }
    try { await api.updateChannel(c.id, { credentials: { token: tokenDraft.trim() } }); credNote = '已保存——重启实例后生效'; tokenDraft = '' }
    catch { credNote = '保存失败' }
  }
  async function resetBot() {
    if (!selected) return
    try { await api.resetChannel(selected.id) } catch { /* ignore */ }
    await load()
  }
  async function copyLink() {
    if (!pair) return
    try { await navigator.clipboard.writeText(pair.url) } catch { /* clipboard denied */ }
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
                停用/启用在重启实例后生效。
              {:else}
                待接入：凭证保存后，通道本体在后续版本启用。
              {/if}
            </p>

            <div class="sec">
              <div class="sec-label">关联凭证</div>
              <input class="cred mono" placeholder={selected.channel === 'telegram' ? 'BotFather token（留空保持不变）' : '凭证（预留）'}
                bind:value={tokenDraft} />
              <div class="sec-acts">
                <button class="save" on:click={() => saveCred(selected)}>保存</button>
                {#if credNote}<span class="note">{credNote}</span>{/if}
              </div>
            </div>

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
        <div class="sec-label">配对新设备</div>
        {#if pair}
          <div class="pair-row">
            <!-- eslint-disable-next-line svelte/no-at-html-tags — server-generated QR SVG -->
            <div class="qr">{@html pair.svg}</div>
            <div class="pair-acts">
              <input class="pair-url mono" readonly value={pair.url} />
              <button class="copy" on:click={copyLink}>复制链接</button>
              <button class="copy" on:click={loadPair}>刷新二维码</button>
            </div>
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
    gap: 2px;
    padding: 8px 10px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
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
  .pair-row { display: flex; gap: 14px; align-items: flex-start; margin-top: 8px; }
  .qr { width: 128px; flex-shrink: 0; background: #fff; padding: 6px; border-radius: var(--radius-sm); }
  .qr :global(svg) { width: 100%; height: auto; display: block; }
  .pair-acts { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
  .pair-url {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: 10.5px;
  }
  .copy {
    padding: 5px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: left;
  }
  .copy:hover { border-color: var(--accent); color: var(--text); }
</style>
