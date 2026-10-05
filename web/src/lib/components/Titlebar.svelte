<script lang="ts">
  import { connection, latency } from '$lib/stores/connection.js'
  import { plusMenuOpen, themeMode, toggleTheme, channelsOpen } from '$lib/stores/ui.js'
  import Icon from '$lib/components/Icon.svelte'

  export let email = ''
  /** Build commit of the served bundle — hover the user chip to self-verify
   *  which UI version the tab is actually running (SW-staleness check). */
  export let build = ''
  export let onPalette: () => void
  export let installEvent: any = null
  export let onInstall: () => void = () => {}
  export let drawerLeft = false
  export let drawerRight = false
  export let onToggleLeft: () => void = () => {}
  export let onToggleRight: () => void = () => {}
  export let newButtonAnchor: HTMLElement | null = null

  $: userLabel = email || 'you@local'
  $: userInitial = userLabel.charAt(0).toUpperCase()

  function statusText(status: string): string {
    if (status === 'connected') return 'live'
    if (status === 'reconnecting') return 'reconnecting'
    return 'offline'
  }
</script>

<header class="titlebar">
  <!-- Mobile session drawer toggle -->
  <button class="iconbtn" class:active={drawerLeft} on:click={onToggleLeft} aria-label="Sessions"><Icon name="menu" size={18} /></button>

  <!-- Brand mark + wordmark — "enso" mark: ink brush ring + persimmon dot;
       both elements track the theme (ring = --text, dot = --accent). -->
  <div class="brand" title="ocrc">
    <svg class="brand-mark" viewBox="0 0 64 64" fill="none" stroke-width="8" stroke-linecap="round" aria-hidden="true">
      <path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)"/>
      <circle cx="49" cy="20" r="6" fill="var(--accent)" stroke="none"/>
    </svg>
    <span class="wordmark"><b>ocrc</b></span>
  </div>

  <!-- New actions menu -->
  <button class="new-session" bind:this={newButtonAnchor} on:click={() => plusMenuOpen.update((v) => !v)} title="新建会话、命令面板…">
    <span class="new-icon" aria-hidden="true">+</span>
    <span class="new-label">新建</span>
    <span class="new-caret" aria-hidden="true"><Icon name="caret-down" size={9} /></span>
  </button>

  <!-- Command palette trigger -->
  <button class="palette-trigger" on:click={onPalette} title="搜索会话与命令 (⌘K)">
    <span class="palette-icon" aria-hidden="true"><Icon name="search" size={14} /></span>
    <span class="palette-label">搜索会话与命令…</span>
    <kbd class="palette-keycap mono">⌘K</kbd>
  </button>

  <span class="spacer"></span>
  <!-- M9 机器人/通道配置入口 -->
  <button class="themebtn channels-btn" title="机器人与通道" aria-label="机器人与通道" on:click={() => channelsOpen.set(true)}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M8 16h0M16 16h0"/></svg>
  </button>

  <!-- Theme toggle — light/dark with system-follow default (paper-ink) -->
  <button class="themebtn theme-btn" on:click={toggleTheme}
          title={$themeMode === 'auto' ? '主题：跟随系统' : $themeMode === 'light' ? '主题：浅色' : '主题：深色'}
          aria-label="Toggle color theme">
    {#if $themeMode === 'light'}<Icon name="sun" size={15} />
    {:else if $themeMode === 'dark'}<Icon name="moon" size={15} />
    {:else}<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><!-- auto: half sun / half moon (split circle) --><path d="M12 3a9 9 0 1 0 0 18Z" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2M12 20.5v2M21.2 6.2l-1.7 1M4.5 16.8l-1.7 1M22.5 12h-2M3.5 12h-2M21.2 17.8l-1.7-1M4.5 7.2l-1.7-1"/></svg>{/if}
  </button>

  <!-- Connection pill -->
  <span class="connection-pill {$connection}" title="WebSocket: {statusText($connection)}">
    <span class="dot-wrap" aria-hidden="true">
      <span class="dot"></span>
      {#if $connection === 'connected'}<span class="dot-ring"></span>{/if}
    </span>
    <span class="connection-state">{statusText($connection)}</span>
    {#if $connection === 'connected'}<span class="connection-latency mono">{$latency}ms</span>{/if}
  </span>

  {#if installEvent}<button class="install" on:click={onInstall}>Install</button>{/if}

  <!-- Mobile inspector drawer toggle (design: a list/lines glyph, not an info dot) -->
  <button class="iconbtn" class:active={drawerRight} on:click={onToggleRight} aria-label="Inspector">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>
  </button>

  <!-- User -->
  <div class="user" title={build ? `UI build ${build}` : undefined}>
    <span class="user-email mono">{userLabel}</span>
    <span class="avatar mono" aria-hidden="true">{userInitial}</span>
  </div>
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: calc(52px + env(safe-area-inset-top, 0px));
    padding: env(safe-area-inset-top, 0px) 16px 0;
    box-sizing: border-box;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
    flex-shrink: 0;
    font-size: 13px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .brand-mark {
    width: 27px;
    height: 27px;
    flex-shrink: 0;
  }
  .wordmark {
    font-family: var(--font-serif);
    font-size: 15.5px;
    letter-spacing: .01em;
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
  }
  .wordmark b { font-weight: 700; color: var(--text); }

  .new-session {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-pill);
    padding: 5px 11px;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity .12s ease, transform .12s ease;
  }
  .new-session:hover:not(:disabled) { opacity: .9; }
  .new-session:disabled { opacity: .5; cursor: default; }
  .new-icon { font-size: 14px; line-height: 1; }
  .new-label { white-space: nowrap; }
  .new-caret { font-size: 9px; line-height: 1; margin-left: 2px; opacity: .85; }

  .palette-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 230px;
    max-width: min(340px, calc(100vw - 32px));
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-3);
    padding: 5px 10px;
    font-size: 12.5px;
    cursor: text;
    transition: border-color .15s ease, color .15s ease;
  }
  .palette-trigger:hover { border-color: var(--text-3); color: var(--text-2); }
  .palette-icon { font-size: 14px; opacity: .85; }
  .palette-label { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .palette-keycap {
    font-size: 10px;
    color: var(--text-3);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 2px 5px;
  }

  .spacer { flex: 1; }

  /* Theme toggle — ghost button, visible on every screen that shows the titlebar. */
  .themebtn {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-2);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    transition: color .12s ease, border-color .12s ease;
  }
  .themebtn:hover { color: var(--text); border-color: var(--text-4); }

  .connection-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border-radius: var(--radius-pill);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    padding: 4px 10px;
    flex-shrink: 0;
  }
  .dot-wrap {
    position: relative;
    width: 10px;
    height: 10px;
    display: grid;
    place-items: center;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-4);
    flex-shrink: 0;
  }
  .dot-ring {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--ok);
    opacity: 0;
    animation: ocrc-ring 1.6s ease-out infinite;
    pointer-events: none;
  }
  /* 'live' pill stays semantic green (connection health), NOT themed — by request. */
  .connection-pill.connected .dot { background: var(--ok); box-shadow: 0 0 7px var(--ok); }
  .connection-pill.reconnecting .dot { background: var(--warn); animation: ocrc-pulse 1.2s ease-in-out infinite; }
  .connection-pill.offline .dot { background: transparent; border: 1.5px solid var(--text-4); }
  .connection-state { font-weight: 600; color: var(--text-3); }
  .connection-pill.connected .connection-state { color: var(--ok); }
  .connection-pill.reconnecting .connection-state { color: var(--warn); }
  .connection-pill.offline .connection-state { color: var(--err); }
  .connection-latency { color: var(--text-3); font-size: 10.5px; }

  .install {
    background: var(--accent);
    color: var(--accent-ink);
    border: none;
    border-radius: var(--radius-pill);
    padding: 4px 12px;
    font-size: 0.8em;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }

  .user {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .user-email {
    color: var(--text-3);
    font-size: 12px;
  }
  .avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-2);
    color: var(--accent);
    border: 1px solid var(--accent-line);
    font-size: 11px;
    font-weight: 700;
  }

  /* Drawer toggles — desktop hidden, shown on mobile. */
  .iconbtn {
    display: none;
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 18px;
    line-height: 1;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: var(--radius-pill);
  }
  .iconbtn:hover { color: var(--text); background: var(--bg-elev); }
  .iconbtn.active { color: var(--accent); background: var(--accent-2); }

  /* B6 touch-target pass: keep visual size, widen the hit box on touch screens */
  @media (pointer: coarse) {
    .themebtn { width: 36px; height: 36px; }
  }

  @media (max-width: 820px) {
    /* The titlebar only renders on the mobile Sessions screen now (the chat screen has
       its own header), so it's just brand + live — drawer toggles, new, palette, and the
       user avatar all move to the FAB / chat header / sessions panel. */
    .palette-trigger, .user-email, .new-session, .new-label, .iconbtn, .user { display: none; }
  }
  /* Desktop: identity / theme / channels live in the left rail's bottom foot
     (ZCode register); the titlebar keeps brand / new / palette / connection. */
  @media (min-width: 821px) {
    .channels-btn, .theme-btn, .user { display: none; }
  }
</style>
