<!-- RailFoot.svelte — the left rail's bottom identity/settings row (desktop,
     ZCode register): enso avatar + account | theme toggle, channels button.
     Mobile keeps the titlebar icons (this component isn't rendered there). -->
<script lang="ts">
  import { toggleTheme, channelsOpen, themeMode } from '$lib/stores/ui.js'

  export let email = ''

  $: label = email || 'local'
  $: initial = label.charAt(0).toUpperCase()
</script>

<div class="rail-foot">
  <span class="avatar mono" title={email}>{initial}</span>
  <span class="who" title={email}>{label}</span>
  <span class="sp"></span>
  <button class="fbtn" on:click={toggleTheme} aria-label={`主题：${$themeMode}`} title={`主题：${$themeMode === 'auto' ? '跟随系统' : $themeMode === 'light' ? '浅色' : '深色'}`}>
    {#if $themeMode === 'light'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    {:else if $themeMode === 'dark'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    {:else}
      <!-- auto: half sun / half moon (split circle) — same glyph as the titlebar toggle -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18Z" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2M12 20.5v2M21.2 6.2l-1.7 1M4.5 16.8l-1.7 1M22.5 12h-2M3.5 12h-2M21.2 17.8l-1.7-1M4.5 7.2l-1.7-1"/></svg>
    {/if}
  </button>
  <button class="fbtn" on:click={() => channelsOpen.set(true)} aria-label="机器人与通道" title="机器人与通道">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M8 16h0M16 16h0"/></svg>
  </button>
</div>

<style>
  .rail-foot {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 10px;
    border-top: 1px solid var(--border-2);
    min-width: 0;
  }
  .avatar {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
    color: var(--text-2);
    font-size: 10px;
    font-weight: 700;
  }
  .who {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sp { flex: 0 0 auto; }
  .fbtn {
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    cursor: pointer;
    transition: color .12s ease;
  }
  .fbtn:hover { color: var(--text); background: var(--bg-input); }
  .fbtn svg { width: 14px; height: 14px; }
</style>
