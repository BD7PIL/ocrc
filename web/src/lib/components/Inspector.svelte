<!-- src/lib/components/Inspector.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sessionList, feeds } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import { api } from '$lib/api/client.js'
  import TaskPanel from './inspector/TaskPanel.svelte'
  import McpPanel from './inspector/McpPanel.svelte'
  import SchedulesPanel from './inspector/SchedulesPanel.svelte'
  import SkillsPanel from './inspector/SkillsPanel.svelte'
  import FilesPanel from './inspector/FilesPanel.svelte'
  import WorktreesPanel from './inspector/WorktreesPanel.svelte'
  import ContextSpecPanel from './inspector/ContextSpecPanel.svelte'
  import WorkingDirPanel from './inspector/WorkingDirPanel.svelte'
  import SubagentsPanel from './inspector/SubagentsPanel.svelte'
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

  // ── Tabs (opencode-web 审查/上下文 pattern): one section per tab, full
  // pane height — replaces the stacked fold wall where FILES lived below
  // the SKILLS list. ──
  const TABS = [
    { id: 'tasks', label: '任务' },
    { id: 'subs', label: '子代理' },
    { id: 'context', label: '上下文' },
    { id: 'files', label: '文件' },
    { id: 'skills', label: 'Skills' },
    { id: 'config', label: '配置' },
  ] as const
  type TabId = (typeof TABS)[number]['id']
  let tab: TabId = 'tasks'

  // Task summary for the tab badge (done/total), same data plane as the HUD.
  let sum: TodoSummary = { total: 0, done: 0, items: [] }
  let loadedFor: string | undefined
  async function refresh(sid: string) {
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
</script>

<aside class="inspector">
  <div class="head">
    <div class="section-label">会话</div>
    <div class="name" title={title ?? sessionId}>
      <span class="title-text">{title || (sessionId ? '…' + sessionId.slice(-8) : 'No session')}</span>
    </div>
  </div>

  <div class="tabs" role="tablist">
    {#each TABS as t (t.id)}
      <button
        class="tab"
        class:active={tab === t.id}
        role="tab"
        aria-selected={tab === t.id}
        on:click={() => (tab = t.id)}
      >
        {t.label}{#if t.id === 'tasks' && sum.total > 0}<span class="tbadge mono">{sum.done}/{sum.total}</span>{/if}
      </button>
    {/each}
  </div>

  <div class="pane">
    {#if tab === 'tasks'}
      {#if $can('todos')}<TaskPanel {sessionId} {tick} />{/if}
    {:else if tab === 'subs'}
      {#if $can('todos')}<SubagentsPanel {sessionId} {tick} />{/if}
    {:else if tab === 'context'}
      <ContextSpecPanel {sessionId} {tick} />
    {:else if tab === 'files'}
      <FilesPanel {sessionId} {tick} />
      <div class="gap"></div>
      {#if $can('worktrees')}<WorktreesPanel {sessionId} {tick} />{/if}
    {:else if tab === 'skills'}
      {#if $can('skills')}<SkillsPanel {tick} />{/if}
    {:else if tab === 'config'}
      <SchedulesPanel {tick} />
      <div class="gap"></div>
      {#if $can('mcp')}<McpPanel {tick} />{/if}
    {/if}
  </div>
</aside>

<style>
  .inspector {
    width: var(--insp-w, 280px);
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

  /* Tabs: quiet text tabs, active gets ink + a short accent underline. */
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border-2);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    position: relative;
    padding: 9px 8px 8px;
    background: transparent;
    border: none;
    color: var(--text-3);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  .tab:hover { color: var(--text-2); }
  .tab.active { color: var(--text); font-weight: 600; }
  .tab.active::after {
    content: '';
    position: absolute;
    left: 8px; right: 8px; bottom: -1px;
    height: 2px;
    background: var(--accent);
    border-radius: var(--radius-pill);
  }
  .tbadge { margin-left: 4px; font-size: 9.5px; color: var(--text-3); }
  .tab.active .tbadge { color: var(--text-2); }

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
