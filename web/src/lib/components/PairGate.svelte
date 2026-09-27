<!-- src/lib/components/PairGate.svelte -->
<!--
  Shown when the app has no (valid) token. On iOS a home-screen PWA gets its own
  storage container (not shared with Safari) and is launched at the manifest
  start_url ("/", no token), so the token can't ride in via the URL — the user
  pairs *inside* the installed app by pasting the token/link from /pair.
-->
<script lang="ts">
  import { submitPairing } from '../auth.js'

  /** 'pairing' = no/absent token; 'rejected' = the server refused the freshest one. */
  export let status: 'pairing' | 'rejected' = 'pairing'

  let input = ''
  let err = ''

  // Accept a raw token, a "?token=…" / "#token=…" string, or a full pairing URL.
  function parseToken(s: string): string {
    const t = s.trim()
    const m = t.match(/token=([^&#\s]+)/)
    return m ? decodeURIComponent(m[1]) : t
  }

  function connect() {
    const token = parseToken(input)
    if (!token || token.length < 16) { err = '这看起来不是有效的令牌。'; return }
    // Persist + flip the auth store. No reload: the layout boots the API/WS
    // connection reactively, and both clients read the token fresh per
    // request/connect, so the next call already carries it.
    if (!submitPairing(token)) err = '这看起来不是有效的令牌。'
  }
</script>

<div class="gate">
  <div class="card">
    <div class="brand"><b>ocrc</b></div>
    <h1>配对此设备</h1>
    {#if status === 'rejected'}
      <p class="rejected">上一次的令牌被服务器拒绝了——请在下方重新配对。</p>
    {/if}
    <p>
      In Telegram, send <code>/pair</code> to your bot, then paste the
      <strong>token</strong> (or the whole link) below.
    </p>
    <input
      class="field mono"
      bind:value={input}
      placeholder="粘贴配对令牌或链接…"
      aria-label="配对令牌或链接"
      autocapitalize="off" autocorrect="off" spellcheck="false"
      on:keydown={(e) => e.key === 'Enter' && connect()}
    />
    {#if err}<div class="err">{err}</div>{/if}
    <button class="connect" on:click={connect} disabled={!input.trim()}>连接</button>
    <p class="hint">令牌只保存在本设备上。</p>
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
  }
  .card {
    width: 100%; max-width: 360px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .brand { font-weight: 800; color: var(--accent); letter-spacing: .1em; font-size: 15px; }
  h1 { margin: 0; font-size: 20px; color: var(--text); font-weight: 700; }
  p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--text-2); }
  code { background: var(--bg-elev); padding: 1px 6px; border-radius: var(--radius-sm); color: var(--accent); font-size: 0.92em; }
  .field {
    width: 100%; box-sizing: border-box;
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text);
    padding: 12px 14px; font-size: 16px; outline: none;
  }
  .field:focus { border-color: var(--accent); }
  .err { color: var(--err); font-size: 12px; }
  .rejected { color: var(--err); font-size: 12.5px; font-weight: 600; }
  .connect {
    background: var(--accent); color: var(--accent-ink);
    border: none; border-radius: var(--radius-sm);
    padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  .connect:disabled { opacity: .5; cursor: default; }
  .hint { font-size: 11px; color: var(--text-3); }
</style>
