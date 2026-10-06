<!-- src/lib/components/AgentPanel.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import SessionList from './SessionList.svelte'
  import Icon from './Icon.svelte'
  import { paletteOpen } from '$lib/stores/palette.js'
  import { newSessionOpen } from '$lib/stores/ui.js'
  import { openHome } from '$lib/stores/sidePane.js'
  import { api } from '$lib/api/client.js'
  import {
    backends,
    setActiveBackend,
    ACCENTS,
    agentAccent,
    accentOverrides,
    ACCENT_HEX,
    ACCENT_BG,
    ACCENT_LINE,
    setAgentAccent,
    defaultAccentForAgent,
    type Accent,
    type CapabilitiesSnapshot,
  } from '$lib/stores/capabilities.js'
  import { sessionList } from '$lib/stores/sessions.js'
  import { connection } from '$lib/stores/connection.js'
  import { leftPanelOpen, inspectorOpen } from '$lib/stores/ui.js'
  import RailFoot from './RailFoot.svelte'

  export let activeId: string | undefined = undefined
  /** Account identity for the bottom-left rail foot (desktop only). */
  export let email = ''
  /** Build commit — relayed to RailFoot's stale-bundle hover check. */
  export let build = ''
  // Drawer mode (mobile): panel fills the off-canvas drawer.
  export let drawer = false



  $: activeBackendId = $backends?.activeId ?? $backends?.backends[0]?.id ?? 'opencode'
  $: activeAgent = $backends?.backends.find((b) => b.id === activeBackendId)
  $: agents = $backends?.backends ?? []

  function glyphFrom(text: string): string {
    const words = text.split(/[\s\-_:./]+/).filter(Boolean)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return text.slice(0, 2).toUpperCase()
  }
  function glyph(agent?: CapabilitiesSnapshot): string {
    return glyphFrom(agent?.name || agent?.id || 'OC')
  }

  function statusClass(status?: string): string {
    if (status === 'online' || status === 'connected') return 'online'
    if (status === 'connecting' || status === 'reconnecting') return 'connecting'
    if (status === 'offline') return 'offline'
    return 'online'
  }

  // Reactive so the per-agent count refreshes when sessions load/change (a plain
  // function reading $sessionList in the template is NOT tracked by Svelte).
  $: sessionCounts = Object.fromEntries(
    ($backends?.backends ?? []).map((a) => [
      a.id,
      $sessionList.filter((s) => s.backendId === a.id || (!s.backendId && a.id === 'opencode')).length,
    ]),
  ) as Record<string, number>

  /** Mobile switcher row: change the active agent but STAY on the Sessions screen
   *  (the list below re-renders for the new agent), unlike selectAgent which jumps. */
  async function switchAgentOnly(id: string) {
    await setActiveBackend(id)
  }

  const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000
  function isOnline(lastActiveAt: number, conn: string): boolean {
    return conn === 'connected' && Date.now() - lastActiveAt < ACTIVE_WINDOW_MS
  }

  $: activeCount = $sessionList.filter(
    (s) =>
      (s.backendId === activeBackendId || (!s.backendId && activeBackendId === 'opencode')) &&
      isOnline(s.lastActiveAt, $connection),
  ).length
  $: pushedCount = $sessionList.filter(
    (s) =>
      (s.backendId === activeBackendId || (!s.backendId && activeBackendId === 'opencode')) &&
      (s.additions || s.deletions),
  ).length

  // _overrides is taken purely to create a reactive dependency on $accentOverrides,
  // so a swatch change re-themes glyphs/dots instantly (agentAccent reads the store).
  function themeFor(_overrides: Record<string, Accent>, id: string): Accent {
    return agentAccent(id)
  }
  $: activeTheme = themeFor($accentOverrides, activeBackendId)
  $: agentThemes = Object.fromEntries(agents.map((a) => [a.id, themeFor($accentOverrides, a.id)])) as Record<string, Accent>

  // ── rail v2 quick sections (ZCode bottom-nav register): 定时任务 + 远程主机 ──
  let scheduleCount = 0
  let quickTimer: ReturnType<typeof setInterval> | undefined

  async function loadQuick() {
    // Hidden-tab gating (repo perf-pass pattern): counts are cosmetic chrome —
    // don't spend two requests per 60s while the tab is in the background.
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const res = await api.schedules()
      scheduleCount = (res.schedules ?? []).length
    } catch { /* keep last */ }
  }
  onMount(() => {
    void loadQuick()
    quickTimer = setInterval(() => void loadQuick(), 60_000)
    return () => { if (quickTimer) clearInterval(quickTimer) }
  })
