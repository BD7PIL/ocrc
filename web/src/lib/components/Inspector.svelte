<!-- Inspector.svelte — the right pane: ZCode workspaceSidePane register.
     NOTHING is pinned. Every tab is a closable dynamic page opened from
     context (PlanHud rows → subagents, transcript tool rows → outputs/files)
     or from the "+" menu listing the five well-known homes. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sessionList, feeds } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import { inspectorOpen, inspectorClosedAt } from '$lib/stores/ui.js'
  import { api } from '$lib/api/client.js'
  import SideChatTab from './inspector/SideChatTab.svelte'
  import {
    sidePane, closePaneTab, reorderPaneTab, openHome, HOMES,
  } from '$lib/stores/sidePane.js'
  import TaskPanel from './inspector/TaskPanel.svelte'
  import McpPanel from './inspector/McpPanel.svelte'
  import Icon from './Icon.svelte'
  import SchedulesPanel from './inspector/SchedulesPanel.svelte'
  import RemotesPanel from './inspector/RemotesPanel.svelte'
  import SkillsPanel from './inspector/SkillsPanel.svelte'
  import FilesPanel from './inspector/FilesPanel.svelte'
  import WorktreesPanel from './inspector/WorktreesPanel.svelte'
  import SubagentsPanel from './inspector/SubagentsPanel.svelte'
  import SubagentSessionTab from './inspector/SubagentSessionTab.svelte'
  import FileViewerTab from './inspector/FileViewerTab.svelte'
  import ToolOutputTab from './inspector/ToolOutputTab.svelte'
  import GitTab from './inspector/GitTab.svelte'
  import { summarizeTodos, type TodoSummary } from '$lib/inspector/summarizeTodos.js'
  export let sessionId: string | undefined = undefined

  $: session = $sessionList.find((s) => s.id === sessionId)

  // Debounced "activity tick": bump ~1s after the feed's lastSeq changes so
  // panels refetch when a turn produces output, without hammering per delta.
  let tick = 0
  let lastSeen = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  $: seq = sessionId ? ($feeds[sessionId]?.lastSeq ?? 0) : 0
  // Background tabs skip the tick fan-out (each tick = todo/subagents/context
  // round trips); returning to the tab refreshes once.
  $: if (seq !== lastSeen) {
    lastSeen = seq
    clearTimeout(timer)
    if (typeof document === 'undefined' || !document.hidden) {
      timer = setTimeout(() => (tick += 1), 1000)
    }
  }
  function onVisible() { if (!document.hidden) tick += 1 }
  onDestroy(() => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) })

  $: activeId = $sidePane.activeId
  $: activeTab = $sidePane.tabs.find((t) => t.id === activeId)
  $: activeIndex = $sidePane.tabs.findIndex((t) => t.id === activeId)


  // ── Drag reorder (D1) ──
  let dragFrom = -1
  function onDragStart(i: number) { dragFrom = i }
  function onDrop(i: number) {
    if (dragFrom !== -1) reorderPaneTab(dragFrom, i)
    dragFrom = -1
  }

  // ── "+" menu ──
  let plusOpen = false
  let plusEl: HTMLElement
  function onWindowClick(e: MouseEvent) { if (plusOpen && plusEl && !plusEl.contains(e.target as Node)) plusOpen = false }
  function onWindowKey(e: KeyboardEvent) { if (e.key === 'Escape') { plusOpen = false; tabsMenu = false } }
  let tabsMenu = false
  let tabMenuFor: string | undefined
  let tabMenuXY = { x: 0, y: 0 }
  let sideChatBusy = false
  async function openSideChat() {
    if (sideChatBusy) return
    sideChatBusy = true
    plusOpen = false
    try {
      const directory = session?.directory ?? ''
      const created = await api.createSession({ directory, title: '辅助对话' })
      const id = created.id
      if (id) {
        sidePane.openPaneTab({ id: `sidechat:${id}`, kind: 'sidechat', title: '辅助对话', childId: id })
      }
    } catch { /* best effort */ } finally { sideChatBusy = false }
  }
  const TAB_ICONS: Record<string, string> = {
    home: 'gear', // overridden per homeId below
  }
  function tabIcon(t: { kind: string; homeId?: string }): string {
    if (t.kind === 'home') {
      switch (t.homeId) {
        case 'tasks': return 'tasks'
        case 'files': return 'files'
        case 'subs': return 'bot'
        case 'skills': return 'skill'
        case 'schedules': return 'clock'
        case 'mcp': return 'plug'
        case 'remotes': return 'cloud'
      }
      return 'gear'
    }
    if (t.kind === 'git') return 'git'
    if (t.kind === 'sidechat') return 'chat'
    if (t.kind === 'tool') return 'terminal'
    if (t.kind === 'file') return 'files'
    return 'cpu'
  }
  function closeOthers() {
    const keep = $sidePane.activeId
    for (const t of $sidePane.tabs) if (t.id !== keep) closePaneTab(t.id)
  }
  function closeAll() {
    for (const t of $sidePane.tabs) closePaneTab(t.id)
  }

  // Task summary for the tab badge (done/total), same data plane as the HUD.
  let sum: TodoSummary = { total: 0, done: 0, items: [] }
  let loadedFor: string | undefined
  async function refresh(sid: string | undefined) {
    if (!sid) return
    try {
      const todos = await api.todo(sid)
      if (sid !== sessionId) return
      loadedFor = sid
      sum = summarizeTodos(todos)
    } catch { /* keep last valid summary */ }
  }
  let loadedSid: string | undefined
  $: if (sessionId !== loadedSid) { loadedSid = sessionId; void refresh(sessionId) }
  $: if (tick) { void refresh(sessionId) }

  const homeBadge = (homeId: string) => homeId === 'tasks' && sum.total > 0 ? `${sum.done}/${sum.total}` : ''
