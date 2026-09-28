<!-- src/lib/components/PairGate.svelte — the unauthenticated landing page.
     Owner decision (M12): first-run onboarding shows what ZCode's 移动端远程
     control dialog shows — a LIVE pending QR (left) + bot-channel status
     (right). Hard lines: the QR carries a 5-min single-use pending token
     (never the permanent credential), channel cards are STATUS only
     (credentials/granularity stay behind auth), and a collapsed paste-token
     fallback covers headless hosts. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { submitPairing, exchangePairLink, pairHint } from '../auth.js'
  import { api } from '../api/client.js'
  import ChannelLogo from './ChannelLogo.svelte'

  /** 'pairing' = no/absent token; 'rejected' = the server refused the freshest one. */
  export let status: 'pairing' | 'rejected' = 'pairing'

  let input = ''
  let err = ''
  let showPaste = false

  type Onboarding = {
    url: string
    svg: string
    expiresAt: number
    channels: Array<{ channel: 'telegram' | 'wechat' | 'lark'; enabled: boolean; live: { connected: boolean; username?: string } | null }>
    host: { hostname: string; platform: string; arch: string }
  }
  let onb: Onboarding | null = null
  let now = Date.now()
  let copied = false
  let timer: ReturnType<typeof setInterval> | undefined

  $: remaining = onb?.expiresAt ? Math.max(0, onb.expiresAt - now) : null
  $: expired = remaining !== null && remaining <= 0
  $: countdown = remaining === null ? '' : `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`

  async function loadPair() {
    try {
      onb = await api.pairOnboarding()
      now = Date.now()
    } catch { onb = null }
  }

  const CHANNEL_META: Record<string, { name: string; note: string }> = {
    telegram: { name: 'Telegram', note: '从 Telegram 打开这台机器' },
    wechat: { name: '微信', note: '待接入（配置面板已预埋）' },
    lark: { name: '飞书 / Lark', note: '待接入（配置面板已预埋）' },
  }

  onMount(() => {
    void loadPair()
    timer = setInterval(() => {
      now = Date.now()
      // Keep the window evergreen: refresh an expired QR automatically.
      if (expired) void loadPair()
    }, 1000)
  })
  onDestroy(() => { if (timer) clearInterval(timer) })

  async function copyLink() {
    if (!onb) return
    try {
      await navigator.clipboard.writeText(onb.url)
      copied = true
      setTimeout(() => (copied = false), 1600)
    } catch { /* clipboard denied */ }
  }

  // Accept a raw token, a "?token=…" / "#token=…" string, or a full pairing URL.
  function parseToken(s: string): string {
    const t = s.trim()
    const m = t.match(/token=([^&#\s]+)/)
    return m ? decodeURIComponent(m[1]) : t
  }

  async function connect() {
    err = ''
    // A #pair= link (pending token) must be EXCHANGED for the real token.
    if (/[?#]pair=/.test(input)) {
      err = await exchangePairLink(input)
      return
    }
    const token = parseToken(input)
    if (!token || token.length < 16) { err = '这看起来不是有效的令牌。'; return }
    if (!submitPairing(token)) err = '这看起来不是有效的令牌。'
  }
</script>

<div class="gate">
  <div class="panel">
    <div class="head">
      <span class="hicon" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none" stroke-width="6" stroke-linecap="round">
          <path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)" opacity=".85" />
          <circle cx="49" cy="20" r="7" fill="var(--accent)" stroke="none" />
        </svg>
      </span>
      <div>
        <h1>配对 ocrc 远程控制</h1>
        <p class="sub">扫码或在手机上打开链接，即可远程控制这台机器的 opencode。</p>
      </div>
    </div>

    {#if $pairHint}
      <p class="rejected">{$pairHint}</p>
    {:else if status === 'rejected'}
      <p class="rejected">上一次的令牌被服务器拒绝了——请在下方重新配对。</p>
    {/if}

    <div class="cols">
      <section class="scan">
        <div class="sec-head">
          <span class="sec-title">📱 手机扫码连接</span>
          {#if onb}<span class="chip mono">{onb.host.hostname} · {onb.host.arch}</span>{/if}
        </div>
        <p class="sub">用手机相机扫码，在手机上打开这台机器。</p>
        {#if onb}
          <div class="wait-row">
            <span class="wait">等待手机连接 {#if remaining !== null}<span class="mono cd" class:expired>{expired ? '二维码已过期' : `· ${countdown}`}</span>{/if}</span>
          </div>
          <div class="qr-wrap">
            <!-- eslint-disable-next-line svelte/no-at-html-tags — server-generated QR SVG -->
            {@html onb.svg}
            {#if expired}
              <div class="qr-re">
                <span>已过期</span>
                <button class="btn" on:click={loadPair}>刷新二维码</button>
              </div>
            {/if}
          </div>
          <div class="acts">
            <span class="hint">无法扫码？在手机上打开链接。</span>
            <span class="spacer"></span>
            <button class="btn" on:click={loadPair}>⟳ 刷新二维码</button>
            <button class="btn" on:click={copyLink}>{copied ? '✓ 已复制' : '复制链接'}</button>
          </div>
          <p class="hint dim">二维码 5 分钟内有效、仅可使用一次；刷新会作废旧码。配对成功后本页自动进入面板。</p>
        {:else}
          <p class="hint dim">配对信息加载中…（若宿主机未启用配对组件，请用下方令牌粘贴）</p>
        {/if}
      </section>

      <section class="channels">
        <div class="sec-head"><span class="sec-title">🤖 Bot 通道</span></div>
        <p class="sub">连接聊天 Bot，适合更长时间的移动端访问。</p>
        {#if onb}
          {#each onb.channels as ch (ch.channel)}
            <div class="ch">
              <span class="ch-icon" aria-hidden="true"><ChannelLogo channel={ch.channel} size={30} /></span>
              <div class="ch-body">
                <div class="ch-name">
                  {CHANNEL_META[ch.channel]?.name ?? ch.channel}
                  {#if ch.channel === 'telegram' && ch.live?.connected}
                    <span class="ok">已连接 @{ch.live.username}</span>
                  {:else if ch.channel === 'telegram'}
                    <span class="off">未连接</span>
                  {:else}
                    <span class="off">待接入</span>
                  {/if}
                </div>
                <div class="ch-note">{CHANNEL_META[ch.channel]?.note ?? ''}</div>
              </div>
            </div>
          {/each}
          <p class="hint dim">通道凭证与回复粒度等管理功能，在配对后的「机器人管理」面板中。</p>
        {:else}
          <p class="hint dim">…</p>
        {/if}
      </section>
    </div>

    <details class="paste" bind:open={showPaste}>
      <summary>已有配对链接或令牌？</summary>
      <div class="paste-body">
        <input
          class="field mono"
          bind:value={input}
          placeholder="粘贴配对链接或令牌…"
          aria-label="配对令牌或链接"
          autocapitalize="off" autocorrect="off" spellcheck="false"
          on:keydown={(e) => e.key === 'Enter' && connect()}
        />
        {#if err}<div class="err">{err}</div>{/if}
        <button class="connect" on:click={connect} disabled={!input.trim()}>连接</button>
      </div>
    </details>

    <p class="hint dim foot">令牌只保存在本设备上 · Telegram 通道为可选，未配置时仅 Web 面板可用</p>
  </div>
</div>

<style>
  .gate {
    position: fixed; inset: 0; z-index: var(--z-gate);
    display: flex; align-items: center; justify-content: center;
    background: var(--bg);
    padding: 24px;
    padding-top: calc(24px + env(safe-area-inset-top, 0px));
    padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
  }
  .panel {
    width: min(1060px, 100%);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 22px 26px;
    display: flex; flex-direction: column; gap: 14px;
    animation: ocrc-pop var(--dur-enter, 200ms) var(--ease-out, ease-out) backwards;
  }
  .head { display: flex; gap: 14px; align-items: center; }
  .hicon {
    width: 52px; height: 52px; flex-shrink: 0;
    display: grid; place-items: center;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
  }
  .hicon svg { width: 34px; height: 34px; display: block; }
  h1 { margin: 0; font-size: 17px; color: var(--text); font-weight: 700; }
  .sub { margin: 2px 0 0; font-size: 12.5px; color: var(--text-2); }

  .cols { display: grid; grid-template-columns: 1.25fr 1fr; gap: 16px; }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }

  .scan, .channels {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .sec-head { display: flex; align-items: center; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
  .sec-title { font-size: 13px; font-weight: 650; color: var(--text); }
  .chip {
    font-size: 10.5px; color: var(--text-2);
    background: var(--bg-elev); border: 1px solid var(--border);
    padding: 2px 8px; border-radius: var(--radius-pill);
  }
  .wait-row { display: flex; align-items: center; }
  .wait { font-size: 12px; color: var(--text); font-weight: 600; }
  .cd { font-weight: 500; color: var(--text-3); }
  .cd.expired { color: var(--warn); }

  .qr-wrap {
    position: relative;
    width: min(230px, 80%);
    margin: 4px auto;
    background: #fff;
    padding: 12px;
    border-radius: var(--radius);
    border: 1px dashed var(--border-2);
  }
  .qr-wrap :global(svg) { width: 100%; height: auto; display: block; }
  .qr-wrap.dim :global(svg) { opacity: .15; }
  .qr-re {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    color: var(--text); font-size: 12.5px; font-weight: 600;
  }

  .acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 6px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit; font-size: 12px;
    cursor: pointer;
  }
  .btn:hover { border-color: var(--accent); color: var(--text); }

  .ch {
    display: flex; gap: 12px; align-items: flex-start;
    padding: 10px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .ch-icon { display: grid; place-items: center; flex-shrink: 0; }
  .ch-name { font-size: 12.5px; font-weight: 650; color: var(--text); display: flex; gap: 8px; align-items: baseline; }
  .ok { font-size: 10.5px; color: var(--ok, #2e9e6b); font-weight: 600; }
  .off { font-size: 10.5px; color: var(--text-3); font-weight: 500; }
  .ch-note { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }

  .hint { font-size: 11.5px; color: var(--text-3); margin: 0; line-height: 1.5; }
  .dim { color: var(--text-3); }
  .rejected { margin: 0; font-size: 12.5px; color: var(--err); }

  .paste { border-top: 1px solid var(--border-2); padding-top: 10px; }
  .paste summary { cursor: pointer; font-size: 12px; color: var(--text-2); }
  .paste-body { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; }
  .field {
    padding: 9px 11px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text);
    font-size: 12.5px;
  }
  .field:focus { outline: none; border-color: var(--accent-line); }
  .err { font-size: 12px; color: var(--err); }
  .connect {
    align-self: flex-start;
    padding: 8px 18px;
    background: var(--accent); border: 1px solid var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-sm);
    font: inherit; font-size: 12.5px; font-weight: 600;
    cursor: pointer;
  }
  .connect:disabled { opacity: .45; cursor: default; }
  .foot { border-top: 1px solid var(--border-2); padding-top: 10px; }
</style>