</script>

<div class="agent-panel" class:drawer>
  <div class="panel">
    {#if drawer && agents.length > 1}
      <div class="agents-label">Agents</div>
      <div class="switcher-row">
        {#each agents as a (a.id)}
          {@const theme = agentThemes[a.id] ?? agentAccent(a.id)}
          <button class="switch-pill" class:active={a.id === activeBackendId} on:click={() => switchAgentOnly(a.id)}>
            <span class="switch-tile" style="background:{ACCENT_BG[theme]}; color:{ACCENT_HEX[theme]}; border-color:{ACCENT_LINE[theme]}">{glyph(a)}</span>
            <span class="status-dot {statusClass(a.status)}" style="--dot:{ACCENT_HEX[theme]}"><span class="sr-only">{statusClass(a.status)}</span></span>
            <span class="switch-name mono">{a.name ?? a.id}</span>
            <span class="switch-count mono">{(sessionCounts[a.id] ?? 0)}</span>
          </button>
        {/each}
      </div>
    {/if}
    <!-- rail v2 action row (ZCode NewTaskButtonGroup register) -->
    <div class="actions-row">
      <button class="new-session" on:click={() => newSessionOpen.set(true)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        <span>新建会话</span>
      </button>
      {#if !drawer}
        <button class="search-btn" title="搜索（⌘K）" aria-label="搜索会话与命令" on:click={() => paletteOpen.set(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        </button>
        <button class="search-btn" title="收起会话栏 (⌘B)" aria-label="收起会话栏" on:click={() => leftPanelOpen.set(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
      {/if}
    </div>
    {#if drawer}
      <button class="mobile-search" on:click={() => paletteOpen.set(true)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <span>搜索会话与命令</span>
      </button>
    {/if}
    <div class="list">
      <SessionList {activeId} agentId={activeBackendId} agentName={activeAgent?.name ?? activeAgent?.id} />
    </div>
    <!-- rail v2 quick sections: schedules + remotes (ZCode bottom-nav register) -->
    <div class="quick">
      <button class="quick-row" on:click={() => { inspectorOpen.set(true); openHome('schedules') }} title="定时任务">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <span class="q-label">定时任务</span>
        <span class="q-count mono">{scheduleCount}</span>
      </button>
      <!-- 修复#4：远程主机入口移除——唯一入口 = 新建会话 → 远程连接向导 -->
    </div>
    <div class="footer mono">
      <span>{activeCount} 活跃</span>
      <span class="sep">·</span>
      <span>{pushedCount} 已推送</span>
    </div>
    {#if !drawer}
      <RailFoot {build} />
    {/if}
  </div>
</div>

<style>
  .agent-panel {
    display: flex;
    height: 100%;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    flex-shrink: 0;
  }
  .agent-panel.drawer { width: 100%; border-right: none; }
  .panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
  }
  .header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 12px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .glyph-tile {
    width: 24px;
    height: 24px;
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid transparent;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  /* Visually hidden, still read by screen readers (text alternative for status dots). */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /* Online/idle dot follows the agent's own theme color (--dot, set inline per agent),
     falling back to --ok. connecting/offline keep their semantic colors. */
  .status-dot.online {
    background: var(--dot, var(--ok));
    border-color: var(--dot, var(--ok));
  }
  .status-dot.connecting {
    background: var(--warn);
    border-color: var(--warn);
    animation: ocrc-pulse 1.2s ease-in-out infinite;
  }
  .status-dot.offline {
    background: transparent;
    border: 1.5px solid var(--text-4);
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .host {
    font-size: 11px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .collapse {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    cursor: pointer;
    transition: color .12s ease, background .12s ease, border-color .12s ease;
    flex-shrink: 0;
  }
  .collapse:hover { color: var(--text); background: var(--bg-elev); border-color: var(--border); }

  .swatch {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    transition: transform .12s ease, border-color .12s ease;
  }
  .swatch:hover { transform: scale(1.1); }
  .swatch.active { border-color: var(--text); }
  .auto {
    margin-left: auto;
    padding: 3px 9px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
    transition: color .12s ease, border-color .12s ease, background .12s ease;
  }
  .auto:hover, .auto.active { color: var(--text); border-color: var(--accent); background: var(--accent-2); }

  .agents-label {
    padding: 12px 14px 6px;
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .14em;
    color: var(--text-3);
  }
  .mobile-search {
    display: flex; align-items: center; gap: 8px;
    margin: 6px 12px 8px; padding: 10px 12px;
    width: calc(100% - 24px);
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-3); cursor: pointer;
    font-size: 13px; font-family: var(--font-sans); text-align: left;
  }
  .mobile-search:hover { border-color: var(--text-4); }
  .switcher-row {
    display: flex; gap: 7px;
    padding: 10px 12px; overflow-x: auto;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0; scrollbar-width: none;
  }
  .switcher-row::-webkit-scrollbar { display: none; }
  .switch-pill {
    display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
    padding: 5px 10px 5px 5px;
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius-pill); color: var(--text-2); cursor: pointer;
    transition: border-color .12s ease, background .12s ease;
  }
  .switch-pill.active { background: var(--accent-2); border-color: var(--accent); }
  .switch-tile {
    width: 22px; height: 22px; display: inline-grid; place-items: center;
    border-radius: var(--radius-xs); border: 1px solid transparent;
    font-family: var(--font-mono); font-size: 9.5px; font-weight: 700; flex-shrink: 0;
  }
  .switch-name { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; }
  .switch-count {
    font-size: 10px; color: var(--text-3);
    background: var(--bg); border-radius: var(--radius-xs); padding: 1px 6px;
  }

  .list { flex: 1; overflow-y: auto; min-height: 0; }

  /* rail v2: action row + quick sections */
  .actions-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .new-session {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 10px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color .12s ease, color .12s ease, background .12s ease;
  }
  .new-session:hover { border-color: var(--accent); color: var(--text); background: var(--bg-elev2); }
  .search-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    cursor: pointer;
    flex-shrink: 0;
    transition: border-color .12s ease, color .12s ease;
  }
  .search-btn:hover { color: var(--text); border-color: var(--accent); }

  .quick {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 6px 6px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .quick-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: color .12s ease, background .12s ease;
  }
  .quick-row:hover { color: var(--text); background: var(--bg-elev); }
  .q-label { flex: 1; }
  .q-count { font-size: 10px; color: var(--text-4); font-variant-numeric: tabular-nums; }

  .footer {
    display: flex;
    align-items: center;
    gap: 7px;
    /* Full-screen on mobile: keep the text out of the rounded screen corners +
       home indicator — wider side padding and a taller bottom inset. --kb (set
       by the layout's visualViewport tracking) lifts the text above in-browser
       toolbars, which 100vh otherwise hides the footer under. */
    padding: 10px max(20px, env(safe-area-inset-right, 0px)) max(18px, calc(env(safe-area-inset-bottom, 0px) + var(--kb, 0px))) max(20px, env(safe-area-inset-left, 0px));
    font-size: 10px;
    color: var(--text-4);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sep { color: var(--border); }
</style>