</script>

<svelte:window on:click={onWindowClick} on:keydown={onWindowKey} />

<aside class="inspector">
  <div class="tabs" role="tablist">
    {#each $sidePane.tabs as t, i (t.id)}
      <button
        class="tab"
        class:active={activeId === t.id}
        role="tab"
        aria-selected={activeId === t.id}
        draggable="true"
        title={t.kind === 'file' ? t.path : t.title}
        on:click={() => sidePane.activatePane(t.id)}
        on:dragstart={() => onDragStart(i)}
        on:dragover|preventDefault={() => {}}
        on:drop={() => onDrop(i)}
        on:auxclick|preventDefault={(e) => { if (e.button === 1) closePaneTab(t.id) }}
        on:contextmenu|preventDefault={(e) => { tabMenuFor = t.id; tabMenuXY = { x: e.clientX, y: e.clientY } }}
      >
        <span class="tico" aria-hidden="true"><Icon name={tabIcon(t)} size={12} /></span>
        <span class="dlabel">{t.title}</span>
        {#if t.kind === 'home' && t.homeId === 'tasks' && sum.total > 0}<span class="tbadge mono">{sum.done}/{sum.total}</span>{/if}
        <span
          class="closer"
          role="button"
          tabindex="-1"
          aria-label={`关闭 ${t.title}`}
          on:click|stopPropagation={() => closePaneTab(t.id)}
          on:keydown|stopPropagation={(e) => e.key === 'Enter' && closePaneTab(t.id)}
        >✕</span>
      </button>
    {/each}
    {#if tabMenuFor}
      <div class="tab-ctx" role="menu" style="left:{tabMenuXY.x - 40}px; top:{tabMenuXY.y + 8}px">
        <button role="menuitem" on:click={() => { const id = tabMenuFor; tabMenuFor = undefined; if (id) closePaneTab(id) }}>关闭标签</button>
        <button role="menuitem" on:click={() => { tabMenuFor = undefined; closeOthers() }}>关闭其他标签</button>
        <button role="menuitem" on:click={() => { tabMenuFor = undefined; closeAll() }}>关闭所有标签</button>
      </div>
    {/if}
    {#if $sidePane.tabs.length > 1}
      <button class="tabs-more" title="页签操作" aria-label="页签操作" on:click={() => (tabsMenu = !tabsMenu)}>⋯</button>
      {#if tabsMenu}
        <div class="tabs-menu" role="menu">
          <button role="menuitem" on:click={() => { closeOthers(); tabsMenu = false }}>关闭其他</button>
          <button role="menuitem" on:click={() => { closeAll(); tabsMenu = false }}>关闭全部</button>
        </div>
      {/if}
    {/if}
    <div class="plus" bind:this={plusEl}>
      <button class="plus-btn" aria-label="打开面板" title="打开面板" on:click={() => (plusOpen = !plusOpen)}>+</button>
      {#if plusOpen}
        <div class="plus-menu" role="menu">
          <button role="menuitem" disabled={sideChatBusy} on:click={openSideChat}>辅助对话</button>
          <div class="menu-sep"></div>
          {#each HOMES as h (h.homeId)}
            <button role="menuitem" on:click={() => { openHome(h.homeId); plusOpen = false }}>
              {h.title}{#if homeBadge(h.homeId)}<span class="tbadge mono">{homeBadge(h.homeId)}</span>{/if}
            </button>
          {/each}
          <div class="menu-sep"></div>
          <button role="menuitem" on:click={() => { sidePane.openPaneTab({ id: 'git', kind: 'git', title: 'Git' }); plusOpen = false }}>Git</button>
        </div>
      {/if}
    </div>
    <button class="collapse-btn" title="收起面板" aria-label="收起面板" on:click={() => { inspectorClosedAt.set(Date.now()); inspectorOpen.set(false) }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M9 9l3 3-3 3"/></svg>
    </button>
  </div>

  <div class="pane">
    {#if activeTab?.kind === 'home'}
      {#if activeTab.homeId === 'tasks'}
        {#if $can('todos')}<TaskPanel {sessionId} {tick} />{/if}
      {:else if activeTab.homeId === 'files'}
        <FilesPanel {sessionId} {tick} />
        <div class="gap"></div>
        {#if $can('worktrees')}<WorktreesPanel {sessionId} {tick} />{/if}
      {:else if activeTab.homeId === 'subs'}
        {#if $can('todos')}<SubagentsPanel {sessionId} {tick} />{/if}
      {:else if activeTab.homeId === 'skills'}
        {#if $can('skills')}<SkillsPanel {tick} />{/if}
      {:else if activeTab.homeId === 'schedules'}
        <SchedulesPanel {tick} />
      {:else if activeTab.homeId === 'mcp'}
        {#if $can('mcp')}<McpPanel {tick} />{/if}
      {:else if activeTab.homeId === 'remotes'}
        <RemotesPanel {tick} />
      {/if}
    {:else if activeTab?.kind === 'subagent'}
      <SubagentSessionTab childId={activeTab.childId} {tick} />
    {:else if activeTab?.kind === 'file'}
      <FileViewerTab directory={activeTab.directory} path={activeTab.path} />
    {:else if activeTab?.kind === 'tool'}
      <ToolOutputTab sessionId={activeTab.sessionId} messageId={activeTab.messageId} partId={activeTab.partId} {tick} />
    {:else if activeTab?.kind === 'git'}
      <GitTab {sessionId} {tick} />
    {:else if activeTab?.kind === 'sidechat'}
      <SideChatTab childId={activeTab.childId} {tick} />
    {:else}
      <div class="launcher">
        <p class="l-title">打开面板</p>
        <p class="l-desc">选择要在侧栏中打开的面板。</p>
        <div class="l-list">
          {#each HOMES as h (h.homeId)}
            <button class="l-card" on:click={() => openHome(h.homeId)}>
              <span class="l-ico" aria-hidden="true">
                {#if h.homeId === 'tasks'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>
                {:else if h.homeId === 'files'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></svg>
                {:else if h.homeId === 'subs'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
                {:else if h.homeId === 'skills'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/></svg>
                {:else if h.homeId === 'remotes'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/></svg>
                {:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                {/if}
              </span>
              <span class="l-text">
                {h.title}
                {#if h.homeId === 'tasks' && sum.total > 0}<span class="tbadge mono">{sum.done}/{sum.total}</span>{/if}
              </span>
            </button>
          {/each}
          <div class="l-sep"></div>
          <button class="l-card" disabled={sideChatBusy} on:click={openSideChat}>
            <span class="l-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
            <span class="l-text">辅助对话</span>
          </button>
          <div class="l-sep"></div>
          <button class="l-card" on:click={() => sidePane.openPaneTab({ id: 'git', kind: 'git', title: 'Git' })}>
            <span class="l-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M8 7c6 0 8 2 8 6v2.5"/></svg></span>
            <span class="l-text">Git</span>
          </button>
        </div>
      </div>
    {/if}
  </div>
</aside>

<style>
  .inspector {
    width: var(--insp-w, 380px);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    /* Elevated card surface — one tone above the chat canvas in dark, pure
       card white in light; the wrap's shadow carries the lift in light. */
    background: var(--bg-elev);
    border-left: none;
  }
  .collapse-btn {
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-left: 6px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    cursor: pointer;
  }
  .collapse-btn:hover { color: var(--text); background: var(--bg-input); }
  .collapse-btn svg { width: 14px; height: 14px; }

  /* Empty-pane launcher (ZCode openTabLauncher register): centered column of
     h-12 entry cards. */
  .launcher {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8vh 20px 0;
    text-align: center;
  }
  .l-title { margin: 0 0 4px; font-size: 14px; color: var(--text); }
  .l-desc { margin: 0 0 18px; font-size: 11.5px; color: var(--text-3); }
  .l-list { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 260px; }
  .l-card {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 46px;
    padding: 0 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: border-color .12s ease, color .12s ease;
    /* Entrance: rise + per-card stagger (Suggestions register). */
    animation: ocrc-rise 200ms var(--ease-out, ease-out) backwards;
  }
  .l-card:nth-child(1) { animation-delay: 30ms; }
  .l-card:nth-child(2) { animation-delay: 75ms; }
  .l-card:nth-child(3) { animation-delay: 120ms; }
  .l-card:nth-child(4) { animation-delay: 165ms; }
  .l-card:nth-child(5) { animation-delay: 210ms; }
  .l-card:nth-child(n+6) { animation-delay: 255ms; }
  .l-card:hover { border-color: var(--accent-line); color: var(--text); }
  .l-ico { display: inline-flex; flex-shrink: 0; color: var(--text-3); }
  .l-card:hover .l-ico { color: var(--accent); }
  .l-ico svg { width: 16px; height: 16px; }
  .l-text { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .l-sep { height: 1px; background: var(--border-2); margin: 4px 0; }

  /* Tabs: all dynamic, all closable, drag-reorderable; "+" menu at the end. */
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px 0 10px;
    border-bottom: 1px solid var(--border-2);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    /* ZCode register: uniform tab width, shrink to fit, never below 60px. */
    flex: 0 1 156px;
    min-width: 60px;
    padding: 9px 6px 8px;
    background: transparent;
    border: none;
    color: var(--text-3);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    flex-shrink: 0;
  }
  .tab:hover { color: var(--text-2); }
  .tab.active { color: var(--text); font-weight: 600; }
  .tab.active::after {
    content: '';
    position: absolute;
    left: 6px; right: 6px; bottom: -1px;
    height: 2px;
    background: var(--accent);
    border-radius: var(--radius-pill);
  }
  .tico { display: inline-flex; flex-shrink: 0; color: var(--text-3); }
  .tab.active .tico { color: var(--text); }
  .tab-ctx {
    position: fixed;
    z-index: 40;
    display: flex;
    flex-direction: column;
    min-width: 130px;
    padding: 4px;
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    box-shadow: 0 6px 20px rgb(0 0 0 / .18);
  }
  .tab-ctx button {
    background: transparent;
    border: none;
    text-align: left;
    padding: 6px 10px;
    font: inherit;
    font-size: 12px;
    color: var(--text-2);
    border-radius: var(--radius-xs, 4px);
    cursor: pointer;
  }
  .tab-ctx button:hover { background: var(--bg-input); color: var(--text); }
  .dlabel { max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
  .tbadge { font-size: 9.5px; color: var(--text-3); }
  .tab.active .tbadge { color: var(--text-2); }
  .closer {
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: var(--radius-xs);
    color: var(--text-4);
    font-size: 10px;
    line-height: 1;
  }
  .closer:hover { color: var(--text); background: var(--bg-input); }
  .tab.active .closer { color: var(--text-3); }

  .tabs-more {
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    font-size: 12px;
    cursor: pointer;
  }
  .tabs-more:hover { color: var(--text); background: var(--bg-input); }
  .tabs-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 6px;
    min-width: 110px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 14px 36px rgba(0, 0, 0, .25);
    padding: 4px;
    z-index: var(--z-popover);
    animation: ocrc-pop .14s var(--ease-out, ease-out);
  }
  .plus { position: relative; margin-left: auto; flex-shrink: 0; }
  .plus-btn {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .plus-btn:hover { color: var(--text); background: var(--bg-input); }
  .plus-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 130px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 14px 36px rgba(0, 0, 0, .25);
    padding: 4px;
    z-index: var(--z-popover);
    animation: ocrc-pop .14s var(--ease-out, ease-out);
  }
  .plus-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .plus-menu button:hover { background: var(--bg-input); color: var(--text); }
  .menu-sep { height: 1px; background: var(--border-2); margin: 4px 2px; }

  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 12px 14px 18px;
  }
  .gap { height: 14px; }

  /* Mobile bottom sheet: same tabs, per-tab scroll. */
  @media (max-width: 820px) {
    .inspector {
      width: 100%;
      height: 100%;
      display: block;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .pane { overflow: visible; }
  }
</style>
