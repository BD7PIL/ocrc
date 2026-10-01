<!-- Inspector.svelte — the right pane: ZCode workspaceSidePane register.
     NOTHING is pinned. Every tab is a closable dynamic page opened from
     context (PlanHud rows → subagents, transcript tool rows → outputs/files)
     or from the "+" menu listing the five well-known homes. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sessionList, feeds } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import { api } from '$lib/api/client.js'
  import {
    sidePane, closePaneTab, reorderPaneTab, openHome, HOMES,
  } from '$lib/stores/sidePane.js'
  import TaskPanel from './inspector/TaskPanel.svelte'
  import McpPanel from './inspector/McpPanel.svelte'
  import SchedulesPanel from './inspector/SchedulesPanel.svelte'
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
  $: title = session?.title

  // Debounced "activity tick": bump ~1s after the feed's lastSeq changes so
  // panels refetch when a turn produces output, without hammering per delta.
  let tick = 0
  let lastSeen = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  $: seq = sessionId ? ($feeds[sessionId]?.lastSeq ?? 0) : 0
  $: if (seq !== lastSeen) { lastSeen = seq; clearTimeout(timer); timer = setTimeout(() => (tick += 1), 1000) }
  onDestroy(() => clearTimeout(timer))

  $: activeId = $sidePane.activeId
  $: activeTab = $sidePane.tabs.find((t) => t.id === activeId)
  $: activeIndex = $sidePane.tabs.findIndex((t) => t.id === activeId)
  // Zero tabs = strip mode: the pane collapses to a 44px rail with just the
  // "+" affordance (otherwise the first tab would have no entry point).
  $: stripMode = $sidePane.tabs.length === 0
  let stripMenu = false

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
  function onWindowKey(e: KeyboardEvent) { if (e.key === 'Escape') plusOpen = false }

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

<aside class="inspector" class:strip={stripMode}>
  {#if stripMode}
    <div class="strip">
      <button class="strip-plus" title="打开面板" aria-label="打开面板" on:click={() => (stripMenu = !stripMenu)}>+</button>
      {#if stripMenu}
        <div class="strip-menu" role="menu">
          {#each HOMES as h (h.homeId)}
            <button role="menuitem" on:click={() => { openHome(h.homeId); stripMenu = false }}>
              {h.title}{#if homeBadge(h.homeId)}<span class="tbadge mono">{homeBadge(h.homeId)}</span>{/if}
            </button>
          {/each}
          <div class="menu-sep"></div>
          <button role="menuitem" on:click={() => { sidePane.openPaneTab({ id: 'git', kind: 'git', title: 'Git' }); stripMenu = false }}>Git</button>
        </div>
      {/if}
    </div>
  {:else}
  <div class="head">
    <div class="section-label">会话</div>
    <div class="name" title={title ?? sessionId}>
      <span class="title-text">{title || (sessionId ? '…' + sessionId.slice(-8) : 'No session')}</span>
    </div>
  </div>

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
      >
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
    <div class="plus" bind:this={plusEl}>
      <button class="plus-btn" aria-label="打开面板" title="打开面板" on:click={() => (plusOpen = !plusOpen)}>+</button>
      {#if plusOpen}
        <div class="plus-menu" role="menu">
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
      {:else if activeTab.homeId === 'config'}
        <SchedulesPanel {tick} />
        <div class="gap"></div>
        {#if $can('mcp')}<McpPanel {tick} />{/if}
      {/if}
    {:else if activeTab?.kind === 'subagent'}
      <SubagentSessionTab childId={activeTab.childId} {tick} />
    {:else if activeTab?.kind === 'file'}
      <FileViewerTab directory={activeTab.directory} path={activeTab.path} />
    {:else if activeTab?.kind === 'tool'}
      <ToolOutputTab sessionId={activeTab.sessionId} messageId={activeTab.messageId} partId={activeTab.partId} {tick} />
    {:else if activeTab?.kind === 'git'}
      <GitTab {sessionId} {tick} />
    {:else}
      <div class="empty">
        <p class="empty-title">没有打开的面板</p>
        <p class="empty-hint">从会话流（计划窗、工具行）或右上 + 打开——任务、文件、子代理、Skills、配置、Git。</p>
      </div>
    {/if}
  </div>
  {/if}
</aside>

<style>
  /* Strip mode: no tabs open — collapse to a rail with the "+" entry. */
  .inspector.strip { width: 44px; }
  .strip { display: flex; flex-direction: column; align-items: center; padding-top: 14px; position: relative; }
  .strip-plus {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    background: transparent;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .strip-plus:hover { color: var(--text); border-color: var(--border); }
  .strip-menu {
    position: absolute;
    top: 46px;
    left: 50px;
    min-width: 130px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 14px 36px rgba(0, 0, 0, .25);
    padding: 4px;
    z-index: var(--z-popover);
    animation: ocrc-pop .14s var(--ease-out, ease-out);
  }
  .strip-menu button {
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
  .strip-menu button:hover { background: var(--bg-input); color: var(--text); }
  .inspector {
    width: var(--insp-w, 380px);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    /* Same surface as the chat canvas: one white workspace between warm
       frame strips (titlebar/rail), not a third tone. */
    background: var(--bg-elev);
    border-left: 1px solid var(--border-2);
  }
  .head {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border-2);
  }
  .section-label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .name {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-weight: 600;
    font-size: 13px;
    color: var(--text);
  }
  .title-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

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
  .empty { padding: 8vh 16px 0; text-align: center; }
  .empty-title { margin: 0 0 6px; font-family: var(--font-serif); font-size: 14px; color: var(--text-3); }
  .empty-hint { margin: 0; font-size: 11.5px; line-height: 1.7; color: var(--text-4); }

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
